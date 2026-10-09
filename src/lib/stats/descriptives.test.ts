import { describe, expect, it } from "vitest";
import { descriptives } from "./descriptives";

describe("descriptives", () => {
  it("matches the canonical reference dataset [2,4,4,4,5,5,7,9]", () => {
    // Reference: mean 5, sample SD ≈ 2.13809 (population SD = 2).
    const d = descriptives([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(d.n).toBe(8);
    expect(d.mean).toBe(5);
    expect(d.sd).toBeCloseTo(2.13809, 4);
    expect(d.min).toBe(2);
    expect(d.max).toBe(9);
  });

  it("uses Bessel's correction (n − 1)", () => {
    // For [1, 3]: mean 2, sample variance = ((1)+(1))/1 = 2, sd = √2.
    const d = descriptives([1, 3]);
    expect(d.sd).toBeCloseTo(Math.SQRT2, 10);
  });

  it("handles empty and singleton inputs without throwing", () => {
    expect(descriptives([]).n).toBe(0);
    const one = descriptives([7]);
    expect(one.mean).toBe(7);
    expect(one.sd).toBe(0);
  });
});
