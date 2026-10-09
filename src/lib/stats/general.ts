/**
 * General inferential statistics — validated, offline, dependency-free.
 *
 * These are the guaranteed engine (works with no network, in any target); the
 * optional Pyodide (scipy/statsmodels) path is a gold-standard cross-check that
 * loads on demand. p-values come from the regularized incomplete beta function
 * (Numerical Recipes) — the standard route to Student-t and F tail areas. Each
 * result carries its method + citation at the UI layer (§0.2).
 */

// --- Special functions -------------------------------------------------------

/** Lanczos approximation of ln Γ(x). */
function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued-fraction expansion for the incomplete beta (Lentz's method). */
function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-300;
  let qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}

/** Regularized incomplete beta function Iₓ(a, b). */
export function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Two-tailed p-value for Student's t with df degrees of freedom. */
export function studentTwoTailP(t: number, df: number): number {
  if (df <= 0) return NaN;
  return betai(df / 2, 0.5, df / (df + t * t));
}

/**
 * Two-sided Student-t critical value: the t such that P(|T| < t) = conf
 * (e.g. tCritical(2, 0.95) ≈ 4.30265). Inverts studentTwoTailP by bisection —
 * the two-tailed p is monotonically decreasing in t. Used for the HKSJ
 * small-sample confidence interval in the meta-analysis engine.
 */
export function tCritical(df: number, conf = 0.95): number {
  if (df <= 0) return NaN;
  const targetP = 1 - conf; // desired two-tailed tail area
  let lo = 0;
  let hi = 1e4;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (studentTwoTailP(mid, df) > targetP) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Upper-tail p-value for the F distribution, F(df1, df2). */
export function fUpperP(F: number, df1: number, df2: number): number {
  if (F <= 0) return 1;
  return betai(df2 / 2, df1 / 2, df2 / (df2 + df1 * F));
}

/** Lower regularized incomplete gamma P(a, x) by series expansion (NR gser). */
function gammaPSeries(a: number, x: number): number {
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let n = 1; n <= 300; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

/** Upper regularized incomplete gamma Q(a, x) by continued fraction (NR gcf). */
function gammaQCF(a: number, x: number): number {
  const FPMIN = 1e-300;
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 300; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** Upper regularized incomplete gamma Q(a, x) — the χ² upper-tail p-value route. */
export function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  return x < a + 1 ? 1 - gammaPSeries(a, x) : gammaQCF(a, x);
}

/**
 * Inverse standard normal CDF (probit / quantile) via Acklam's rational
 * approximation — accurate to ~1.15e-9 across the full range. Used to derive the
 * Z critical value for any confidence level / power (e.g. probit(0.975)=1.96).
 */
export function probit(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425, phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= phigh) {
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Standard normal CDF Φ(z) via the Abramowitz & Stegun 7.1.26 erf polynomial. */
export function normCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) *
      Math.exp(-x * x);
  const phi = 0.5 * (1 + erf);
  return z >= 0 ? phi : 1 - phi;
}

// --- Descriptive helpers -----------------------------------------------------

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const variance = (a: number[], m = mean(a)) => a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);

// --- Tests -------------------------------------------------------------------

export interface TTestResult {
  test: "welch";
  n1: number;
  n2: number;
  mean1: number;
  mean2: number;
  meanDiff: number;
  t: number;
  df: number;
  p: number;
  cohenD: number;
}

/** Welch's two-sample t-test (unequal variances — the safe default). */
export function welchTTest(a: number[], b: number[]): TTestResult {
  const n1 = a.length, n2 = b.length;
  const m1 = mean(a), m2 = mean(b);
  const v1 = variance(a, m1), v2 = variance(b, m2);
  const se = Math.sqrt(v1 / n1 + v2 / n2);
  const t = (m1 - m2) / se;
  const df = (v1 / n1 + v2 / n2) ** 2 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1));
  const pooledSd = Math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2));
  return { test: "welch", n1, n2, mean1: m1, mean2: m2, meanDiff: m1 - m2, t, df, p: studentTwoTailP(t, df), cohenD: (m1 - m2) / pooledSd };
}

