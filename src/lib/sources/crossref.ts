/**
 * Crossref — no key, CORS-friendly. DOI metadata and reference lists. We use
 * the "polite pool" by passing the user's contact email (mailto).
 * Docs: https://api.crossref.org
 */
import { fetchJson, q } from "./http";
import { wantedResults } from "./types";
import type { LiteratureSource, SearchOptions, SearchResult, WorkRecord } from "./types";

interface CrossrefItem {
  DOI?: string;
  title?: string[];
  author?: { given?: string; family?: string; name?: string }[];
  "container-title"?: string[];
  issued?: { "date-parts"?: number[][] };
  abstract?: string;
  URL?: string;
}
interface CrossrefResponse {
  message?: { "total-results"?: number; items?: CrossrefItem[] };
}

function authorName(a: NonNullable<CrossrefItem["author"]>[number]): string {
  if (a.name) return a.name;
  return [a.given, a.family].filter(Boolean).join(" ").trim();
}

/** Pure normaliser — unit-tested against a captured fixture. */
export function normalizeCrossref(json: CrossrefResponse): SearchResult {
  const items = json.message?.items ?? [];
  const records: WorkRecord[] = items.map((it) => ({
    id: `crossref:${it.DOI ?? ""}`,
    source: "crossref",
    title: it.title?.[0] ?? "(untitled)",
    authors: (it.author ?? []).map(authorName).filter(Boolean),
    year: it.issued?.["date-parts"]?.[0]?.[0],
    journal: it["container-title"]?.[0],
    doi: it.DOI,
    // Crossref abstracts are JATS XML — strip tags for a plain summary.
    abstract: it.abstract?.replace(/<[^>]+>/g, "").trim() || undefined,
    url: it.URL ?? (it.DOI ? `https://doi.org/${it.DOI}` : undefined),
  }));
  return { source: "crossref", total: json.message?.["total-results"] ?? records.length, records };
}

export const crossrefSource: LiteratureSource = {
  id: "crossref",
  label: "Crossref",
  requiresKey: false,
  corsSafe: true,
  note: "No key needed. DOI metadata; add your email to use the faster polite pool.",
  async search(query, opts: SearchOptions) {
    const want = wantedResults(opts);
    const mailto = opts.email ? `&mailto=${q(opts.email)}` : "";
    const filter = crossrefFilter(opts);
    const records: WorkRecord[] = [];
    let total = 0;
    // Offset paging (rows ≤ 1000; deep paging capped well below Crossref's 10k).
    while (records.length < want) {
      const rows = Math.min(100, want - records.length);
      const url = `https://api.crossref.org/works?query=${q(query)}&rows=${rows}&offset=${records.length}${filter}${mailto}`;
      const json = await fetchJson<CrossrefResponse>(url, "crossref", opts.signal);
      const page = normalizeCrossref(json);
      total = page.total;
      if (page.records.length === 0) break;
      records.push(...page.records);
      if (records.length >= total) break;
    }
    const skipped: string[] = [];
    if (opts.openAccessOnly) skipped.push("open-access");
    if (opts.articleType && opts.articleType !== "any") skipped.push("article-type");
    return {
      source: "crossref" as const,
      total,
      records: records.slice(0, want),
      note: skipped.length ? `Crossref doesn't support the ${skipped.join(" or ")} filter — not applied here.` : undefined,
    };
  },
};

/** Pure filter builder (dates only — Crossref has no OA/publication-type facet). Exported for tests. */
export function crossrefFilter(opts: SearchOptions): string {
  const parts: string[] = [];
  if (opts.yearFrom) parts.push(`from-pub-date:${opts.yearFrom}-01-01`);
  if (opts.yearTo) parts.push(`until-pub-date:${opts.yearTo}-12-31`);
  return parts.length ? `&filter=${parts.join(",")}` : "";
}
