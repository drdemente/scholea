import { describe, expect, it } from "vitest";
import {
  betai,
  studentTwoTailP,
  tCritical,
  fUpperP,
  gammaQ,
  normCdf,
  welchTTest,
  oneWayAnova,
  pearson,
  linearRegression,
  pairedTTest,
  mannWhitneyU,
  chiSquare,
  fisherExact,
  twoByTwoEffects,
  descriptives,
  wilsonCI,
  parseNumbers,
  parseTable,
} from "./general";

describe("special functions", () => {
  it("betai matches the arcsine identity I(0.5; 0.5, 0.5) = 0.5", () => {
    expect(betai(0.5, 0.5, 0.5)).toBeCloseTo(0.5, 6);
  });
  it("I(x; a, 1) = x^a (exact)", () => {
    expect(betai(3, 1, 0.2)).toBeCloseTo(0.008, 6);
  });
  it("t=0 gives a two-tailed p of 1", () => {
    expect(studentTwoTailP(0, 10)).toBeCloseTo(1, 6);
  });
  it("tCritical inverts the t tail (known 97.5% quantiles)", () => {
    expect(tCritical(2, 0.95)).toBeCloseTo(4.30265, 3);
    expect(tCritical(10, 0.95)).toBeCloseTo(2.22814, 3);
    expect(tCritical(1000, 0.95)).toBeCloseTo(1.96234, 2);
  });
});

describe("welchTTest", () => {
  // A=[27..31] mean 29 var 2.5; B=[31..35] mean 33 var 2.5 → t=-4, df=8.
  const r = welchTTest([27, 28, 29, 30, 31], [31, 32, 33, 34, 35]);
  it("computes t, df, and Cohen's d", () => {
    expect(r.t).toBeCloseTo(-4, 6);
    expect(r.df).toBeCloseTo(8, 6);
    expect(r.cohenD).toBeCloseTo(-2.5298, 3);
  });
  it("gives a small two-tailed p", () => {
    expect(r.p).toBeGreaterThan(0.003);
    expect(r.p).toBeLessThan(0.005);
  });
});

describe("oneWayAnova", () => {
  const r = oneWayAnova([[1, 2, 3], [3, 4, 5], [5, 6, 7]]); // F=12 on (2,6)
  it("computes F, df, eta², and p", () => {
    expect(r.F).toBeCloseTo(12, 6);
    expect(r.df1).toBe(2);
    expect(r.df2).toBe(6);
    expect(r.etaSq).toBeCloseTo(0.8, 6);
    expect(r.p).toBeCloseTo(0.008, 3);
  });
});

describe("pearson", () => {
  const r = pearson([1, 2, 3, 4, 5], [1, 3, 2, 5, 4]); // r=0.8, n=5
  it("computes r and its two-tailed p", () => {
    expect(r.r).toBeCloseTo(0.8, 6);
    expect(r.t).toBeCloseTo(2.3094, 3);
    expect(r.p).toBeCloseTo(0.104, 2);
  });
});

describe("linearRegression", () => {
  const r = linearRegression([1, 2, 3, 4, 5], [1, 3, 2, 5, 4]);
  it("recovers slope, intercept, and R²", () => {
    expect(r.slope).toBeCloseTo(0.8, 6);
    expect(r.intercept).toBeCloseTo(0.6, 6);
    expect(r.r2).toBeCloseTo(0.64, 6);
    expect(r.p).toBeCloseTo(0.104, 2);
  });
});

describe("parseNumbers", () => {
  it("splits on commas, spaces, and newlines and drops junk", () => {
    expect(parseNumbers("1, 2\n3  4\tx 5.5")).toEqual([1, 2, 3, 4, 5.5]);
  });
});

describe("fUpperP", () => {
  it("F=0 gives p=1", () => {
    expect(fUpperP(0, 2, 6)).toBe(1);
  });
});

describe("gammaQ / normCdf", () => {
  it("recovers the classic χ² critical values (p ≈ 0.05)", () => {
    expect(gammaQ(0.5, 3.841 / 2)).toBeCloseTo(0.05, 3); // χ²=3.841, df=1
    expect(gammaQ(1, 5.991 / 2)).toBeCloseTo(0.05, 3); // χ²=5.991, df=2
  });
  it("normCdf hits the standard landmarks", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1.6449)).toBeCloseTo(0.05, 3);
  });
});

