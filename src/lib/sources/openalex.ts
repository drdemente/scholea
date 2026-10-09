/**
 * OpenAlex — CORS-friendly. Free; a BYO key (or mailto) raises limits. Honours
 * X-RateLimit-* and distinguishes 429 throttling from daily-credit exhaustion
 * (see http.ts / RateLimitError.exhausted). Docs: https://docs.openalex.org
 */
import { fetchJson, q } from "./http";
import { wantedResults, SourceError } from "./types";
import type { LiteratureSource, SearchOptions, SearchResult, WorkRecord } from "./types";

interface OpenAlexWork {
  id?: string;
  doi?: string;
  title?: string;
  display_name?: string;
  publication_year?: number;
  authorships?: { author?: { display_name?: string } }[];
  primary_location?: { source?: { display_name?: string } };
  open_access?: { oa_url?: string | null };
  abstract_inverted_index?: Record<string, number[]>;
}
interface OpenAlexResponse {
  meta?: { count?: number };
  results?: OpenAlexWork[];
}

/** Rebuild plain abstract text from OpenAlex's inverted index. */
export function reconstructAbstract(index?: Record<string, number[]>): string | undefined {
  if (!index) return undefined;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const p of positions) words[p] = word;
  }
  const text = words.filter((w) => w != null).join(" ").trim();
  return text || undefined;
}