export interface AnovaResult {
  test: "anova";
  k: number;
  n: number;
  F: number;
  df1: number;
  df2: number;
  p: number;
  etaSq: number;
}

/** One-way ANOVA across ≥2 groups. */
export function oneWayAnova(groups: number[][]): AnovaResult {
  const k = groups.length;
  const all = groups.flat();
  const n = all.length;
  const grand = mean(all);
  const ssb = groups.reduce((s, g) => s + g.length * (mean(g) - grand) ** 2, 0);
  const ssw = groups.reduce((s, g) => { const m = mean(g); return s + g.reduce((t, x) => t + (x - m) ** 2, 0); }, 0);
  const df1 = k - 1, df2 = n - k;
  const F = (ssb / df1) / (ssw / df2);
  return { test: "anova", k, n, F, df1, df2, p: fUpperP(F, df1, df2), etaSq: ssb / (ssb + ssw) };
}

export interface CorrelationResult {
  test: "pearson";
  n: number;
  r: number;
  t: number;
  df: number;
  p: number;
}

/** Pearson product-moment correlation with a two-tailed significance test. */
export function pearson(x: number[], y: number[]): CorrelationResult {
  const n = x.length;
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  const r = sxy / Math.sqrt(sxx * syy);
  const df = n - 2;
  const t = r * Math.sqrt(df / (1 - r * r));
  return { test: "pearson", n, r, t, df, p: studentTwoTailP(t, df) };
}

export interface RegressionResult {
  test: "linear";
  n: number;
  slope: number;
  intercept: number;
  r2: number;
  slopeT: number;
  df: number;
  p: number;
}

/** Simple ordinary-least-squares linear regression y ~ x. */
export function linearRegression(x: number[], y: number[]): RegressionResult {
  const n = x.length;
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = (sxy * sxy) / (sxx * syy);
  const df = n - 2;
  const sSlope = Math.sqrt((syy - slope * sxy) / df / sxx);
  const slopeT = slope / sSlope;
  return { test: "linear", n, slope, intercept, r2, slopeT, df, p: studentTwoTailP(slopeT, df) };
}

export interface PairedTResult {
  test: "paired";
  n: number;
  meanDiff: number;
  sdDiff: number;
  t: number;
  df: number;
  p: number;
  /** Cohen's d_z = mean(diff) / sd(diff). */
  dz: number;
}

/** Paired (dependent-samples) t-test on before/after pairs. */
export function pairedTTest(a: number[], b: number[]): PairedTResult {
  const n = a.length;
  const d = a.map((x, i) => x - b[i]);
  const md = mean(d);
  const sd = Math.sqrt(variance(d, md));
  const t = md / (sd / Math.sqrt(n));
  const df = n - 1;
  return { test: "paired", n, meanDiff: md, sdDiff: sd, t, df, p: studentTwoTailP(t, df), dz: md / sd };
}

export interface MannWhitneyResult {
  test: "mannwhitney";
  n1: number;
  n2: number;
  U: number;
  z: number;
  p: number;
  /** Rank-biserial correlation r = 1 − 2U/(n1·n2), an effect size. */
  rankBiserial: number;
}

/**
 * Mann-Whitney U (Wilcoxon rank-sum) — normal approximation with average ranks
 * for ties, tie-corrected variance, and continuity correction. For very small
 * samples (< ~8 per group) exact tables are preferable; noted at the UI layer.
 */
