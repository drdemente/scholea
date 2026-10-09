/**
 * Included-studies resolver — the single place downstream tools (full-text,
 * appraisal, synthesis) get "the studies in this review" from. Fallback chain:
 *   1. full-text step's final inclusions (`fulltext.includedRecords`)
 *   2. records Reviewer 1 included at title/abstract screening
 *   3. the bundled demo records (nothing real captured yet)
 * Raw search dumps are deliberately NOT used: before screening, hundreds of
 * unvetted records would flood the appraisal/synthesis tables.
 */
import type { Project } from "@/lib/db/schema";
import type { WorkRecord } from "@/lib/sources/types";
import { parseAuthor } from "@/lib/paper/citations";
import { demoRecords } from "./sr-demo-records";
import type { StepData } from "./types";

export interface IncludedStudy {
  id: string;
  /** Human study label, e.g. "Okafor 2024". */
  label: string;
  record: WorkRecord;
}

/** "FirstAuthorSurname Year" — the conventional forest-plot/RoB row label. */
export function studyLabel(r: WorkRecord): string {
  const family = r.authors[0] ? parseAuthor(r.authors[0]).family : "";
  const name = family || r.title.split(/\s+/).slice(0, 2).join(" ");
  return r.year ? `${name} ${r.year}` : name;
}

function step(project: Project, id: string): StepData {
  return (project.stepData[id] as StepData) ?? {};
}

/** The pool screening ran over: deduplicated set, else raw search, else demo. */
export function screeningPool(project: Project): WorkRecord[] {
  const dedup = step(project, "dedup").records as WorkRecord[] | undefined;
  const search = step(project, "search").records as WorkRecord[] | undefined;
  return dedup?.length ? dedup : search?.length ? search : demoRecords;
}

/** Sort records alphabetically by their study label (first author + year). */
const byLabel = (a: WorkRecord, b: WorkRecord) =>
  studyLabel(a).localeCompare(studyLabel(b), undefined, { sensitivity: "base", numeric: true });

/** Records Reviewer 1 included at title/abstract screening, A→Z by label. */
export function screeningIncludes(project: Project): WorkRecord[] {
  const decisions = step(project, "screening").decisions as
    | Record<string, { r1?: "include" | "exclude" }>
    | undefined;
  if (!decisions) return [];
  return screeningPool(project)
    .filter((r) => decisions[r.id]?.r1 === "include")
    .sort(byLabel);
}

/** The review's included studies, ordered alphabetically so every downstream
 *  step (full text, appraisal, synthesis) lists them consistently. */
export function includedStudies(project: Project): IncludedStudy[] {
  const fulltext = step(project, "fulltext").includedRecords as WorkRecord[] | undefined;
  const pool = fulltext?.length ? fulltext : screeningIncludes(project);
  const records = pool.length ? pool : demoRecords.slice(0, 4);
  return [...records]
    .sort(byLabel)
    .map((r) => ({ id: r.id, label: studyLabel(r), record: r }));
}

/**
 * Map every record id the project knows about → its study label, across all
 * pools (full-text inclusions, deduped set, raw search, demo). Lets the compiled
 * report resolve a real "Author Year" name for an appraised study even when the
 * current included-set no longer contains it (e.g. screening/full-text changed).
 */
export function recordLabelMap(project: Project): Map<string, string> {
  const map = new Map<string, string>();
  const add = (recs?: WorkRecord[]) => {
    for (const r of recs ?? []) if (r?.id && !map.has(r.id)) map.set(r.id, studyLabel(r));
  };
  add(step(project, "fulltext").includedRecords as WorkRecord[] | undefined);
  add(step(project, "dedup").records as WorkRecord[] | undefined);
  add(step(project, "search").records as WorkRecord[] | undefined);
  add(demoRecords);
  return map;
}

/** True when the studies are real (searched/screened), not the demo fallback. */
export function hasRealStudies(project: Project): boolean {
  const fulltext = step(project, "fulltext").includedRecords as WorkRecord[] | undefined;
  return !!fulltext?.length || screeningIncludes(project).length > 0;
}