/** Pure normaliser — unit-tested against a captured fixture. */
export function normalizeOpenAlex(json: OpenAlexResponse): SearchResult {
  const records: WorkRecord[] = (json.results ?? []).map((w) => ({
    id: `openalex:${(w.id ?? "").replace("https://openalex.org/", "")}`,
    source: "openalex",
    title: w.title ?? w.display_name ?? "(untitled)",
    authors: (w.authorships ?? []).map((a) => a.author?.display_name ?? "").filter(Boolean),
    year: w.publication_year,
    journal: w.primary_location?.source?.display_name,
    doi: w.doi?.replace(/^https?:\/\/doi\.org\//, ""),
    abstract: reconstructAbstract(w.abstract_inverted_index),
    url: w.doi ?? undefined,
    oaUrl: w.open_access?.oa_url ?? undefined,
  }));
  return { source: "openalex", total: json.meta?.count ?? records.length, records };
}

/** One request in OpenAlex's page-number paging. */
export interface OpenAlexPage {
  page: number;
  perPage: number;
}

const MAX_PER_PAGE = 100;

/**
 * Plan the page requests for the first `want` works. Exported for tests.
 *
 * Every request uses the SAME page size. OpenAlex counts pages in units of
 * `per_page`, so page N starts at record (N - 1) × per_page: asking for a
 * smaller last page (100, 100, then 50 for 250 results) returns records 101-150
 * a second time and never reaches 201-250.
 *
 * A request costs the same against OpenAlex's daily allowance whatever its size,
 * so a multi-page plan uses full pages of 100 and the caller trims the spare
 * records: that never takes more requests than a smaller page would.
 */
export function openAlexPages(want: number): OpenAlexPage[] {
  const n = Number.isFinite(want) ? Math.max(1, Math.floor(want)) : 1;
  const perPage = Math.min(n, MAX_PER_PAGE);
  const pages = Math.ceil(n / perPage);
  return Array.from({ length: pages }, (_, i) => ({ page: i + 1, perPage }));
}

/**
 * Run a page plan against `fetchPage` and collect the first `want` records.
 * Stops early when a page comes back short or the reported total is reached.
 * The total is never reported lower than the number of records fetched.
 * Exported for tests.
 */
export async function collectOpenAlex(
  want: number,
  fetchPage: (request: OpenAlexPage) => Promise<SearchResult>,
): Promise<{ total: number; records: WorkRecord[] }> {
  const records: WorkRecord[] = [];
  let total = 0;
  for (const request of openAlexPages(want)) {
    const batch = await fetchPage(request);
    total = batch.total;
    records.push(...batch.records);
    if (batch.records.length < request.perPage) break;
    if (records.length >= total) break;
  }
  return { total: Math.max(total, records.length), records: records.slice(0, want) };
}

export const openAlexSource: LiteratureSource = {
  id: "openalex",
  label: "OpenAlex",
  requiresKey: false,
  corsSafe: true,
  note: "Free. Add an API key or your email to raise rate limits.",
  async search(query, opts: SearchOptions) {
    const want = wantedResults(opts);
    const auth = opts.apiKey ? `&api_key=${q(opts.apiKey)}` : opts.email ? `&mailto=${q(opts.email)}` : "";
    const filter = openAlexFilter(opts);
    let records: WorkRecord[] = [];
    let total = 0;
    try {
      ({ total, records } = await collectOpenAlex(want, async ({ page, perPage }) => {
        const url = `https://api.openalex.org/works?search=${q(query)}&per_page=${perPage}&page=${page}${filter}${auth}`;
        return normalizeOpenAlex(await fetchJson<OpenAlexResponse>(url, "openalex", opts.signal));
      }));
    } catch (e) {
      // OpenAlex increasingly throttles anonymous traffic (400/403/429/503 with
      // "use an API key"). Point the user at the fix instead of a raw status.
      const msg = e instanceof Error ? e.message : "";
      if (!opts.apiKey && /api.?key|anonymous|temporarily unavailable|HTTP (4\d\d|5\d\d)/i.test(msg)) {
        throw new SourceError(
          "openalex",
          "OpenAlex is limiting anonymous requests. Add your email or a free OpenAlex API key in Settings → Literature sources for reliable access.",
        );
      }
      throw e;
    }
    return {
      source: "openalex" as const,
      total,
      records,
      note: opts.articleType === "rct" ? "OpenAlex can't filter to RCTs specifically — type filter not applied." : undefined,
    };
  },
};

/** Pure filter builder for OpenAlex works queries. Exported for tests. */
export function openAlexFilter(opts: SearchOptions): string {
  const parts: string[] = [];
  if (opts.yearFrom) parts.push(`from_publication_date:${opts.yearFrom}-01-01`);
  if (opts.yearTo) parts.push(`to_publication_date:${opts.yearTo}-12-31`);
  if (opts.openAccessOnly) parts.push("is_oa:true");
  if (opts.articleType === "review") parts.push("type:review");
  return parts.length ? `&filter=${parts.join(",")}` : "";
}

// --- Publication-volume scoping (feasibility & saturation) -------------------

interface OpenAlexGroupResponse {
  meta?: { count?: number };
  group_by?: { key?: string; key_display_name?: string; count?: number }[];
}

export interface YearVolume {
  year: number;
  count: number;
}
export interface VolumeResult {
  total: number;
  byYear: YearVolume[];
}

/** Pure normaliser for an OpenAlex `group_by=publication_year` response. */
export function normalizeVolume(json: OpenAlexGroupResponse): VolumeResult {
  const byYear: YearVolume[] = (json.group_by ?? [])
    .map((g) => ({ year: Number(g.key), count: g.count ?? 0 }))
    .filter((g) => Number.isFinite(g.year) && g.year > 1900)
    .sort((a, b) => a.year - b.year);
  return {
    total: json.meta?.count ?? byYear.reduce((sum, g) => sum + g.count, 0),
    byYear,
  };
}

/**
 * Yearly publication counts for a query — a fast scoping signal for whether a
 * review is feasible (enough evidence) and whether the field is still growing.
 * CORS-friendly; no key required (a key/email raises limits).
 */
export async function openAlexYearlyVolume(query: string, opts: SearchOptions): Promise<VolumeResult> {
  const auth = opts.apiKey ? `&api_key=${q(opts.apiKey)}` : opts.email ? `&mailto=${q(opts.email)}` : "";
  const url = `https://api.openalex.org/works?search=${q(query)}&group_by=publication_year${auth}`;
  const json = await fetchJson<OpenAlexGroupResponse>(url, "openalex", opts.signal);
  return normalizeVolume(json);
}
