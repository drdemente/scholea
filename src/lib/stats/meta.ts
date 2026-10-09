/**
 * Meta-analysis engine (vetted fallback).
 *
 * The gold-standard backend is WebR + `metafor` (see meta.worker.ts / §6); this
 * module is the offline, validated fallback the spec explicitly permits ("fall
 * back to a vetted JS implementation validated against metafor in tests"). It
 * implements only established, textbook estimators — nothing novel — and every
 * result is reference-validated in meta.test.ts.
 *
 * References:
 *   • Hedges & Olkin (1985) — standardised mean difference (g) + variance.
 *   • DerSimonian & Laird (1986) — random-effects τ² (method of moments).
 *   • Higgins & Thompson (2002) — I² and Q heterogeneity.
 *   • Egger et al. (1997) — regression test for funnel-plot asymmetry.
 */

import { gammaQ, normCdf, studentTwoTailP, tCritical } from "./general";

/** 95% normal quantile. */
const Z95 = 1.959964;

/** Wald z + two-tailed p for the test of overall effect. */
function overallTest(estimate: number, se: number): { z: number; p: number } {
  const z = se > 0 ? estimate / se : 0;
  return { z, p: Math.min(1, 2 * (1 - normCdf(Math.abs(z)))) };
}

export type EffectMeasure = "SMD" | "OR" | "RR" | "MD" | "generic";

/** A study reduced to an effect estimate (yi) and its variance (vi). For OR/RR,
 *  yi/vi are on the log scale. */
export interface StudyEffect {
  id: string;
  label: string;
  yi: number;
  vi: number;
}

export interface StudyResult extends StudyEffect {
  sei: number;
  ciLow: number;
  ciHigh: number;
  /** Random-effects weight as a percentage of the total. */
  weightPct: number;
}

export interface PooledEstimate {
  estimate: number;
  se: number;
  ciLow: number;
  ciHigh: number;
  /** Wald z statistic for the test of overall effect (estimate / se). */
  z: number;
  /** Two-tailed p-value for the test of overall effect. */
  p: number;
}

/**
 * Hartung-Knapp-Sidik-Jonkman small-sample confidence interval for the
 * random-effects estimate (Module 5 §3f). Uses a t reference distribution and
 * the Knapp-Hartung variance; recommended whenever k is small (< ~10), which is
 * most student reviews. `guardApplied` marks where the IQWiG guard replaced the
 * HKSJ SE with the (larger) DL SE so the interval can't be narrower than normal.
 */
export interface HksjInterval {
  se: number;
  ciLow: number;
  ciHigh: number;
  tCrit: number;
  df: number;
  guardApplied: boolean;
  /** t statistic (estimate / SE_HKSJ) and its two-tailed p on df = k−1. */
  t: number;
  p: number;
}

export interface MetaResult {
  k: number;
  measure: EffectMeasure;
  studies: StudyResult[];
  fixed: PooledEstimate;
  random: PooledEstimate & {
    tau2: number;
    Q: number;
    df: number;
    /** Percentage, 0–100. */
    i2: number;
    /** Chi-square p-value for the Q test of heterogeneity (Module 5 §3b). */
    pQ: number;
  };
  /** HKSJ interval for the random-effects estimate; undefined when k < 2. */
  hksj?: HksjInterval;
  egger?: { intercept: number; se: number; t: number; df: number; asymmetrySuspected: boolean };
}

// --- Effect-size builders -------------------------------------------------

/** Hedges' g (bias-corrected SMD) + variance from two independent groups.
 *  Var(d) uses 2·(n1+n2) in the second term (Borenstein et al.; Module 5 §2b). */
