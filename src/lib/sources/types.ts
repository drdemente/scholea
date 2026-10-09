/**
 * Literature data backbone — unified source interface.
 *
 * Free + BYO-key only. CORS-friendly sources (Europe PMC, Crossref, OpenAlex,
 * Unpaywall, DOAJ) are called directly; PubMed E-utilities is not CORS-enabled
 * and is routed through the platform adapter (Tauri HTTP client on desktop, a
 * thin Worker proxy on web — §1/§4). We never call Google Scholar/Scopus/WoS.
 */

export type SearchSourceId = "europepmc" | "crossref" | "openalex" | "pubmed" | "clinicaltrials";
export type EnrichSourceId = "unpaywall" | "doaj";
export type SourceId = SearchSourceId | EnrichSourceId;

/**
 * Databases with NO free public search API (subscription or portal-only).
 * They can't be searched live; instead the user searches them externally,
 * exports RIS, and imports the file — records are attributed to the source so
 * PRISMA counts and the documented search strategy stay honest.
 */
export type ManualSourceId = "embase" | "cochrane-central" | "who-ictrp" | "conference" | "other";

export interface ManualSource {
  id: ManualSourceId;
  label: string;
  /** Why it can't be searched live + how to get records out of it. */
  note: string;
}

export const MANUAL_SOURCES: Record<ManualSourceId, ManualSource> = {
  embase: {
    id: "embase",
    label: "Embase",
    note: "Subscription database (Elsevier), no free API. Search via your institution (Ovid/Embase.com), export RIS, import here.",
  },
  "cochrane-central": {
    id: "cochrane-central",
    label: "Cochrane CENTRAL",
    note: "No public API. Search the Cochrane Library, export the results as RIS, import here.",
  },
  "who-ictrp": {
    id: "who-ictrp",
    label: "WHO ICTRP",
    note: "Trial registry portal, no search API. Search trialsearch.who.int, export, convert to RIS (e.g. via a reference manager), import here.",
  },
  conference: {
    id: "conference",
    label: "Conference abstracts",
    note: "e.g. AACAP or APA annual-meeting abstracts. Collect citations in a reference manager, export RIS, import here.",
  },
  other: {
    id: "other",
    label: "Other source",
    note: "Any other database or hand-searched source, imported from an RIS export.",
  },
};

/** A normalised bibliographic record, source-agnostic. */
export interface WorkRecord {
  /** Stable id, `${source}:${nativeId}`. */
  id: string;
  source: SearchSourceId | ManualSourceId | "demo";
  title: string;
  authors: string[];
  year?: number;
  journal?: string;
  doi?: string;
  abstract?: string;
  url?: string;
  /** Open-access full-text URL, if known (from the source or Unpaywall). */
  oaUrl?: string;
}

export interface SearchResult {
  source: SearchSourceId;
  total: number;
  records: WorkRecord[];
  /** Human note, e.g. which requested filters this source can't honour. */
  note?: string;
}

/** Publication-type filter (applied only where the API supports it). */
export type ArticleTypeFilter = "any" | "rct" | "review";

/** Safety ceiling for "All results" so free APIs aren't hammered. */
export const MAX_RESULTS_CAP = 1000;

export interface SearchOptions {
  pageSize?: number;
  /**
   * Total records wanted from this source (paging loops until reached or the
   * source is exhausted). Capped at MAX_RESULTS_CAP. Falls back to pageSize.
   */
  maxResults?: number;
  /** Restrict by publication year (inclusive). */
  yearFrom?: number;
  yearTo?: number;
  /** Only open-access works (where the API supports it). */
  openAccessOnly?: boolean;
  articleType?: ArticleTypeFilter;
  /** Contact email: the "polite pool" of Crossref and OpenAlex, and PubMed's `email` parameter. */
  email?: string;
  /** BYO API key (NCBI for PubMed, OpenAlex key). */
  apiKey?: string;
  /** Proxy base URL for non-CORS sources (PubMed on the web build). */
  proxyBase?: string;
  signal?: AbortSignal;
}

/** Resolve how many records the caller wants, capped for API safety. */
export function wantedResults(opts: SearchOptions, fallback = 25): number {
  const asked = opts.maxResults ?? opts.pageSize ?? fallback;
  // A limit that is not a number (a corrupt saved setting) would otherwise make
  // every adapter's paging loop run zero times and return nothing, silently.
  const want = Number.isNaN(asked) ? fallback : asked;
  return Math.max(1, Math.min(want, MAX_RESULTS_CAP));
}

export interface LiteratureSource {
  id: SearchSourceId;
  label: string;
  /** Whether a BYO key is required to function (vs optional/none). */
  requiresKey: boolean;
  /** False when the browser can't call it directly (needs the proxy). */
  corsSafe: boolean;
  /** Free-text note shown in Settings. */
  note: string;
  search(query: string, opts: SearchOptions): Promise<SearchResult>;
}

/** Raised on HTTP 429 so the caller/limiter can back off. */
export class RateLimitError extends Error {
  constructor(
    public readonly source: string,
    public readonly retryAfterMs?: number,
    /** True when the failure is credit/quota exhaustion, not transient throttling. */
    public readonly exhausted = false,
  ) {
    super(`${source}: rate limited${exhausted ? " (quota exhausted)" : ""}`);
    this.name = "RateLimitError";
  }
}

export class SourceError extends Error {
  constructor(public readonly source: string, message: string) {
    super(`${source}: ${message}`);
    this.name = "SourceError";
  }
}
