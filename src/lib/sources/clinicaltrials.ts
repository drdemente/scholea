/**
 * ClinicalTrials.gov — no key, free API v2. A trial REGISTRY, not a bibliographic
 * database: records are registered studies (NCT id, no journal/DOI), which is
 * exactly what reviews need for identifying unpublished/ongoing trials.
 * API docs: https://clinicaltrials.gov/data-api/api
 */
import { fetchJson, q } from "./http";
import { wantedResults } from "./types";
import type { LiteratureSource, SearchOptions, SearchResult, WorkRecord } from "./types";

interface CtgStudy {
  protocolSection?: {
    identificationModule?: { nctId?: string; briefTitle?: string; officialTitle?: string };
    statusModule?: { startDateStruct?: { date?: string } };
    descriptionModule?: { briefSummary?: string };
    sponsorCollaboratorsModule?: { leadSponsor?: { name?: string } };
  };
}
interface CtgResponse {
  totalCount?: number;
  nextPageToken?: string;
  studies?: CtgStudy[];
}

/** Noise words dropped from the CT.gov query to keep it within the registry's
 *  Essie complexity limit (long PICO phrases 400 with "Too complicated query"). */
const CTG_STOP = new Set([
  "for", "with", "in", "the", "of", "over", "a", "an", "versus", "vs", "change", "to", "on", "at", "by",
  "from", "into", "during", "per", "using", "study", "trial", "trials", "randomized", "randomised", "controlled",
]);

/**
 * Build a ClinicalTrials.gov `query.term`. The registry's Essie parser rejects
 * `[` `]`, unbalanced quotes, and long/complex free-text ("Too complicated
 * query" → HTTP 400). We strip those characters, drop noise words, cap to the
 * most salient keywords, and never end on a dangling boolean operator. Exported
 * for unit tests.
 */
export function ctgTerm(query: string): string {
  const words = query.replace(/["\[\]{}]/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const significant = words.filter((w) => !CTG_STOP.has(w.toLowerCase()));
  const chosen = (significant.length ? significant : words).slice(0, 10);
  while (chosen.length && /^(and|or|not)$/i.test(chosen[chosen.length - 1])) chosen.pop();
  while (chosen.length && /^(and|or|not)$/i.test(chosen[0])) chosen.shift();
  return chosen.join(" ");
}

/**
 * Pure filter builder — folds the requested filters into the v2 `filter.advanced`
 * Essie expression. Year range maps to the study start date; "review" and
 * open-access filters don't apply to a trial registry (noted to the caller).
 * Exported for unit tests.
 */
export function ctgFilter(opts: SearchOptions): { advanced?: string; note?: string } {
  const clauses: string[] = [];
  const notes: string[] = [];
  if (opts.yearFrom || opts.yearTo) {
    const from = opts.yearFrom ? `${opts.yearFrom}-01-01` : "MIN";
    const to = opts.yearTo ? `${opts.yearTo}-12-31` : "MAX";
    clauses.push(`AREA[StartDate]RANGE[${from},${to}]`);
  }
  if (opts.articleType === "rct") clauses.push("AREA[StudyType]INTERVENTIONAL");
  if (opts.articleType === "review") notes.push("Registry has no 'review' type — filter not applied.");
  if (opts.openAccessOnly) notes.push("Registry records are freely accessible — OA filter not applicable.");
  return {
    advanced: clauses.length ? clauses.join(" AND ") : undefined,
    note: notes.length ? notes.join(" ") : undefined,
  };
}

/** Pure normaliser — unit-tested against a captured fixture. */
export function normalizeClinicalTrials(json: CtgResponse): SearchResult {
  const studies = json.studies ?? [];
  const records: WorkRecord[] = studies.map((s) => {
    const p = s.protocolSection;
    const nct = p?.identificationModule?.nctId ?? "";
    const yearMatch = p?.statusModule?.startDateStruct?.date?.match(/^\d{4}/);
    const sponsor = p?.sponsorCollaboratorsModule?.leadSponsor?.name;
    return {
      id: `clinicaltrials:${nct}`,
      source: "clinicaltrials",
      title: p?.identificationModule?.officialTitle || p?.identificationModule?.briefTitle || "(untitled)",
      authors: sponsor ? [sponsor] : [],
      year: yearMatch ? Number(yearMatch[0]) : undefined,
      journal: "ClinicalTrials.gov",
      abstract: p?.descriptionModule?.briefSummary || undefined,
      url: nct ? `https://clinicaltrials.gov/study/${nct}` : undefined,
    };
  });
  return { source: "clinicaltrials", total: json.totalCount ?? records.length, records };
}

/**
 * The registry reports `totalCount` on the first page only. Carry it across the
 * later pages instead of letting each one overwrite it with its own length, and
 * never report fewer than were fetched. Exported for unit tests.
 */
export function ctgRunningTotal(previous: number, json: { totalCount?: number }, fetched: number): number {
  const reported = typeof json.totalCount === "number" ? json.totalCount : previous;
  return Math.max(reported, fetched);
}

export const clinicalTrialsSource: LiteratureSource = {
  id: "clinicaltrials",
  label: "ClinicalTrials.gov",
  requiresKey: false,
  corsSafe: true,
  note: "No key needed. US trial registry: finds registered (incl. unpublished/ongoing) trials.",
  async search(query, opts: SearchOptions) {
    const want = wantedResults(opts);
    const { advanced, note } = ctgFilter(opts);
    // The registry's parser is strict + complexity-limited; simplify to keywords.
    const term = ctgTerm(query);
    const notes: string[] = [];
    if (note) notes.push(note);
    if (term && term.toLowerCase() !== query.trim().toLowerCase()) {
      notes.push(`Searched the trial registry with the key terms "${term}".`);
    }
    const records: WorkRecord[] = [];
    let total = 0;
    let pageToken: string | undefined;
    // Token-based paging (v2 caps pageSize at 1000; we page in ≤100s).
    while (records.length < want) {
      const pageSize = Math.min(100, want - records.length);
      const url =
        `https://clinicaltrials.gov/api/v2/studies?query.term=${q(term)}` +
        (advanced ? `&filter.advanced=${q(advanced)}` : "") +
        `&pageSize=${pageSize}&countTotal=true` +
        (pageToken ? `&pageToken=${q(pageToken)}` : "");
      const json = await fetchJson<CtgResponse>(url, "clinicaltrials", opts.signal);
      const page = normalizeClinicalTrials(json);
      records.push(...page.records);
      total = ctgRunningTotal(total, json, records.length);
      if (page.records.length === 0) break;
      if (!json.nextPageToken) break;
      pageToken = json.nextPageToken;
    }
    return { source: "clinicaltrials" as const, total, records: records.slice(0, want), note: notes.join(" ") || undefined };
  },
};