export function smdFromGroups(
  m1: number, sd1: number, n1: number,
  m2: number, sd2: number, n2: number,
): { yi: number; vi: number } {
  const dfp = n1 + n2 - 2;
  const sp = Math.sqrt(((n1 - 1) * sd1 ** 2 + (n2 - 1) * sd2 ** 2) / dfp);
  const d = (m1 - m2) / sp;
  const J = 1 - 3 / (4 * dfp - 1); // small-sample correction
  const g = J * d;
  const vd = (n1 + n2) / (n1 * n2) + d ** 2 / (2 * (n1 + n2));
  return { yi: g, vi: J ** 2 * vd };
}

/** Raw (unstandardised) mean difference + variance from two independent groups.
 *  Use when all studies report the outcome on the same scale/units. */
export function mdFromGroups(
  m1: number, sd1: number, n1: number,
  m2: number, sd2: number, n2: number,
): { yi: number; vi: number } {
  return { yi: m1 - m2, vi: sd1 ** 2 / n1 + sd2 ** 2 / n2 };
}

/** log odds ratio + variance from a 2×2 table (events/non-events per arm). */
export function lnORFrom2x2(a: number, b: number, c: number, d: number): { yi: number; vi: number } {
  // Haldane–Anscombe 0.5 correction if any cell is zero.
  if (a === 0 || b === 0 || c === 0 || d === 0) {
    a += 0.5; b += 0.5; c += 0.5; d += 0.5;
  }
  const yi = Math.log((a * d) / (b * c));
  const vi = 1 / a + 1 / b + 1 / c + 1 / d;
  return { yi, vi };
}

/** log risk ratio + variance from a 2×2 table (events, total per arm).
 *  Cochrane continuity correction: if any of the four cells is zero, add 0.5 to
 *  all four (Module 5 §2c) — not just the zero arm. */
export function lnRRFrom2x2(e1: number, n1: number, e2: number, n2: number): { yi: number; vi: number } {
  let a = e1, b = n1 - e1, c = e2, d = n2 - e2;
  if (a === 0 || b === 0 || c === 0 || d === 0) {
    a += 0.5; b += 0.5; c += 0.5; d += 0.5;
  }
  const nt = a + b;
  const nc = c + d;
  const yi = Math.log((a / nt) / (c / nc));
  const vi = 1 / a - 1 / nt + 1 / c - 1 / nc;
  return { yi, vi };
}

// --- Pooling --------------------------------------------------------------

export function interpretI2(i2: number): string {
  if (i2 <= 40) return "Might not be important";
  if (i2 <= 60) return "Moderate heterogeneity";
  if (i2 <= 90) return "Substantial heterogeneity";
  return "Considerable heterogeneity";
}

/**
 * Pool study effects with inverse-variance fixed-effect and DerSimonian-Laird
 * random-effects models.
 */
