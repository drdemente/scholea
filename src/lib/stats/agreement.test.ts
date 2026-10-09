import { describe, expect, it } from "vitest";
import { cohenKappa, interpretKappa } from "./agreement";

describe("cohenKappa", () => {
  it("matches the canonical Wikipedia 2x2 example (κ = 0.4)", () => {
    // 50 items: both yes = 20, both no = 15, A yes/B no = 5, A no/B yes = 10.
    const pairs: Array<[string, string]> = [
      ...Array.from({ length: 20 }, () => ["yes", "yes"] as [string, string]),
      ...Array.from({ length: 15 }, () => ["no", "no"] as [string, string]),
      ...Array.from({ length: 5 }, () => ["yes", "no"] as [string, string]),
      ...Array.from({ length: 10 }, () => ["no", "yes"] as [string, string]),
    ];
    const r = cohenKappa(pairs);
    expect(r.n).toBe(50);
    expect(r.observed).toBeCloseTo(0.7, 10);
    expect(r.kappa).toBeCloseTo(0.4, 4);
  });

  it("returns κ = 1 for perfect agreement", () => {
    const r = cohenKappa([
      ["include", "include"],
      ["exclude", "exclude"],
      ["include", "include"],
    ]);
    expect(r.kappa).toBe(1);
  });

  it("returns null kappa when there is no data", () => {
    expect(cohenKappa([]).kappa).toBeNull();
  });

  it("handles single-category degenerate margins (all agree on one label)", () => {
    const r = cohenKappa([
      ["include", "include"],
      ["include", "include"],
    ]);
    expect(r.kappa).toBe(1);
    expect(r.observed).toBe(1);
  });

  it("gives negative kappa for systematic disagreement", () => {
    const r = cohenKappa([
      ["include", "exclude"],
      ["exclude", "include"],
      ["include", "exclude"],
      ["exclude", "include"],
    ]);
    expect(r.kappa).toBeLessThan(0);
  });

  it("interpretKappa bands follow Landis & Koch", () => {
    expect(interpretKappa(-0.1)).toMatch(/Poor/);
    expect(interpretKappa(0.1)).toBe("Slight");
    expect(interpretKappa(0.5)).toBe("Moderate");
    expect(interpretKappa(0.9)).toBe("Almost perfect");
  });
});
