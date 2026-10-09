import { describe, expect, it } from "vitest";
import {
  hasSparseEvents,
  interpretI2,
  lnORFrom2x2,
  lnRRFrom2x2,
  mantelHaenszel,
  mdFromGroups,
  metaAnalyze,
  smdFromGroups,
  type StudyEffect,
  type TwoByTwo,
} from "./meta";

describe("effect-size builders", () => {
  it("computes Hedges' g and variance (Hedges & Olkin; Var(d) uses 2·(n1+n2))", () => {
    // m1=10,sd1=2,n1=20; m2=8,sd2=2,n2=20 → sp=2, d=1.
    // df=38, J = 1 - 3/(4*38-1) = 1 - 3/151 = 0.98013.
    // g = 0.98013; var(d) = 40/400 + 1/(2*40) = 0.1 + 0.0125 = 0.1125;  (Module 5 §2b)
    // var(g) = J^2 * var(d) = 0.96066 * 0.1125 = 0.108074.
    const { yi, vi } = smdFromGroups(10, 2, 20, 8, 2, 20);
    expect(yi).toBeCloseTo(0.98013, 4);
    expect(vi).toBeCloseTo(0.10807, 4);
  });

  it("computes a raw mean difference and its variance", () => {
    // m1=10,sd1=2,n1=20; m2=8,sd2=3,n2=25 → MD=2; var=4/20+9/25=0.2+0.36=0.56.
    const { yi, vi } = mdFromGroups(10, 2, 20, 8, 3, 25);
    expect(yi).toBeCloseTo(2, 10);
    expect(vi).toBeCloseTo(0.56, 10);
  });

  it("computes log odds ratio and variance from a 2×2 table", () => {
    // a=10,b=20,c=5,d=25 → OR=(10*25)/(20*5)=2.5; ln=0.916291.
    // var = 1/10+1/20+1/5+1/25 = 0.39.
    const { yi, vi } = lnORFrom2x2(10, 20, 5, 25);
    expect(yi).toBeCloseTo(0.916291, 5);
    expect(vi).toBeCloseTo(0.39, 10);
  });

  it("applies a continuity correction when a cell is zero", () => {
    expect(() => lnORFrom2x2(0, 10, 5, 10)).not.toThrow();
    expect(Number.isFinite(lnORFrom2x2(0, 10, 5, 10).yi)).toBe(true);
  });

  it("computes log risk ratio and variance", () => {
    // e1=10,n1=100 (r1=0.1); e2=20,n2=100 (r2=0.2) → RR=0.5; ln=-0.693147.
    // var = 1/10 - 1/100 + 1/20 - 1/100 = 0.1 - 0.01 + 0.05 - 0.01 = 0.13.
    const { yi, vi } = lnRRFrom2x2(10, 100, 20, 100);
    expect(yi).toBeCloseTo(-0.693147, 5);
    expect(vi).toBeCloseTo(0.13, 10);
  });
});

