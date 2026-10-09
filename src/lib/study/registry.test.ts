import { describe, expect, it } from "vitest";
import { STUDY_CONFIGS, configById, configsByFamily } from "./registry";
import type { ToolId } from "./types";

const KNOWN_TOOLS: ToolId[] = [
  "search", "dedup", "screening", "appraisal", "synthesis", "prisma", "consort",
  "diagnostic", "coding", "reliability", "feasibility", "strobeflow", "generalstats",
  "fulltext", "samplesize",
];
/** Fields a tool writes itself (so validations on them need no matching input). */
const TOOL_OUTPUT_FIELDS = new Set([
  "nIdentified", "nDuplicates", "nScreened", "nAppraised", "nIncludedScreening",
  "nRandomised", "nFullTextExcluded",
]);

describe("study-type registry", () => {
  it("has unique study-type ids", () => {
    const ids = STUDY_CONFIGS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every config has a label, reporting standard, and at least 3 steps", () => {
    for (const c of STUDY_CONFIGS) {
      expect(c.label, c.id).toBeTruthy();
      expect(c.reportingStandard, c.id).toBeTruthy();
      expect(c.steps.length, c.id).toBeGreaterThanOrEqual(3);
    }
  });

  it("step ids are unique within each config and every step has basic guide content", () => {
    for (const c of STUDY_CONFIGS) {
      const ids = c.steps.map((s) => s.id);
      expect(new Set(ids).size, `${c.id} step ids`).toBe(ids.length);
      for (const s of c.steps) {
        expect(s.guide.basic.length, `${c.id}/${s.id} guide`).toBeGreaterThan(0);
      }
    }
  });

  it("any tool referenced is a registered tool", () => {
    for (const c of STUDY_CONFIGS) {
      for (const s of c.steps) {
        if (s.tool) expect(KNOWN_TOOLS, `${c.id}/${s.id}`).toContain(s.tool);
        if (s.extraTool) expect(KNOWN_TOOLS, `${c.id}/${s.id} extraTool`).toContain(s.extraTool);
      }
    }
  });

  it("validations on non-tool steps reference an existing input field", () => {
    for (const c of STUDY_CONFIGS) {
      for (const s of c.steps) {
        const inputIds = new Set(s.inputs.map((f) => f.id));
        for (const check of s.validations) {
          const ok = inputIds.has(check.field) || (s.tool && TOOL_OUTPUT_FIELDS.has(check.field));
          expect(ok, `${c.id}/${s.id}: check on "${check.field}" has no matching input`).toBe(true);
        }
      }
    }
  });

  it("configById and family grouping work", () => {
    expect(configById("rct")?.label).toBe("Randomized Controlled Trial");
    expect(configById("nope")).toBeUndefined();
    const families = configsByFamily();
    expect(families.some((f) => f.family === "experimental")).toBe(true);
    // Every config appears in exactly one family group.
    const grouped = families.flatMap((f) => f.configs);
    expect(grouped.length).toBe(STUDY_CONFIGS.length);
  });
});
