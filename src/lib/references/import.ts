/**
 * Reference import — RIS parser for records exported from databases Scholea
 * can't search live (Embase, Cochrane CENTRAL, WHO ICTRP exports, conference
 * abstracts, …). Pure string → WorkRecord[] so it's trivially testable and runs
 * offline. Tolerates the common RIS dialects: `TAG  - value` lines, un-tagged
 * continuation lines, CRLF endings, and the TI/T1, JO/JF/T2, PY/Y1 synonyms.
 */
import type { ManualSourceId, WorkRecord } from "@/lib/sources/types";

interface RisEntry {
  tags: Record<string, string[]>;
}

/** Split raw RIS text into entries (records end at `ER  -`). */
function splitEntries(text: string): RisEntry[] {
  const entries: RisEntry[] = [];
  let cur: RisEntry | null = null;
  let lastTag: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^([A-Z][A-Z0-9])\s{0,2}-\s?(.*)$/);
    if (m) {
      const [, tag, value] = m;
      if (tag === "TY") {
        cur = { tags: {} };
        lastTag = null;
      }
      if (!cur) continue;
      if (tag === "ER") {
        entries.push(cur);
        cur = null;
        lastTag = null;
        continue;
      }
      (cur.tags[tag] ??= []).push(value.trim());
      lastTag = tag;
    } else if (cur && lastTag && raw.trim()) {
      // Un-tagged continuation line — append to the previous tag's last value.
      const vals = cur.tags[lastTag];
      vals[vals.length - 1] = `${vals[vals.length - 1]} ${raw.trim()}`;
    }
  }
  // A final entry missing its ER line is still salvaged.
  if (cur && Object.keys(cur.tags).length > 0) entries.push(cur);
  return entries;
}

function first(e: RisEntry, ...tags: string[]): string | undefined {
  for (const t of tags) {
    const v = e.tags[t]?.[0];
    if (v) return v;
  }
  return undefined;
}

/** Tiny stable hash (djb2) so import ids are content-derived — re-importing the
 *  same file yields the same ids instead of duplicates. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Parse an RIS export into WorkRecords attributed to `source`. Entries without
 * a title are dropped (they can't be screened). Ids are DOI-based when a DOI is
 * present (so cross-source deduplication works), else a hash of title+year.
 */
export function parseRis(text: string, source: ManualSourceId): WorkRecord[] {
  return splitEntries(text)
    .map((e): WorkRecord | null => {
      const title = first(e, "TI", "T1")?.replace(/\.$/, "");
      if (!title) return null;
      const doi = first(e, "DO")?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "") || undefined;
      const yearRaw = first(e, "PY", "Y1", "DA");
      const yearMatch = yearRaw?.match(/\d{4}/);
      return {
        id: `${source}:${doi ?? `ris-${hash(`${title}|${yearMatch?.[0] ?? ""}`)}`}`,
        source,
        title,
        authors: [...(e.tags["AU"] ?? []), ...(e.tags["A1"] ?? [])],
        year: yearMatch ? Number(yearMatch[0]) : undefined,
        journal: first(e, "JO", "JF", "T2", "JA"),
        doi,
        abstract: first(e, "AB", "N2"),
        url: first(e, "UR") ?? (doi ? `https://doi.org/${doi}` : undefined),
      };
    })
    .filter((r): r is WorkRecord => r !== null);
}