describe("metaAnalyze — homogeneous case", () => {
  it("pools identical studies to their common value with Q=0, I²=0", () => {
    const effects: StudyEffect[] = [
      { id: "a", label: "A", yi: 0.5, vi: 0.04 },
      { id: "b", label: "B", yi: 0.5, vi: 0.04 },
    ];
    const r = metaAnalyze(effects);
    // wi=25 each; pooled=0.5; var=1/50=0.02; se=0.141421.
    expect(r.fixed.estimate).toBeCloseTo(0.5, 10);
    expect(r.fixed.se).toBeCloseTo(0.141421, 5);
    expect(r.random.Q).toBeCloseTo(0, 10);
    expect(r.random.i2).toBe(0);
    expect(r.random.tau2).toBe(0);
    // With τ²=0 the random-effects estimate equals fixed effect.
    expect(r.random.estimate).toBeCloseTo(0.5, 10);
  });

  it("computes the pooled z and two-tailed p (test of overall effect)", () => {
    // estimate 0.5, se 0.1 → z=5, p≈5.73e-7.
    const r = metaAnalyze([
      { id: "a", label: "A", yi: 0.5, vi: 0.02 },
      { id: "b", label: "B", yi: 0.5, vi: 0.02 },
    ]);
    // se = sqrt(1/(2*50)) = 0.1.
    expect(r.random.se).toBeCloseTo(0.1, 6);
    expect(r.random.z).toBeCloseTo(5, 3);
    expect(r.random.p).toBeGreaterThan(0);
    expect(r.random.p).toBeLessThan(1e-5);
  });

  it("a null pooled effect (estimate 0) gives p = 1", () => {
    const r = metaAnalyze([
      { id: "a", label: "A", yi: -0.5, vi: 0.04 },
      { id: "b", label: "B", yi: 0.5, vi: 0.04 },
    ]);
    expect(r.fixed.estimate).toBeCloseTo(0, 10);
    expect(r.fixed.p).toBeCloseTo(1, 6);
  });
});

describe("metaAnalyze — heterogeneous case (fully hand-computed)", () => {
  // yi=[0.2,0.5,0.8], vi=0.05 each. wi=20 each, Σw=60.
  // FE = (0.2+0.5+0.8)*20/60 = 0.5.
  // Q = 20*((0.2-0.5)^2 + 0 + (0.8-0.5)^2) = 20*0.18 = 3.6, df=2.
  // C = Σw - Σw²/Σw = 60 - 1200/60 = 40 → τ² = (3.6-2)/40 = 0.04.
  // I² = (3.6-2)/3.6 = 44.444%.
  // RE w* = 1/(0.05+0.04)=11.1111; RE est = 0.5 (symmetric); se = sqrt(1/33.333)=0.173205.
  const effects: StudyEffect[] = [
    { id: "a", label: "A", yi: 0.2, vi: 0.05 },
    { id: "b", label: "B", yi: 0.5, vi: 0.05 },
    { id: "c", label: "C", yi: 0.8, vi: 0.05 },
  ];
  const r = metaAnalyze(effects);

  it("matches the hand-computed FE estimate and Q", () => {
    expect(r.fixed.estimate).toBeCloseTo(0.5, 10);
    expect(r.random.Q).toBeCloseTo(3.6, 6);
    expect(r.random.df).toBe(2);
  });

  it("matches the hand-computed τ² and I²", () => {
    expect(r.random.tau2).toBeCloseTo(0.04, 6);
    expect(r.random.i2).toBeCloseTo(44.4444, 3);
  });

  it("matches the hand-computed RE estimate and SE", () => {
    expect(r.random.estimate).toBeCloseTo(0.5, 6);
    expect(r.random.se).toBeCloseTo(0.173205, 5);
  });

  it("assigns per-study CIs and weights that sum to 100%", () => {
    const total = r.studies.reduce((a, s) => a + s.weightPct, 0);
    expect(total).toBeCloseTo(100, 6);
    // Study A: 0.2 ± 1.959964*sqrt(0.05)=±0.438215.
    expect(r.studies[0].ciLow).toBeCloseTo(-0.238215, 4);
    expect(r.studies[0].ciHigh).toBeCloseTo(0.638215, 4);
  });

  it("runs Egger's test when k ≥ 3", () => {
    expect(r.egger).toBeDefined();
    expect(r.egger?.df).toBe(1);
  });
});

