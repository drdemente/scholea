import { describe, expect, it } from "vitest";
import {
  cronbachAlphaFromVariances,
  from2x2,
  interpretAlpha,
  rocAuc,
  standardizedAlpha,
} from "./diagnostics";

describe("from2x2", () => {
  it("computes the standard accuracy metrics", () => {
    // TP=90, FP=20, FN=10, TN=80.
    const m = from2x2(90, 20, 10, 80);
    expect(m.sensitivity).toBeCloseTo(0.9, 10);
    expect(m.specificity).toBeCloseTo(0.8, 10);
    expect(m.ppv).toBeCloseTo(90 / 110, 6);
    expect(m.npv).toBeCloseTo(80 / 90, 6);
    expect(m.lrPositive).toBeCloseTo(4.5, 6); // 0.9 / 0.2
    expect(m.lrNegative).toBeCloseTo(0.125, 6); // 0.1 / 0.8
    expect(m.accuracy).toBeCloseTo(170 / 200, 6);
  });

  it("returns NaN rather than dividing by zero", () => {
    expect(Number.isNaN(from2x2(0, 0, 0, 0).sensitivity)).toBe(true);
  });
});

describe("rocAuc", () => {
  it("gives 0.5 for the chance diagonal", () => {
    expect(rocAuc([{ fpr: 0, tpr: 0 }, { fpr: 1, tpr: 1 }])).toBeCloseTo(0.5, 10);
  });

  it("gives 1.0 for a perfect classifier", () => {
    expect(rocAuc([{ fpr: 0, tpr: 1 }])).toBeCloseTo(1, 10);
  });

  it("integrates intermediate operating points (trapezoid)", () => {
    // Points (0,0),(0.2,0.8),(1,1): area = 0.2*0.8/2 + 0.8*(0.8+1)/2 = 0.08 + 0.72 = 0.80.
    expect(rocAuc([{ fpr: 0.2, tpr: 0.8 }])).toBeCloseTo(0.8, 6);
  });
});

describe("Cronbach's α", () => {
  it("computes α from item + total variances", () => {
    // k=3, item vars [1,1,1] (Σ=3), total var=6 → 3/2*(1-3/6)=0.75.
    expect(cronbachAlphaFromVariances([1, 1, 1], 6)).toBeCloseTo(0.75, 10);
  });

  it("computes standardized α from k and mean inter-item r", () => {
    // k=10, r̄=0.3 → 3 / 3.7 = 0.8108.
    expect(standardizedAlpha(10, 0.3)).toBeCloseTo(0.810811, 5);
  });

  it("needs at least two items", () => {
    expect(Number.isNaN(cronbachAlphaFromVariances([1], 2))).toBe(true);
    expect(Number.isNaN(standardizedAlpha(1, 0.5))).toBe(true);
  });

  it("interpretAlpha bands follow Nunnally conventions", () => {
    expect(interpretAlpha(0.45)).toBe("Unacceptable");
    expect(interpretAlpha(0.75)).toBe("Acceptable");
    expect(interpretAlpha(0.95)).toBe("Excellent");
  });
});
