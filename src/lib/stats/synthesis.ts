/**
 * Synthesis helpers shared by the meta-analysis tool and the compiled report, so
 * both derive the *same* effects from the same captured rows. The outcome type
 * (continuous vs dichotomous) and effect measure follow the choices made in the
 * question / data-extraction steps.
 */
import type { Project } from "@/lib/db/schema";
import type { StepData } from "@/lib/study/types";
import {
  smdFromGroups,
  mdFromGroups,
  lnORFrom2x2,
  lnRRFrom2x2,
  type EffectMeasure,
  type StudyEffect,
  type TwoByTwo,
} from "./meta";

/** A study row holds whichever numeric cells the chosen outcome type needs. */
export interface SynthRow {
  id: string;
  label: string;
  m1?: string; sd1?: string; n1?: string;
  m2?: string; sd2?: string; n2?: string;
  ev1?: string; tot1?: string;
  ev2?: string; tot2?: string;
}

export interface SynthMode {
  dichotomous: boolean;
  /** The effect measure to pool: SMD/MD (continuous) or OR/RR (dichotomous). */
  measure: EffectMeasure;
}

const num = (s?: string) => (s == null || s.trim() === "" ? NaN : Number(s));

/**
 * Resolve the outcome type + effect measure from earlier steps:
 *   • a meta-analysis pins the measure in its question step (`measure`);
 *   • a systematic review chooses continuous/dichotomous at data extraction.
 */
export function synthesisMode(project: Project): SynthMode {
  const metaMeasure = ((project.stepData["question"] as StepData)?.measure as string | undefined) ?? "";
  const outcomeType = ((project.stepData["extraction"] as StepData)?.outcomeType as string | undefined) ?? "";
  const dichotomous = metaMeasure === "OR" || metaMeasure === "RR" || outcomeType === "dichotomous";
  const measure: EffectMeasure = dichotomous
    ? metaMeasure === "OR"
      ? "OR"
      : "RR"
    : metaMeasure === "MD"
      ? "MD"
      : "SMD";
  return { dichotomous, measure };
}

/** Convert data rows to study effects for the chosen measure (invalid rows dropped). */
export function rowsToEffects(rows: SynthRow[], mode: SynthMode): StudyEffect[] {
  return rows
    .map((r) => {
      if (mode.dichotomous) {
        const [e1, t1, e2, t2] = [r.ev1, r.tot1, r.ev2, r.tot2].map(num);
        if ([e1, t1, e2, t2].some(Number.isNaN)) return null;
        if (t1 < 1 || t2 < 1 || e1 < 0 || e2 < 0 || e1 > t1 || e2 > t2) return null;
        const { yi, vi } =
          mode.measure === "OR" ? lnORFrom2x2(e1, t1 - e1, e2, t2 - e2) : lnRRFrom2x2(e1, t1, e2, t2);
        if (!Number.isFinite(yi) || !Number.isFinite(vi) || vi <= 0) return null;
        return { id: r.id, label: r.label || r.id, yi, vi };
      }
      const [m1, sd1, n1, m2, sd2, n2] = [r.m1, r.sd1, r.n1, r.m2, r.sd2, r.n2].map(num);
      if ([m1, sd1, n1, m2, sd2, n2].some(Number.isNaN) || sd1 <= 0 || sd2 <= 0 || n1 < 2 || n2 < 2) return null;
      const { yi, vi } =
        mode.measure === "MD" ? mdFromGroups(m1, sd1, n1, m2, sd2, n2) : smdFromGroups(m1, sd1, n1, m2, sd2, n2);
      return { id: r.id, label: r.label || r.id, yi, vi };
    })
    .filter((e): e is StudyEffect => e !== null);
}

/** Convert dichotomous rows to 2×2 tables for Mantel-Haenszel pooling (invalid
 *  rows dropped). No continuity correction — MH tolerates zero cells. */
export function rowsToTables(rows: SynthRow[]): TwoByTwo[] {
  return rows
    .map((r): TwoByTwo | null => {
      const [e1, t1, e2, t2] = [r.ev1, r.tot1, r.ev2, r.tot2].map(num);
      if ([e1, t1, e2, t2].some(Number.isNaN)) return null;
      if (t1 < 1 || t2 < 1 || e1 < 0 || e2 < 0 || e1 > t1 || e2 > t2) return null;
      return { id: r.id, label: r.label || r.id, a: e1, b: t1 - e1, c: e2, d: t2 - e2 };
    })
    .filter((t): t is TwoByTwo => t !== null);
}
