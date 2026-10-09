/**
 * Diagnostic-accuracy + reliability statistics (validated, reference-tested).
 * Only established formulas; nothing novel (§0.2). See diagnostics.test.ts.
 *
 * References:
 *   • Sensitivity/specificity/PPV/NPV/LR — standard 2×2 definitions.
 *   • ROC AUC — trapezoidal integration of the ROC curve.
 *   • Cronbach's α — Cronbach (1951).
 */

export interface DiagnosticMetrics {
  sensitivity: number;
  specificity: number;
  ppv: number;
  npv: number;
  lrPositive: number;
  lrNegative: number;
  accuracy: number;
}

const safe = (num: number, den: number): number => (den === 0 ? NaN : num / den);

/** Compute accuracy metrics from a 2×2 table (test vs reference standard). */
export function from2x2(tp: number, fp: number, fn: number, tn: number): DiagnosticMetrics {
  const sensitivity = safe(tp, tp + fn);
  const specificity = safe(tn, tn + fp);
  return {
    sensitivity,
    specificity,
    ppv: safe(tp, tp + fp),
    npv: safe(tn, tn + fn),
    lrPositive: safe(sensitivity, 1 - specificity),
    lrNegative: safe(1 - sensitivity, specificity),
    accuracy: safe(tp + tn, tp + fp + fn + tn),
  };
}

export interface RocPoint {
  /** False-positive rate (1 − specificity). */
  fpr: number;
  /** True-positive rate (sensitivity). */
  tpr: number;
}

/** Area under the ROC curve by the trapezoidal rule. Endpoints (0,0)/(1,1) are
 *  added if absent so a partial set of operating points still integrates. */
export function rocAuc(points: RocPoint[]): number {
  const pts = [...points];
  if (!pts.some((p) => p.fpr === 0 && p.tpr === 0)) pts.push({ fpr: 0, tpr: 0 });
  if (!pts.some((p) => p.fpr === 1 && p.tpr === 1)) pts.push({ fpr: 1, tpr: 1 });
  pts.sort((a, b) => a.fpr - b.fpr || a.tpr - b.tpr);
  let auc = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].fpr - pts[i - 1].fpr;
    auc += (dx * (pts[i].tpr + pts[i - 1].tpr)) / 2;
  }
  return auc;
}

/** Cronbach's α from item variances and the total-score variance. */
export function cronbachAlphaFromVariances(itemVariances: number[], totalVariance: number): number {
  const k = itemVariances.length;
  if (k < 2 || totalVariance === 0) return NaN;
  const sumItemVar = itemVariances.reduce((a, b) => a + b, 0);
  return (k / (k - 1)) * (1 - sumItemVar / totalVariance);
}

/** Standardized α from item count and mean inter-item correlation. */
export function standardizedAlpha(k: number, meanInterItemR: number): number {
  if (k < 2) return NaN;
  return (k * meanInterItemR) / (1 + (k - 1) * meanInterItemR);
}

/** Plain-language reliability band for α (Nunnally conventions). */
export function interpretAlpha(a: number): string {
  if (a < 0.5) return "Unacceptable";
  if (a < 0.6) return "Poor";
  if (a < 0.7) return "Questionable";
  if (a < 0.8) return "Acceptable";
  if (a < 0.9) return "Good";
  return "Excellent";
}