export function mannWhitneyU(a: number[], b: number[]): MannWhitneyResult {
  const n1 = a.length, n2 = b.length, N = n1 + n2;
  const all = [...a.map((v) => ({ v, g: 1 })), ...b.map((v) => ({ v, g: 2 }))].sort((x, y) => x.v - y.v);
  // Average ranks with tie counts.
  const ranks = new Array<number>(N);
  const tieGroups: number[] = [];
  let i = 0;
  while (i < N) {
    let j = i;
    while (j + 1 < N && all[j + 1].v === all[i].v) j++;
    const avg = (i + j + 2) / 2; // ranks are 1-based
    for (let k = i; k <= j; k++) ranks[k] = avg;
    if (j > i) tieGroups.push(j - i + 1);
    i = j + 1;
  }
  let r1 = 0;
  for (let k = 0; k < N; k++) if (all[k].g === 1) r1 += ranks[k];
  const U1 = r1 - (n1 * (n1 + 1)) / 2;
  const U = Math.min(U1, n1 * n2 - U1);
  const mu = (n1 * n2) / 2;
  const tieSum = tieGroups.reduce((s, t) => s + t ** 3 - t, 0);
  const sigma = Math.sqrt(((n1 * n2) / 12) * (N + 1 - tieSum / (N * (N - 1))));
  const z = sigma === 0 ? 0 : (U - mu + 0.5) / sigma;
  const p = Math.min(1, 2 * (1 - normCdf(Math.abs(z))));
  return { test: "mannwhitney", n1, n2, U, z, p, rankBiserial: 1 - (2 * U) / (n1 * n2) };
}

export interface ChiSquareResult {
  test: "chisq";
  chi2: number;
  df: number;
  p: number;
  n: number;
  /** Smallest expected cell count — the χ² approximation wants ≥ 5. */
  minExpected: number;
  /** Cramér's V effect size. */
  cramersV: number;
}

/** Pearson's χ² test of independence on an r×c contingency table (no Yates correction). */
export function chiSquare(table: number[][]): ChiSquareResult {
  const r = table.length;
  const c = table[0].length;
  const rowTot = table.map((row) => row.reduce((s, x) => s + x, 0));
  const colTot = table[0].map((_, j) => table.reduce((s, row) => s + row[j], 0));
  const n = rowTot.reduce((s, x) => s + x, 0);
  let chi2 = 0;
  let minExpected = Infinity;
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      const e = (rowTot[i] * colTot[j]) / n;
      minExpected = Math.min(minExpected, e);
      chi2 += (table[i][j] - e) ** 2 / e;
    }
  }
  const df = (r - 1) * (c - 1);
  const k = Math.min(r, c);
  return {
    test: "chisq",
    chi2,
    df,
    p: gammaQ(df / 2, chi2 / 2),
    n,
    minExpected,
    cramersV: Math.sqrt(chi2 / (n * (k - 1))),
  };
}

export interface FisherResult {
  test: "fisher";
  p: number;
  oddsRatio: number;
  n: number;
}

