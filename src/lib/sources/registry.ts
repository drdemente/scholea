/**
 * Source registry — owns a rate limiter per source and runs a multi-source
 * search, merging + deduplicating the results. Per-source failures are isolated
 * (one source down doesn't sink the search).
 */
import { RateLimiter } from "./rate-limit";
import { europePmcSource } from "./europepmc";
import { crossrefSource } from "./crossref";
import { openAlexSource } from "./openalex";
import { pubmedSource } from "./pubmed";
import { clinicalTrialsSource } from "./clinicaltrials";
import { target } from "@/lib/platform";
import { RateLimitError, SourceError } from "./types";
import type { LiteratureSource, SearchOptions, SearchSourceId, WorkRecord } from "./types";

export const SOURCES: Record<SearchSourceId, LiteratureSource> = {
  europepmc: europePmcSource,
  crossref: crossrefSource,
  openalex: openAlexSource,
  pubmed: pubmedSource,
  clinicaltrials: clinicalTrialsSource,
};

export const SEARCH_SOURCES: LiteratureSource[] = Object.values(SOURCES);

// Per-source limiters tuned to each service's free allowance.
const limiters: Record<SearchSourceId, RateLimiter> = {
  europepmc: new RateLimiter({ maxConcurrent: 3 }),
  crossref: new RateLimiter({ maxConcurrent: 5 }),
  openalex: new RateLimiter({ maxConcurrent: 4, minIntervalMs: 100 }),
  pubmed: new RateLimiter({ maxConcurrent: 1, minIntervalMs: 350 }), // ~3 req/s without a key
  clinicaltrials: new RateLimiter({ maxConcurrent: 2, minIntervalMs: 150 }), // ~50 req/min per IP
};

/** A non-CORS source is only usable directly on desktop, or via a proxy on web. */
export function isSourceUsable(s: LiteratureSource, hasProxy = false): boolean {
  return s.corsSafe || target === "tauri" || (s.id === "pubmed" && hasProxy);
}

export interface SourceOutcome {
  id: SearchSourceId;
  label: string;
  total: number;
  count: number;
  error?: string;
  /** e.g. a requested filter this source can't honour. */
  note?: string;
}

export interface MultiSearchOutcome {
  /** Raw combined records across sources (NOT deduplicated — the dedup step
   *  owns that, so the PRISMA flow stays internally consistent). */
  records: WorkRecord[];
  perSource: SourceOutcome[];
}

function humanError(reason: unknown): string {
  if (reason instanceof RateLimitError) {
    return reason.exhausted ? "Daily quota exhausted" : "Rate limited — try again shortly";
  }
  if (reason instanceof SourceError) return reason.message;
  return reason instanceof Error ? reason.message : "Unknown error";
}

export async function searchSources(
  query: string,
  sources: SearchSourceId[],
  optionsFor: (id: SearchSourceId) => SearchOptions,
): Promise<MultiSearchOutcome> {
  const settled = await Promise.allSettled(
    sources.map((id) => limiters[id].schedule(() => SOURCES[id].search(query, optionsFor(id)))),
  );

  const all: WorkRecord[] = [];
  const perSource: SourceOutcome[] = sources.map((id, i) => {
    const r = settled[i];
    if (r.status === "fulfilled") {
      all.push(...r.value.records);
      return { id, label: SOURCES[id].label, total: r.value.total, count: r.value.records.length, note: r.value.note };
    }
    return { id, label: SOURCES[id].label, total: 0, count: 0, error: humanError(r.reason) };
  });

  return { records: all, perSource };
}
