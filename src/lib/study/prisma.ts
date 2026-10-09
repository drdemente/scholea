/**
 * Derives PRISMA 2020 flow-diagram counts from data captured across several
 * steps. This is a clean illustration of cross-step data flow on the engine:
 * the search, dedup, screening, and full-text steps each contribute numbers,
 * and the report step's flow diagram reads them all.
 */
import type { Project } from "@/lib/db/schema";
import type { StepData } from "./types";

export interface PrismaCounts {
  identified: number;
  duplicatesRemoved: number;
  screened: number;
  excludedScreening: number;
  soughtFullText: number;
  fullTextExcluded: number;
  included: number;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function stepData(project: Project, stepId: string): StepData {
  return (project.stepData[stepId] as StepData) ?? {};
}

export function derivePrismaCounts(project: Project): PrismaCounts {
  const search = stepData(project, "search");
  const dedup = stepData(project, "dedup");
  const screening = stepData(project, "screening");
  const fulltext = stepData(project, "fulltext");

  const identified = num(search.nIdentified);
  const duplicatesRemoved = num(dedup.nDuplicates);
  const screened = Math.max(0, identified - duplicatesRemoved);
  const excludedScreening = num(screening.nExcludedScreening);
  const soughtFullText = num(screening.nIncludedScreening);
  const fullTextExcluded = num(fulltext.nFullTextExcluded);
  const included = Math.max(0, soughtFullText - fullTextExcluded);

  return {
    identified,
    duplicatesRemoved,
    screened,
    excludedScreening,
    soughtFullText,
    fullTextExcluded,
    included,
  };
}