describe("pairedTTest", () => {
  // diffs = [-1,-1,-1,-1,-2] → mean -1.2, sd √0.2, t = -6 on 4 df.
  const r = pairedTTest([1, 2, 3, 4, 5], [2, 3, 4, 5, 7]);
  it("computes t, df, and dz on the differences", () => {
    expect(r.t).toBeCloseTo(-6, 6);
    expect(r.df).toBe(4);
    expect(r.meanDiff).toBeCloseTo(-1.2, 6);
    expect(r.dz).toBeCloseTo(-2.6833, 3);
    expect(r.p).toBeCloseTo(0.0039, 3);
  });
});

describe("mannWhitneyU", () => {
  it("fully separated groups: U=0, continuity-corrected z, p ≈ 0.0304", () => {
    const r = mannWhitneyU([1, 2, 3, 4], [5, 6, 7, 8]);
    expect(r.U).toBe(0);
    expect(r.z).toBeCloseTo(-2.1651, 3);
    expect(r.p).toBeCloseTo(0.0304, 3);
    expect(r.rankBiserial).toBeCloseTo(1, 6);
  });
  it("handles ties via average ranks", () => {
    const r = mannWhitneyU([1, 2, 2, 3], [2, 3, 3, 4]);
    expect(r.U).toBeGreaterThan(0);
    expect(r.p).toBeGreaterThan(0.05); // heavy overlap → not significant
  });
});

describe("chiSquare", () => {
  it("matches scipy's chi2_contingency (correction=False) on a 2×2", () => {
    const r = chiSquare([[10, 20], [30, 40]]);
    expect(r.chi2).toBeCloseTo(0.79365, 4);
    expect(r.df).toBe(1);
    expect(r.p).toBeCloseTo(0.37297, 4);
    expect(r.minExpected).toBeCloseTo(12, 6);
  });
  it("handles r×c tables (df = (r−1)(c−1))", () => {
    const r = chiSquare([[10, 10, 10], [10, 10, 20]]);
    expect(r.df).toBe(2);
    expect(r.n).toBe(70);
  });
});

describe("fisherExact", () => {
  it("reproduces the lady-tasting-tea two-sided p = 34/70", () => {
    const r = fisherExact(3, 1, 1, 3);
    expect(r.p).toBeCloseTo(34 / 70, 6);
    expect(r.oddsRatio).toBeCloseTo(9, 6);
  });
  it("a balanced table gives p = 1", () => {
    expect(fisherExact(5, 5, 5, 5).p).toBeCloseTo(1, 6);
  });
});

describe("twoByTwoEffects", () => {
  const r = twoByTwoEffects(10, 90, 5, 95);
  it("computes OR, RR, and RD point estimates", () => {
    expect(r.oddsRatio).toBeCloseTo(2.1111, 3);
    expect(r.riskRatio).toBeCloseTo(2.0, 6);
    expect(r.riskDiff).toBeCloseTo(0.05, 6);
    expect(r.corrected).toBe(false);
  });
  it("log-normal CIs bracket the estimate", () => {
    expect(r.orCiLow).toBeLessThan(r.oddsRatio);
    expect(r.orCiHigh).toBeGreaterThan(r.oddsRatio);
    expect(r.rrCiLow).toBeCloseTo(0.709, 3); // exp(ln2 − 1.96·SE), SE=√(1/10−1/100+1/5−1/100)=√0.28
  });
  it("applies the Haldane-Anscombe correction on zero cells", () => {
    expect(twoByTwoEffects(0, 10, 5, 5).corrected).toBe(true);
  });
});

describe("descriptives / wilsonCI", () => {
  it("five-number summary uses type-7 quantiles (R default)", () => {
    const d = descriptives([9, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(d.median).toBe(5);
    expect(d.q1).toBe(3);
    expect(d.q3).toBe(7);
    expect(d.mean).toBeCloseTo(5, 6);
  });
  it("Wilson 95% CI for 8/10 matches the published interval", () => {
    const w = wilsonCI(8, 10);
    expect(w.p).toBeCloseTo(0.8, 6);
    expect(w.ciLow).toBeCloseTo(0.49, 2);
    expect(w.ciHigh).toBeCloseTo(0.943, 2);
  });
});

describe("parseTable", () => {
  it("parses one row per line and enforces a rectangle", () => {
    expect(parseTable("10, 20\n30 40")).toEqual([[10, 20], [30, 40]]);
    expect(() => parseTable("1, 2\n3")).toThrow();
    expect(() => parseTable("1 2")).toThrow();
  });
});
