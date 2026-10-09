import { describe, expect, it } from "vitest";
import { summarizeContributions, describeAction } from "./collab";
import type { AuditEntry } from "@/lib/db/schema";

const entry = (actor: string, timestamp: number, action = "step.complete"): AuditEntry => ({
  projectId: "p1",
  actor,
  action,
  timestamp,
});

describe("summarizeContributions", () => {
  it("collapses the feed per contributor, busiest first", () => {
    const out = summarizeContributions([
      entry("Dana", 10),
      entry("Dana", 30),
      entry("Sam", 20),
      entry("Dana", 25),
    ]);
    expect(out.map((c) => c.actor)).toEqual(["Dana", "Sam"]);
    expect(out[0]).toMatchObject({ actor: "Dana", count: 3, lastAt: 30 });
    expect(out[1]).toMatchObject({ actor: "Sam", count: 1, lastAt: 20 });
  });

  it("breaks ties by most-recent activity", () => {
    const out = summarizeContributions([entry("A", 5), entry("B", 50)]);
    expect(out.map((c) => c.actor)).toEqual(["B", "A"]);
  });

  it("is empty for no activity", () => {
    expect(summarizeContributions([])).toEqual([]);
  });
});

describe("describeAction", () => {
  it("phrases known actions and falls back gracefully", () => {
    expect(describeAction("review.approve")).toBe("approved a step");
    expect(describeAction("comment.add")).toBe("commented");
    expect(describeAction("something.unknown_code")).toBe("something unknown code");
  });
});
