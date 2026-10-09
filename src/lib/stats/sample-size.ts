/**
 * Sample-size calculators — the standard WHO / Lwanga & Lemeshow (1991,
 * "Sample Size Determination in Health Studies") formulas plus the common
 * adjustments (design effect for cluster sampling, non-response inflation, and
 * the finite-population correction). All pure and reference-tested; the Z
 * critical values come from `probit` so any confidence level / power works.
 *
 * References:
 *   • Lwanga SK, Lemeshow S. Sample Size Determination in Health Studies. WHO, 1991.
 *   • Fleiss JL. Statistical Methods for Rates and Proportions (unequal groups).
 *   • Buderer NMF (1996) — diagnostic-accuracy sample size.
 */
import { probit } from "./general";

/** Two-sided critical Z for a confidence level (e.g. 0.95 → 1.959964). */
export function zCrit(confidence: number): number {
  return probit(1 - (1 - confidence) / 2);
}
/** Z for statistical power (e.g. 0.80 → 0.841621). */
export function zPower(power: number): number {
  return probit(power);
}

export interface SsAdjust {
  /** Design effect for cluster sampling (≥ 1). Multiplies n. */
  designEffect?: number;
  /** Expected non-response / attrition proportion (0 ≤ x < 1). Inflates n. */
  nonResponse?: number;
  /** Finite population size for the FPC (descriptive single-sample only). */
  population?: number;
}

/**
 * Apply design effect, finite-population correction (single-sample only), and
 * non-response inflation, then round up. FPC is skipped when `population` is
 * absent or when `perGroupDesign` is true (comparative designs).
 */
export function adjustN(nRaw: number, adj: SsAdjust = {}, perGroupDesign = false): number {
  if (!Number.isFinite(nRaw) || nRaw <= 0) return NaN;
  let n = nRaw * (adj.designEffect && adj.designEffect > 0 ? adj.designEffect : 1);
  if (!perGroupDesign && adj.population && adj.population > 0) {
    n = n / (1 + (n - 1) / adj.population);
  }
  const nr = adj.nonResponse ?? 0;
  if (nr > 0 && nr < 1) n = n / (1 - nr);
  return Math.ceil(n);
}

// --- Single-sample (descriptive) --------------------------------------------

/** Estimate one proportion with absolute precision d: n = Z²·P(1−P)/d². */
export function ssOneProportion(p: number, d: number, confidence = 0.95): number {
  const z = zCrit(confidence);
  return (z * z * p * (1 - p)) / (d * d);
}

/** Estimate one mean with absolute precision d: n = Z²·σ²/d². */
export function ssOneMean(sd: number, d: number, confidence = 0.95): number {
  const z = zCrit(confidence);
  return (z * z * sd * sd) / (d * d);
}

// --- Two-group (comparative) hypothesis tests --------------------------------

export interface TwoGroupN {
  n1: number;
  n2: number;
}

/**
 * Two independent proportions (test of difference), allowing an allocation
 * ratio r = n2/n1 (Fleiss). group1 = index/exposed/cases, group2 = comparator.
 */
export function ssTwoProportions(p1: number, p2: number, confidence = 0.95, power = 0.8, ratio = 1): TwoGroupN {
  const za = zCrit(confidence);
  const zb = zPower(power);
  const r = ratio > 0 ? ratio : 1;
  const pbar = (p1 + r * p2) / (1 + r);
  const n1 =
    Math.pow(za * Math.sqrt((1 + 1 / r) * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2) / r), 2) /
    Math.pow(p1 - p2, 2);
  return { n1, n2: r * n1 };
}

/** Two independent means (test of difference), allocation ratio r = n2/n1. */
export function ssTwoMeans(sd1: number, sd2: number, diff: number, confidence = 0.95, power = 0.8, ratio = 1): TwoGroupN {
  const za = zCrit(confidence);
  const zb = zPower(power);
  const r = ratio > 0 ? ratio : 1;
  const n1 = (Math.pow(za + zb, 2) * (sd1 * sd1 + (sd2 * sd2) / r)) / (diff * diff);
  return { n1, n2: r * n1 };
}

/**
 * Case-control by odds ratio: from the exposure prevalence in controls (p0)
 * and the OR to detect, derive the exposed proportion in cases (p1) and apply
 * the two-proportion formula. ratio = controls per case.
 */
export function ssCaseControl(p0: number, or: number, confidence = 0.95, power = 0.8, ratio = 1): TwoGroupN {
  const p1 = (or * p0) / (1 + p0 * (or - 1));
  return ssTwoProportions(p1, p0, confidence, power, ratio);
}

/**
 * Cohort by relative risk: from the incidence in the unexposed (p0) and the RR
 * to detect, derive the exposed incidence (p1). ratio = unexposed per exposed.
 */
export function ssCohortRR(p0: number, rr: number, confidence = 0.95, power = 0.8, ratio = 1): TwoGroupN {
  const p1 = Math.min(0.999999, rr * p0);
  return ssTwoProportions(p1, p0, confidence, power, ratio);
}

// --- Diagnostic accuracy (Buderer) ------------------------------------------

/**
 * Diagnostic-accuracy sample size for a target sensitivity (or specificity)
 * with absolute precision d, scaled by disease prevalence. Returns the number
 * with the condition needed and the total to screen.
 */
export function ssDiagnostic(snOrSp: number, d: number, prevalence: number, confidence = 0.95): { withCondition: number; total: number } {
  const z = zCrit(confidence);
  const withCondition = (z * z * snOrSp * (1 - snOrSp)) / (d * d);
  return { withCondition, total: prevalence > 0 ? withCondition / prevalence : NaN };
}