describe("Module 5 §6 validation case (3-study MD with HKSJ)", () => {
  // Feed effect/SE directly (skip §2): A(0.30,0.12) B(0.45,0.09) C(0.15,0.18).
  const effects: StudyEffect[] = [
    { id: "A", label: "A", yi: 0.3, vi: 0.12 ** 2 },
    { id: "B", label: "B", yi: 0.45, vi: 0.09 ** 2 },
    { id: "C", label: "C", yi: 0.15, vi: 0.18 ** 2 },
  ];
  const r = metaAnalyze(effects, "MD");

  it("reproduces the fixed-effect estimate, SE and CI", () => {
    expect(r.fixed.estimate).toBeCloseTo(0.362, 3);
    expect(r.fixed.se).toBeCloseTo(0.067, 3);
    expect(r.fixed.ciLow).toBeCloseTo(0.231, 2);
    expect(r.fixed.ciHigh).toBeCloseTo(0.493, 2);
  });

  it("reproduces heterogeneity Q, I², τ² and the Q p-value", () => {
    expect(r.random.Q).toBeCloseTo(2.61, 2);
    expect(r.random.df).toBe(2);
    expect(r.random.i2).toBeCloseTo(23, 0);
    expect(r.random.tau2).toBeCloseTo(0.0047, 3);
    expect(r.random.pQ).toBeCloseTo(0.271, 2);
  });

  it("reproduces the random-effects estimate and normal CI", () => {
    expect(r.random.estimate).toBeCloseTo(0.349, 3);
    expect(r.random.se).toBeCloseTo(0.08, 2);
    expect(r.random.ciLow).toBeCloseTo(0.193, 2);
    expect(r.random.ciHigh).toBeCloseTo(0.505, 2);
  });

  it("reproduces the HKSJ interval with t_crit = 4.303 (guard triggers)", () => {
    expect(r.hksj).toBeDefined();
    expect(r.hksj?.tCrit).toBeCloseTo(4.303, 3);
    expect(r.hksj?.guardApplied).toBe(true);
    expect(r.hksj?.ciLow).toBeCloseTo(0.006, 2);
    expect(r.hksj?.ciHigh).toBeCloseTo(0.692, 2);
  });
});

describe("Mantel-Haenszel (sparse binary)", () => {
  it("flags sparse events (zero cell or any cell < 5)", () => {
    expect(hasSparseEvents([{ id: "1", label: "1", a: 0, b: 20, c: 3, d: 17 }])).toBe(true);
    expect(hasSparseEvents([{ id: "1", label: "1", a: 40, b: 60, c: 30, d: 70 }])).toBe(false);
  });

  it("pools OR with the Robins-Breslow-Greenland variance", () => {
    // Two identical studies a=10,b=90,c=5,d=95 → each OR=(10*95)/(90*5)=2.1111.
    const tables: TwoByTwo[] = [
      { id: "1", label: "1", a: 10, b: 90, c: 5, d: 95 },
      { id: "2", label: "2", a: 10, b: 90, c: 5, d: 95 },
    ];
    const mh = mantelHaenszel(tables, "OR");
    expect(mh).toBeDefined();
    expect(mh?.estimate).toBeCloseTo(2.111, 2);
    expect(mh?.se).toBeGreaterThan(0);
    expect(mh?.ciLow).toBeLessThan(mh!.estimate);
    expect(mh?.ciHigh).toBeGreaterThan(mh!.estimate);
  });

  it("pools RR and handles a zero-total arm by dropping it", () => {
    const tables: TwoByTwo[] = [
      { id: "1", label: "1", a: 2, b: 48, c: 6, d: 44 },
      { id: "2", label: "2", a: 0, b: 0, c: 0, d: 0 }, // empty study dropped
    ];
    const mh = mantelHaenszel(tables, "RR");
    expect(mh?.k).toBe(1);
    expect(mh?.estimate).toBeCloseTo((2 / 50) / (6 / 50), 3);
  });
});

describe("interpretI2", () => {
  it("uses Cochrane bands", () => {
    expect(interpretI2(20)).toMatch(/not be important/);
    expect(interpretI2(50)).toMatch(/Moderate/);
    expect(interpretI2(80)).toMatch(/Substantial/);
    expect(interpretI2(95)).toMatch(/Considerable/);
  });
});
