/**
 * Europe PMC — no key, CORS-friendly. A PubMed superset that also covers
 * preprints and open-access full text, so it's Scholea's sensible default.
 * REST docs: https://europepmc.org/RestfulWebService
 */
import { fetchJson, q } from "./http";
import { wantedResults } from "./types";
import type { LiteratureSource, SearchOptions, SearchResult, WorkRecord } from "./types";

interface EpmcResult {
  id?: string;
  source?: string;
  title?: string;
  authorString?: string;
  pubYear?: string;
  journalTitle?: string;
  doi?: string;
  abstractText?: string;
  fullTextUrlList?: { fullTextUrl?: { url?: string; documentStyle?: string }[] };
}
interface EpmcResponse {
  hitCount?: number;
  nextCursorMark?: string;
  resultList?: { result?: EpmcResult[] };
}

/**
 * Pure query builder — folds the requested filters into Europe PMC's own query
 * syntax (all filters supported natively). Exported for unit tests.
 */
export function epmcQuery(query: string, opts: SearchOptions): string {
  const clauses: string[] = [`(${query.trim()})`];
  if (opts.yearFrom || opts.yearTo) {
    clauses.push(`(PUB_YEAR:[${opts.yearFrom ?? 1800} TO ${opts.yearTo ?? new Date().getFullYear()}])`);
  }
  if (opts.openAccessOnly) clauses.push("(OPEN_ACCESS:y)");
  if (opts.articleType === "rct") clauses.push(`(PUB_TYPE:"randomized controlled trial")`);
  if (opts.articleType === "review") clauses.push(`(PUB_TYPE:"review")`);
  return clauses.length > 1 ? clauses.join(" AND ") : query.trim();
}

/** Pure normaliser — unit-tested against a captured fixture. */
export function normalizeEuropePmc(json: EpmcResponse): SearchResult {
  const results = json.resultList?.result ?? [];
  const records: WorkRecord[] = results.map((r) => {
    const oa = r.fullTextUrlList?.fullTextUrl?.find((u) => u.documentStyle === "html")?.url;
    return {
      id: `europepmc:${r.source ?? "MED"}/${r.id ?? ""}`,
      source: "europepmc",
      title: r.title?.replace(/\.$/, "") ?? "(untitled)",
      authors: r.authorString ? r.authorString.replace(/\.$/, "").split(/,\s*/) : [],
      year: r.pubYear ? Number(r.pubYear) : undefined,
      journal: r.journalTitle || undefined,
      doi: r.doi || undefined,
      abstract: r.abstractText || undefined,
      url: r.doi ? `https://doi.org/${r.doi}` : undefined,
      oaUrl: oa,
    };
  });
  return { source: "europepmc", total: json.hitCount ?? records.length, records };
}

export const europePmcSource: LiteratureSource = {
  id: "europepmc",
  label: "Europe PMC",
  requiresKey: false,
  corsSafe: true,
  note: "No key needed. PubMed superset + preprints + open-access full text.",
  async search(query, opts: SearchOptions) {
    const want = wantedResults(opts);
    const full = epmcQuery(query, opts);
    const records: WorkRecord[] = [];
    let total = 0;
    let cursor = "*";
    // Cursor-based paging (Europe PMC caps pageSize at 1000; we use ≤100 pages).
    while (records.length < want) {
      const pageSize = Math.min(100, want - records.length);
      const url =
        `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${q(full)}` +
        `&format=json&resultType=core&pageSize=${pageSize}&cursorMark=${q(cursor)}`;
      const json = await fetchJson<EpmcResponse>(url, "europepmc", opts.signal);
      const page = normalizeEuropePmc(json);
      total = page.total;
      if (page.records.length === 0) break;
      records.push(...page.records);
      if (!json.nextCursorMark || json.nextCursorMark === cursor) break;
      cursor = json.nextCursorMark;
    }
    return { source: "europepmc" as const, total, records: records.slice(0, want) };
  },
};
