import { describe, expect, it } from "vitest";
import { derivePathway } from "./pathway";
import type { Check, StepConfig, StudyTypeConfig } from "./types";
import type { Project } from "@/lib/db/schema";

function mkStep(id: string, validations: Check[] = []): StepConfig {
  return { id, title: id, short: id, guide: { basic: [] }, inputs: [], validations };
}

const config: StudyTypeConfig = {
  id: "test",
  label: "Test",
  family: "review",
  reportingStandard: "NONE",
  steps: [
    mkStep("s1"),
    mkStep("s2", [{ id: "req", kind: "required", field: "title" }]),
    mkStep("s3"),
    mkStep("s4"),
    mkStep("s5"),
  ],
};

function mkProject(over: Partial<Project>): Project {
  return {
    id: "p",
    title: "p",
    studyType: "systematic-review",
    stepData: {},
    stepStatus: {},
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe("derivePathway", () => {
  it("assigns all five states correctly", () => {
    const project = mkProject({
      stepStatus: {
        s1: { complete: true, needsAttention: false },
        s2: { complete: true, needsAttention: false },
      },
      stepData: { s2: {} }, // s2's required check fails → needs-attention
    });

    const states = Object.fromEntries(
      derivePathway(config, project, "s3").map((s) => [s.id, s.state]),
    );

    expect(states.s1).toBe("complete"); // completed, no failing checks
    expect(states.s2).toBe("needs-attention"); // completed but a check now fails
    expect(states.s3).toBe("active"); // the active step
    expect(states.s4).toBe("available"); // next reachable step
    expect(states.s5).toBe("locked"); // beyond the unlocked frontier
  });

  it("keeps later steps locked until prior progress unlocks them", () => {
    const fresh = mkProject({});
    const states = derivePathway(config, fresh, "s1");
    expect(states[0].state).toBe("active");
    expect(states[1].state).toBe("available");
    expect(states[2].state).toBe("locked");
  });

  it("carries the 1-based index and short label through", () => {
    const steps = derivePathway(config, mkProject({}), "s1");
    expect(steps[0]).toMatchObject({ index: 1, short: "s1" });
    expect(steps[4]).toMatchObject({ index: 5 });
  });
});
