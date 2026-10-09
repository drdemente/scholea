/**
 * Descriptive statistics — pure, testable, validated against reference output.
 *
 * STEP-1 SCOPE: only trivial descriptives live here. Per §6, no hand-rolled
 * inferential/meta-analytic math ships — those wrap validated libraries
 * (WebR + metafor, Pyodide + scipy/statsmodels) and are unit-tested against
 * published reference output before release.
 */
export interface Descriptives {
  n: number;
  mean: number;
  /** Sample standard deviation (Bessel's correction, n − 1). */
  sd: number;
  min: number;
  max: number;
}

export function descriptives(values: number[]): Descriptives {
  const n = values.length;
  if (n === 0) return { n: 0, mean: NaN, sd: NaN, min: NaN, max: NaN };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return {
    n,
    mean,
    sd: Math.sqrt(variance),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}