export function metaAnalyze(effects: StudyEffect[], measure: EffectMeasure = "generic"): MetaResult {
  const k = effects.length;
  if (k === 0) throw new Error("Meta-analysis needs at least one study.");

  const w = effects.map((e) => 1 / e.vi);
  const sumW = w.reduce((a, b) => a + b, 0);
  const sumWy = effects.reduce((acc, e, i) => acc + w[i] * e.yi, 0);

  // Fixed effect (inverse-variance).
  const feEst = sumWy / sumW;
  const feVar = 1 / sumW;
  const feSe = Math.sqrt(feVar);

  // Heterogeneity (Q, τ², I²).
  const Q = effects.reduce((acc, e, i) => acc + w[i] * (e.yi - feEst) ** 2, 0);
  const df = k - 1;
  const sumW2 = w.reduce((a, b) => a + b * b, 0);
  const C = sumW - sumW2 / sumW;
  const tau2 = C > 0 ? Math.max(0, (Q - df) / C) : 0;
  const i2 = Q > 0 ? Math.max(0, ((Q - df) / Q) * 100) : 0;

  // Heterogeneity test p-value: chi-square upper tail (gammaQ(df/2, Q/2)).
  const pQ = df > 0 ? gammaQ(df / 2, Q / 2) : 1;

  // Random effects (DL).
  const wStar = effects.map((e) => 1 / (e.vi + tau2));
  const sumWStar = wStar.reduce((a, b) => a + b, 0);
  const reEst = effects.reduce((acc, e, i) => acc + wStar[i] * e.yi, 0) / sumWStar;
  const reSe = Math.sqrt(1 / sumWStar);

  const studies: StudyResult[] = effects.map((e, i) => {
    const sei = Math.sqrt(e.vi);
    return {
      ...e,
      sei,
      ciLow: e.yi - Z95 * sei,
      ciHigh: e.yi + Z95 * sei,
      weightPct: (wStar[i] / sumWStar) * 100,
    };
  });

  // HKSJ small-sample interval for the random-effects estimate (§3f).
  const hksj = k >= 2 ? hksjInterval(effects, wStar, sumWStar, reEst, reSe, k) : undefined;

  return {
    k,
    measure,
    studies,
    fixed: { estimate: feEst, se: feSe, ciLow: feEst - Z95 * feSe, ciHigh: feEst + Z95 * feSe, ...overallTest(feEst, feSe) },
    random: {
      estimate: reEst,
      se: reSe,
      ciLow: reEst - Z95 * reSe,
      ciHigh: reEst + Z95 * reSe,
      ...overallTest(reEst, reSe),
      tau2,
      Q,
      df,
      i2,
      pQ,
    },
    hksj,
    egger: k >= 3 ? eggerTest(effects) : undefined,
  };
}

/**
 * Hartung-Knapp-Sidik-Jonkman interval with the Knapp-Hartung (IQWiG) guard.
 *   q       = Σ w*_i (y_i − μ_RE)² / (k − 1)
 *   SE_HKSJ = sqrt(q / Σ w*)      (guarded so it can't be < the DL SE)
 *   CI      = μ_RE ± t(0.975, k−1) · SE_HKSJ
 */
function hksjInterval(
  effects: StudyEffect[], wStar: number[], sumWStar: number, reEst: number, reSe: number, k: number,
): HksjInterval {
  const df = k - 1;
  const q = effects.reduce((acc, e, i) => acc + wStar[i] * (e.yi - reEst) ** 2, 0) / df;
  const seRaw = Math.sqrt(q / sumWStar);
  const guardApplied = seRaw < reSe;
  const se = guardApplied ? reSe : seRaw; // Knapp-Hartung guard
  const tCrit = tCritical(df, 0.95);
  const t = se > 0 ? reEst / se : 0;
  return {
    se,
    ciLow: reEst - tCrit * se,
    ciHigh: reEst + tCrit * se,
    tCrit,
    df,
    guardApplied,
    t,
    p: studentTwoTailP(Math.abs(t), df),
  };
}

/** Egger's regression test for small-study/funnel asymmetry. */
function eggerTest(effects: StudyEffect[]): MetaResult["egger"] {
  // Regress the standard normal deviate (yi/sei) on precision (1/sei) by OLS.
  const x = effects.map((e) => 1 / Math.sqrt(e.vi)); // precision
  const y = effects.map((e) => e.yi / Math.sqrt(e.vi)); // SND
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i] - mx) ** 2;
    sxy += (x[i] - mx) * (y[i] - my);
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  // Residual variance → SE of the intercept.
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const fit = intercept + slope * x[i];
    sse += (y[i] - fit) ** 2;
  }
  const df = n - 2;
  const s2 = sse / df;
  const seIntercept = Math.sqrt(s2 * (1 / n + mx ** 2 / sxx));
  const t = intercept / seIntercept;
  return { intercept, se: seIntercept, t, df, asymmetrySuspected: Math.abs(t) > 2 };
}

// --- Mantel-Haenszel (sparse binary) --------------------------------------

/** One study's 2×2 table: a = events (treatment), b = non-events (treatment),
 *  c = events (control), d = non-events (control). */
export interface TwoByTwo {
  id: string;
  label: string;
  a: number;
  b: number;
  c: number;
  d: number;
}