/** ln C(n, k) via log-gamma. */
function logChoose(n: number, k: number): number {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/**
 * Fisher's exact test (2×2, two-sided, sum of tables as or less probable than
 * the observed one — R's convention). Table: [[a, b], [c, d]].
 */
export function fisherExact(a: number, b: number, c: number, d: number): FisherResult {
  const r1 = a + b, c1 = a + c, N = a + b + c + d;
  const pmf = (k: number) => Math.exp(logChoose(c1, k) + logChoose(N - c1, r1 - k) - logChoose(N, r1));
  const kMin = Math.max(0, r1 - (N - c1));
  const kMax = Math.min(r1, c1);
  const pObs = pmf(a);
  let p = 0;
  for (let k = kMin; k <= kMax; k++) {
    const pk = pmf(k);
    if (pk <= pObs * (1 + 1e-7)) p += pk;
  }
  return { test: "fisher", p: Math.min(1, p), oddsRatio: (a * d) / (b * c), n: N };
}

export interface TwoByTwoEffects {
  test: "effects";
  oddsRatio: number;
  orCiLow: number;
  orCiHigh: number;
  riskRatio: number;
  rrCiLow: number;
  rrCiHigh: number;
  riskDiff: number;
  rdCiLow: number;
  rdCiHigh: number;
  /** True when a Haldane-Anscombe 0.5 correction was applied for a zero cell. */
  corrected: boolean;
}

/**
 * 2×2 association effects — odds ratio, risk ratio, risk difference with 95%
 * CIs (log-normal CIs for OR/RR; Wald for RD). Layout: rows = exposed/unexposed,
 * cols = outcome yes/no → [[a, b], [c, d]]. Zero cells get the standard
 * Haldane-Anscombe 0.5 correction (flagged).
 */
export function twoByTwoEffects(a0: number, b0: number, c0: number, d0: number): TwoByTwoEffects {
  const corrected = [a0, b0, c0, d0].some((x) => x === 0);
  const [a, b, c, d] = corrected ? [a0 + 0.5, b0 + 0.5, c0 + 0.5, d0 + 0.5] : [a0, b0, c0, d0];
  const z = 1.959963984540054;

  const or = (a * d) / (b * c);
  const seLogOr = Math.sqrt(1 / a + 1 / b + 1 / c + 1 / d);
  const p1 = a / (a + b);
  const p2 = c / (c + d);
  const rr = p1 / p2;
  const seLogRr = Math.sqrt(1 / a - 1 / (a + b) + 1 / c - 1 / (c + d));
  const rd = p1 - p2;
  const seRd = Math.sqrt((p1 * (1 - p1)) / (a + b) + (p2 * (1 - p2)) / (c + d));

  return {
    test: "effects",
    oddsRatio: or,
    orCiLow: or * Math.exp(-z * seLogOr),
    orCiHigh: or * Math.exp(z * seLogOr),
    riskRatio: rr,
    rrCiLow: rr * Math.exp(-z * seLogRr),
    rrCiHigh: rr * Math.exp(z * seLogRr),
    riskDiff: rd,
    rdCiLow: rd - z * seRd,
    rdCiHigh: rd + z * seRd,
    corrected,
  };
}

export interface Descriptives {
  test: "descriptives";
  n: number;
  mean: number;
  sd: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
}

/** Type-7 (linear interpolation) quantile — R's default. */
function quantile(sorted: number[], p: number): number {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** Descriptive summary: n, mean, SD (sample), five-number summary. */
export function descriptives(xs: number[]): Descriptives {
  const s = [...xs].sort((a, b) => a - b);
  const m = mean(s);
  return {
    test: "descriptives",
    n: s.length,
    mean: m,
    sd: s.length > 1 ? Math.sqrt(variance(s, m)) : 0,
    min: s[0],
    q1: quantile(s, 0.25),
    median: quantile(s, 0.5),
    q3: quantile(s, 0.75),
    max: s[s.length - 1],
  };
}

export interface ProportionCI {
  test: "proportion";
  k: number;
  n: number;
  p: number;
  ciLow: number;
  ciHigh: number;
}

/** Wilson score 95% CI for a proportion (better coverage than Wald, esp. small n). */
export function wilsonCI(k: number, n: number): ProportionCI {
  const z = 1.959963984540054;
  const phat = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (phat + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))) / denom;
  return { test: "proportion", k, n, p: phat, ciLow: Math.max(0, centre - half), ciHigh: Math.min(1, centre + half) };
}

/** Parse a textarea of numbers (comma/space/newline separated). */
export function parseNumbers(text: string): number[] {
  return text
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map(Number)
    .filter((x) => Number.isFinite(x));
}

/** Parse a contingency table: one row per line, counts separated by commas/spaces. */
export function parseTable(text: string): number[][] {
  const rows = text
    .split(/\n/)
    .map((line) => parseNumbers(line))
    .filter((r) => r.length > 0);
  if (rows.length < 2) throw new Error("Enter at least 2 rows of counts (one row per line).");
  const width = rows[0].length;
  if (width < 2 || rows.some((r) => r.length !== width)) {
    throw new Error("Every row needs the same number of counts (at least 2 columns).");
  }
  if (rows.flat().some((x) => x < 0)) throw new Error("Counts can't be negative.");
  return rows;
}
