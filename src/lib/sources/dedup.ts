/**
 * Deduplicate records across sources. DOI is the strong key; a normalised
 * title+year is the fallback. We index by BOTH so a DOI-bearing record and a
 * DOI-less record of the same study still merge. First occurrence wins, but
 * useful fields (DOI, abstract, OA link) are merged in from later duplicates.
 */
import type { WorkRecord } from "./types";

export interface DedupResult {
  unique: WorkRecord[];
  duplicatesRemoved: number;
}

function normalizeTitle(title: string): string {
  // NFKD splits accented letters into base + combining mark; the [^a-z0-9]
  // pass then drops the marks (and punctuation/whitespace runs).
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function doiKey(r: WorkRecord): string | undefined {
  if (!r.doi) return undefined;
  return r.doi.toLowerCase().replace(/^https?:\/\/doi\.org\//, "");
}

function titleKey(r: WorkRecord): string | undefined {
  const t = normalizeTitle(r.title);
  return t ? `${t}|${r.year ?? ""}` : undefined;
}

function merge(into: WorkRecord, from: WorkRecord): WorkRecord {
  return {
    ...into,
    doi: into.doi ?? from.doi,
    abstract: into.abstract ?? from.abstract,
    oaUrl: into.oaUrl ?? from.oaUrl,
    journal: into.journal ?? from.journal,
    year: into.year ?? from.year,
  };
}

export function dedupeRecords(records: WorkRecord[]): DedupResult {
  const clusters: WorkRecord[] = [];
  const byDoi = new Map<string, number>();
  const byTitle = new Map<string, number>();
  let duplicatesRemoved = 0;

  for (const rec of records) {
    const dk = doiKey(rec);
    const tk = titleKey(rec);

    // DOI is authoritative. Use a title match only when it doesn't contradict
    // a DOI: two records with different DOIs are different studies, full stop.
    let existingIdx: number | undefined;
    if (dk !== undefined && byDoi.has(dk)) {
      existingIdx = byDoi.get(dk);
    } else if (tk !== undefined && byTitle.has(tk)) {
      const candidate = byTitle.get(tk)!;
      const candidateDoi = doiKey(clusters[candidate]);
      const doiConflict = dk !== undefined && candidateDoi !== undefined && dk !== candidateDoi;
      if (!doiConflict) existingIdx = candidate;
    }

    let idx: number;
    if (existingIdx !== undefined) {
      clusters[existingIdx] = merge(clusters[existingIdx], rec);
      duplicatesRemoved++;
      idx = existingIdx;
    } else {
      idx = clusters.length;
      clusters.push(rec);
    }
    // Register both keys → this cluster, so future records match on either.
    if (dk !== undefined) byDoi.set(dk, idx);
    if (tk !== undefined) byTitle.set(tk, idx);
  }

  return { unique: clusters, duplicatesRemoved };
}
