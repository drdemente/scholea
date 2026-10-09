import { describe, expect, it } from "vitest";
import { rowsToEffects, synthesisMode, type SynthRow } from "./synthesis";
import type { Project } from "@/lib/db/schema";

function project(stepData: Project["stepData"]): Project {
  return { id: "p", title: "T", studyType: "systematic-review", stepData, stepStatus: {}, createdAt: 0, updatedAt: 0 };
}

describe("synthesisMode", () => {
  it("reads a meta-analysis effect measure (OR/RR/SMD/MD)", () => {
    expect(synthesisMode(project({ question: { measure: "OR" } }))).toEqual({ dichotomous: true, measure: "OR" });
    expect(synthesisMode(project({ question: { measure: "RR" } }))).toEqual({ dichotomous: true, measure: "RR" });
    expect(synthesisMode(project({ question: { measure: "MD" } }))).toEqual({ dichotomous: false, measure: "MD" });
    expect(synthesisMode(project({ question: { measure: "SMD" } }))).toEqual({ dichotomous: false, measure: "SMD" });
  });
  it("reads a systematic review's data-extraction outcome type", () => {
    expect(synthesisMode(project({ extraction: { outcomeType: "dichotomous" } }))).toEqual({ dichotomous: true, measure: "RR" });
    expect(synthesisMode(project({ extraction: { outcomeType: "continuous" } }))).toEqual({ dichotomous: false, measure: "SMD" });
    expect(synthesisMode(project({}))).toEqual({ dichotomous: false, measure: "SMD" });
  });
});

describe("rowsToEffects", () => {
  it("builds SMD effects from continuous rows and drops invalid ones", () => {
    const rows: SynthRow[] = [
      { id: "a", label: "A", m1: "10", sd1: "2", n1: "20", m2: "8", sd2: "2", n2: "20" },
      { id: "b", label: "B", m1: "10", sd1: "0", n1: "20", m2: "8", sd2: "2", n2: "20" }, // sd=0 → dropped
      { id: "c", label: "C", m1: "", sd1: "", n1: "", m2: "", sd2: "", n2: "" }, // empty → dropped
    ];
    const e = rowsToEffects(rows, { dichotomous: false, measure: "SMD" });
    expect(e.map((x) => x.id)).toEqual(["a"]);
    expect(e[0].yi).toBeCloseTo(0.98013, 4); // matches smdFromGroups reference
  });

  it("builds raw mean differences when measure is MD", () => {
    const e = rowsToEffects([{ id: "a", label: "A", m1: "10", sd1: "2", n1: "20", m2: "8", sd2: "3", n2: "25" }], { dichotomous: false, measure: "MD" });
    expect(e[0].yi).toBeCloseTo(2, 10);
    expect(e[0].vi).toBeCloseTo(0.56, 10);
  });

  it("builds log-RR / log-OR effects from dichotomous rows and validates cells", () => {
    const rows: SynthRow[] = [
      { id: "a", label: "A", ev1: "10", tot1: "100", ev2: "20", tot2: "100" },
      { id: "b", label: "B", ev1: "30", tot1: "20", ev2: "10", tot2: "100" }, // events > total → dropped
    ];
    const rr = rowsToEffects(rows, { dichotomous: true, measure: "RR" });
    expect(rr.map((x) => x.id)).toEqual(["a"]);
    expect(rr[0].yi).toBeCloseTo(Math.log(0.5), 5);
    const or = rowsToEffects([rows[0]], { dichotomous: true, measure: "OR" });
    expect(or[0].yi).toBeCloseTo(Math.log((10 * 80) / (90 * 20)), 5);
  });
});
