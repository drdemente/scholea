/**
 * Study-type registry — the single list the app draws from. Adding a study type
 * is: author a config, import it here. Nothing in the engine changes.
 */
import type { StudyFamily, StudyTypeConfig } from "./types";
import { systematicReview } from "./systematic-review";
import { metaAnalysis } from "./configs/meta-analysis";
import { scopingReview } from "./configs/scoping-review";
import { narrativeReview } from "./configs/narrative-review";
import { umbrellaReview } from "./configs/umbrella-review";
import { crossSectional } from "./configs/cross-sectional";
import { cohort } from "./configs/cohort";
import { caseControl } from "./configs/case-control";
import { rct } from "./configs/rct";
import { quasiExperimental } from "./configs/quasi-experimental";
import { diagnosticAccuracy } from "./configs/diagnostic-accuracy";
import { qualitative } from "./configs/qualitative";
import { survey } from "./configs/survey";
import { mixedMethods } from "./configs/mixed-methods";
import { caseReport } from "./configs/case-report";
import { economic } from "./configs/economic";
import { animal } from "./configs/animal";

export const STUDY_CONFIGS: StudyTypeConfig[] = [
  systematicReview,
  metaAnalysis,
  scopingReview,
  narrativeReview,
  umbrellaReview,
  crossSectional,
  cohort,
  caseControl,
  rct,
  quasiExperimental,
  diagnosticAccuracy,
  qualitative,
  survey,
  mixedMethods,
  caseReport,
  economic,
  animal,
];

export function configById(id: string): StudyTypeConfig | undefined {
  return STUDY_CONFIGS.find((c) => c.id === id);
}

const FAMILY_ORDER: StudyFamily[] = [
  "review",
  "observational",
  "experimental",
  "diagnostic",
  "qualitative",
  "survey",
  "mixed",
  "report",
];

export const FAMILY_LABEL: Record<StudyFamily, string> = {
  review: "Evidence synthesis",
  observational: "Observational",
  experimental: "Experimental",
  diagnostic: "Diagnostic accuracy",
  qualitative: "Qualitative",
  survey: "Survey",
  mixed: "Mixed-methods",
  report: "Reports & other",
};

export interface FamilyGroup {
  family: StudyFamily;
  label: string;
  configs: StudyTypeConfig[];
}

/** Configs grouped by family in display order (empty families omitted). */
export function configsByFamily(): FamilyGroup[] {
  return FAMILY_ORDER.map((family) => ({
    family,
    label: FAMILY_LABEL[family],
    configs: STUDY_CONFIGS.filter((c) => c.family === family),
  })).filter((g) => g.configs.length > 0);
}
