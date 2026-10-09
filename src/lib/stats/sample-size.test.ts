import { describe, expect, it } from "vitest";
import { probit } from "./general";
import {
  zCrit,
  zPower,
  adjustN,
  ssOneProportion,
  ssOneMean,
  ssTwoProportions,
  ssTwoMeans,
  ssCaseControl,
  ssCohortRR,
  ssDiagnostic,
} from "./sample-size";

describe("probit / Z critical values", () => {
  it("recovers the standard normal quantiles", () => {
    expect(probit(0.5)).toBeCloseTo(0, 6);
    expect(probit(0.975)).toBeCloseTo(1.959964, 5);
    expect(probit(0.95)).toBeCloseTo(1.644854, 5);
    expect(probit(0.8)).toBeCloseTo(0.841621, 5);
  });
  it("zCrit/zPower map confidence and power", () => {
    expect(zCrit(0.95)).toBeCloseTo(1.959964, 5);
    expect(zCrit(0.99)).toBeCloseTo(2.575829, 5);
    expect(zPower(0.9)).toBeCloseTo(1.281552, 5);
  });
});

describe("single-sample formulas (WHO / Lemeshow)", () => {
  it("one proportion: P=0.5, d=0.05, 95% → 384.16 (→ 385)", () => {
    const raw = ssOneProportion(0.5, 0.05, 0.95);
    expect(raw).toBeCloseTo(384.146, 2);
    expect(adjustN(raw)).toBe(385);
  });
  it("one mean: σ=10, d=1, 95% → 384.16", () => {
    expect(ssOneMean(10, 1, 0.95)).toBeCloseTo(384.146, 2);
  });
});

describe("two-group formulas", () => {
  it("two proportions: 0.5 vs 0.3, 95%/80%, equal → ≈93 per group", () => {
    const { n1, n2 } = ssTwoProportions(0.5, 0.3, 0.95, 0.8, 1);
    expect(n1).toBeCloseTo(93.0, 0);
    expect(n2).toBeCloseTo(n1, 6);
    expect(adjustN(n1, {}, true)).toBe(93);
  });
  it("two means: diff=5, σ=10 each, 95%/80% → ≈63 per group", () => {
    const { n1 } = ssTwoMeans(10, 10, 5, 0.95, 0.8, 1);
    expect(n1).toBeCloseTo(62.79, 1);
    expect(adjustN(n1, {}, true)).toBe(63);
  });
  it("allocation ratio scales the second group", () => {
    const { n1, n2 } = ssTwoMeans(10, 10, 5, 0.95, 0.8, 2);
    expect(n2).toBeCloseTo(2 * n1, 6);
  });
});

describe("case-control and cohort derive the exposed proportion", () => {
  it("case-control OR=2, control exposure 0.3 → p1≈0.462", () => {
    const { n1 } = ssCaseControl(0.3, 2, 0.95, 0.8, 1);
    // p1 = OR·p0/(1+p0(OR−1)) = 0.6/1.3 = 0.461538; two-proportion vs 0.3.
    const p1 = (2 * 0.3) / (1 + 0.3 * (2 - 1));
    expect(n1).toBeCloseTo(ssTwoProportions(p1, 0.3, 0.95, 0.8, 1).n1, 6);
    expect(n1).toBeGreaterThan(130); // ~141 per group — sanity band
    expect(n1).toBeLessThan(150);
  });
  it("cohort RR=2, unexposed incidence 0.1 → p1=0.2", () => {
    const { n1 } = ssCohortRR(0.1, 2, 0.95, 0.8, 1);
    expect(n1).toBeCloseTo(ssTwoProportions(0.2, 0.1, 0.95, 0.8, 1).n1, 6);
  });
});

describe("diagnostic accuracy (Buderer)", () => {
  it("Sn=0.9, d=0.05, prevalence 0.1, 95% → 138 with condition, 1383 total", () => {
    const r = ssDiagnostic(0.9, 0.05, 0.1, 0.95);
    expect(r.withCondition).toBeCloseTo(138.29, 1);
    expect(Math.ceil(r.total)).toBe(1383);
  });
});

describe("adjustments", () => {
  it("design effect multiplies, non-response inflates, then ceils", () => {
    // 100 raw · DEFF 2 = 200; / (1 − 0.1) = 222.2 → 223.
    expect(adjustN(100, { designEffect: 2, nonResponse: 0.1 })).toBe(223);
  });
  it("finite-population correction shrinks a descriptive sample", () => {
    // n0 = 384.16, N = 1000 → n = 384.16 / (1 + 383.16/1000) = 277.7 → 278.
    expect(adjustN(384.146, { population: 1000 })).toBe(278);
  });
  it("FPC is skipped for comparative (per-group) designs", () => {
    expect(adjustN(93, { population: 1000 }, true)).toBe(93);
  });
});
