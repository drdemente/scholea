/**
 * Inter-rater agreement — Cohen's kappa for two raters over nominal categories.
 *
 * Used by the screening interface to give reviewers a live calibration signal.
 * Pure and validated against published reference values (see agreement.test.ts).
 *
 * κ = (pₒ − pₑ) / (1 − pₑ)
 *   pₒ = observed proportionate agreement
 *   pₑ = agreement expected by chance from the marginals
 */
export interface KappaResult {
  /** Cohen's kappa, or null when undefined (n = 0, or perfect-chance margins). */
  kappa: number | null;
  /** Number of doubly-rated items the statistic is based on. */
  n: number;
  /** Observed agreement proportion. */
  observed: number;
  /** Plain-language strength band (Landis & Koch, 1977). */
  interpretation: string;
}

/** Landis & Koch (1977) benchmark bands. */
export function interpretKappa(k: number): string {
  if (k < 0) return "Poor (worse than chance)";
  if (k <= 0.2) return "Slight";
  if (k <= 0.4) return "Fair";
  if (k <= 0.6) return "Moderate";
  if (k <= 0.8) return "Substantial";
  return "Almost perfect";
}

/**
 * @param pairs items both raters scored, as [raterA, raterB] category labels.
 */
export function cohenKappa(pairs: Array<[string, string]>): KappaResult {
  const n = pairs.length;
  if (n === 0) return { kappa: null, n: 0, observed: 0, interpretation: "Not enough data" };

  const categories = new Set<string>();
  for (const [a, b] of pairs) {
    categories.add(a);
    categories.add(b);
  }
  const cats = [...categories];

  let agree = 0;
  const rowA: Record<string, number> = {};
  const rowB: Record<string, number> = {};
  for (const c of cats) {
    rowA[c] = 0;
    rowB[c] = 0;
  }
  for (const [a, b] of pairs) {
    if (a === b) agree++;
    rowA[a]++;
    rowB[b]++;
  }

  const observed = agree / n;
  let expected = 0;
  for (const c of cats) expected += (rowA[c] / n) * (rowB[c] / n);

  // Perfect/degenerate marginals: κ is 1 if fully agreed, otherwise undefined.
  if (expected === 1) {
    return {
      kappa: observed === 1 ? 1 : null,
      n,
      observed,
      interpretation: observed === 1 ? "Almost perfect" : "Undefined",
    };
  }

  const kappa = (observed - expected) / (1 - expected);
  return { kappa, n, observed, interpretation: interpretKappa(kappa) };
}
