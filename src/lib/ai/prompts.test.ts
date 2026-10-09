import { describe, expect, it } from "vitest";
import { buildAssistPrompt, interpolate } from "./prompts";
import type { AiTask } from "@/lib/study/types";

describe("interpolate", () => {
  it("substitutes placeholders from step data", () => {
    expect(interpolate("Pop: {population}, Int: {intervention}", { population: "students", intervention: "mindfulness" }))
      .toBe("Pop: students, Int: mindfulness");
  });
  it("marks missing values rather than leaving blanks", () => {
    expect(interpolate("Comparator: {comparator}", {})).toBe("Comparator: (not provided)");
  });
  it("joins array values", () => {
    expect(interpolate("DBs: {databases}", { databases: ["PubMed", "Crossref"] })).toBe("DBs: PubMed, Crossref");
  });
});

describe("buildAssistPrompt", () => {
  const task: AiTask = { id: "t", label: "Refine", promptTemplate: "Refine: P={population}, I={intervention}." };

  it("grounds the prompt in the study label + interpolated data and forbids invention", () => {
    const { system, user } = buildAssistPrompt(task, "Systematic Review", { population: "students", intervention: "mindfulness" });
    expect(system).toMatch(/Ground every statement/);
    expect(system).toMatch(/never final/i);
    expect(user).toContain("Systematic Review");
    expect(user).toContain("P=students, I=mindfulness");
    expect(user).toMatch(/say so explicitly instead of guessing/);
  });
});
