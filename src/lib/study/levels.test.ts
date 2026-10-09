import { describe, expect, it } from "vitest";
import { atLeast, levelRank } from "./levels";

describe("level gating", () => {
  it("ranks basic < medium < advanced", () => {
    expect(levelRank.basic).toBeLessThan(levelRank.medium);
    expect(levelRank.medium).toBeLessThan(levelRank.advanced);
  });

  it("atLeast is true when current meets or exceeds required", () => {
    expect(atLeast("advanced", "medium")).toBe(true);
    expect(atLeast("medium", "medium")).toBe(true);
    expect(atLeast("basic", "medium")).toBe(false);
  });

  it("atLeast with no requirement is always true", () => {
    expect(atLeast("basic")).toBe(true);
  });
});