export interface MhResult {
  measure: "OR" | "RR";
  k: number;
  /** Pooled estimate on the natural (exponentiated) scale, e.g. OR = 2.1. */
  estimate: number;
  /** Pooled estimate on the log scale (for plotting / CIs). */
  logEstimate: number;
  se: number;
  ciLow: number;
  ciHigh: number;
  z: number;
  p: number;
}

/**
 * Sparse events warrant Mantel-Haenszel over inverse-variance (Module 5 §2d/§4):
 * any zero cell, or any cell below 5 (rare-event heuristic).
 */
export function hasSparseEvents(tables: TwoByTwo[]): boolean {
  return tables.some((t) => t.a === 0 || t.b === 0 || t.c === 0 || t.d === 0 || Math.min(t.a, t.b, t.c, t.d) < 5);
}

/**
 * Mantel-Haenszel pooled OR or RR with model-appropriate variance:
 *   • OR: Robins-Breslow-Greenland variance of ln(OR_MH) (§2d).
 *   • RR: Greenland-Robins variance of ln(RR_MH).
 * MH needs NO continuity correction for pooling (its strength with sparse data);
 * a single zero-total arm is dropped. Returns undefined for k < 1.
 */
export function mantelHaenszel(tables: TwoByTwo[], measure: "OR" | "RR"): MhResult | undefined {
  const rows = tables.filter((t) => t.a + t.b > 0 && t.c + t.d > 0);
  if (rows.length === 0) return undefined;

  if (measure === "OR") {
    let sumR = 0, sumS = 0, sumPR = 0, sumPSQR = 0, sumQS = 0;
    for (const { a, b, c, d } of rows) {
      const N = a + b + c + d;
      const R = (a * d) / N;
      const S = (b * c) / N;
      const P = (a + d) / N;
      const Qi = (b + c) / N;
      sumR += R;
      sumS += S;
      sumPR += P * R;
      sumPSQR += P * S + Qi * R;
      sumQS += Qi * S;
    }
    const or = sumR / sumS;
    const logEstimate = Math.log(or);
    const varLog =
      sumPR / (2 * sumR ** 2) + sumPSQR / (2 * sumR * sumS) + sumQS / (2 * sumS ** 2);
    return finalizeMh("OR", rows.length, logEstimate, Math.sqrt(varLog));
  }

  // RR_MH + Greenland-Robins (1985) variance of ln(RR_MH).
  let numR = 0, denR = 0, sumP = 0;
  for (const { a, b, c, d } of rows) {
    const N = a + b + c + d;
    const nt = a + b;
    const nc = c + d;
    numR += (a * nc) / N;
    denR += (c * nt) / N;
    sumP += (nt * nc * (a + c) - a * c * N) / (N * N);
  }
  const rr = numR / denR;
  const logEstimate = Math.log(rr);
  const varLog = sumP / (numR * denR);
  return finalizeMh("RR", rows.length, logEstimate, Math.sqrt(varLog));
}

function finalizeMh(measure: "OR" | "RR", k: number, logEstimate: number, se: number): MhResult {
  const z = se > 0 ? logEstimate / se : 0;
  return {
    measure,
    k,
    estimate: Math.exp(logEstimate),
    logEstimate,
    se,
    ciLow: Math.exp(logEstimate - Z95 * se),
    ciHigh: Math.exp(logEstimate + Z95 * se),
    z,
    p: Math.min(1, 2 * (1 - normCdf(Math.abs(z)))),
  };
}

/** Exponentiate a log-scale value for OR/RR display. */
export function displayValue(v: number, measure: EffectMeasure): number {
  return measure === "OR" || measure === "RR" ? Math.exp(v) : v;
}

/** The null/no-effect reference line on the display scale. */
export function nullLine(measure: EffectMeasure): number {
  return measure === "OR" || measure === "RR" ? 1 : 0;
}
