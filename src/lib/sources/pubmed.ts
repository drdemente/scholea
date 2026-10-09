/**
 * PubMed E-utilities — medical primary literature. BYO NCBI key (3→10 req/s).
 * NOT CORS-enabled, so requests go through the platform adapter (Tauri HTTP
 * client on desktop; a thin Worker proxy on web — §1/§4). esearch → esummary.
 * Docs: https://www.ncbi.nlm.nih.gov/books/NBK25501/
 */
import { platform } from "@/lib/platform";
import { q } from "./http";
import { SourceError, wantedResults } from "./types";
import type { LiteratureSource, SearchOptions, SearchResult, WorkRecord } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pure term builder — folds filters into PubMed's own search syntax. Exported for tests. */
export function pubmedTerm(query: string, opts: SearchOptions): string {
  const clauses: string[] = [`(${query.trim()})`];
  if (opts.articleType === "rct") clauses.push("randomized controlled trial[pt]");
  if (opts.articleType === "review") clauses.push("review[pt]");
  if (opts.openAccessOnly) clauses.push("free full text[sb]");
  return clauses.length > 1 ? clauses.join(" AND ") : query.trim();
}

/** Pure date-range params (esearch datetype=pdat). Exported for tests. */
export function pubmedDates(opts: SearchOptions): string {
  if (!opts.yearFrom && !opts.yearTo) return "";
  const from = opts.yearFrom ?? 1800;
  const to = opts.yearTo ?? new Date().getFullYear();
  return `&datetype=pdat&mindate=${from}&maxdate=${to}`;
}

interface ESummaryDoc {
  uid?: string;
  title?: string;
  authors?: { name?: string }[];
  pubdate?: string;
  source?: string;
  articleids?: { idtype?: string; value?: string }[];
}
interface ESummaryResponse {
  // `uids` is string[]; every other key is a uid → doc. Modelled loosely to
  // avoid an impossible index-signature intersection.
  result?: { uids?: string[] } & Record<string, unknown>;
}

/** Pure normaliser — unit-tested against a captured fixture. */
export function normalizePubmed(json: ESummaryResponse): SearchResult {
  const result = json.result;
  const uids = result?.uids ?? [];
  const records: WorkRecord[] = uids.map((uid) => {
    const d = (result?.[uid] as ESummaryDoc | undefined) ?? {};
    const doi = d.articleids?.find((a) => a.idtype === "doi")?.value;
    const yearMatch = d.pubdate?.match(/\d{4}/);
    return {
      id: `pubmed:${uid}`,
      source: "pubmed",
      title: d.title?.replace(/\.$/, "") ?? "(untitled)",
      authors: (d.authors ?? []).map((a) => a.name ?? "").filter(Boolean),
      year: yearMatch ? Number(yearMatch[0]) : undefined,
      journal: d.source,
      doi,
      url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
    };
  });
  return { source: "pubmed", total: records.length, records };
}

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

/**
 * PubMed isn't CORS-enabled, so the web build routes E-utilities through a thin
 * same-origin proxy (see proxy/pubmed-worker.js). A proxy base of
 * `https://p.example.com` forwards `/entrez/eutils/*` to NCBI. On desktop the
 * Tauri HTTP client bypasses CORS, so no proxy is needed.
 */
function eutilsBase(opts: SearchOptions): string {
  return opts.proxyBase ? `${opts.proxyBase.replace(/\/$/, "")}/entrez/eutils` : EUTILS;
}

export const pubmedSource: LiteratureSource = {
  id: "pubmed",
  label: "PubMed",
  requiresKey: false,
  corsSafe: false,
  note: "Add a free NCBI key for higher limits. On the web build this needs the proxy; on desktop it works directly.",
  async search(query, opts: SearchOptions) {
    const want = wantedResults(opts);
    const key = opts.apiKey ? `&api_key=${q(opts.apiKey)}` : "";
    const tool = `&tool=scholea${opts.email ? `&email=${q(opts.email)}` : ""}`;
    const base = eutilsBase(opts);
    // NCBI allows ~3 req/s without a key, ~10 with — pace multi-page loops.
    const pace = opts.apiKey ? 120 : 350;
    const term = pubmedTerm(query, opts);
    const dates = pubmedDates(opts);

    // esearch pages of ids until we have enough (or the result set ends).
    const ids: string[] = [];
    let total = 0;
    while (ids.length < want) {
      const retmax = Math.min(100, want - ids.length);
      const esearchUrl =
        `${base}/esearch.fcgi?db=pubmed&retmode=json&retmax=${retmax}&retstart=${ids.length}` +
        `&term=${q(term)}${dates}${key}${tool}`;
      if (ids.length > 0) await sleep(pace);
      const esearch = await platform.http(esearchUrl, { signal: opts.signal });
      if (!esearch.ok) throw new SourceError("pubmed", `esearch HTTP ${esearch.status}`);
      const body = await esearch.json<{ esearchresult?: { idlist?: string[]; count?: string } }>();
      const page = body.esearchresult?.idlist ?? [];
      total = Number(body.esearchresult?.count ?? page.length) || page.length;
      if (page.length === 0) break;
      ids.push(...page);
      if (ids.length >= total) break;
    }
    if (ids.length === 0) return { source: "pubmed", total: 0, records: [] };

    // esummary in chunks (keeps URLs short and inside rate limits).
    const records: WorkRecord[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      await sleep(pace);
      const esummaryUrl = `${base}/esummary.fcgi?db=pubmed&retmode=json&id=${chunk.join(",")}${key}${tool}`;
      const esummary = await platform.http(esummaryUrl, { signal: opts.signal });
      if (!esummary.ok) throw new SourceError("pubmed", `esummary HTTP ${esummary.status}`);
      records.push(...normalizePubmed(await esummary.json<ESummaryResponse>()).records);
    }
    return { source: "pubmed" as const, total, records: records.slice(0, want) };
  },
};
