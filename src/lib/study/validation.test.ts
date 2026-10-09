import { describe, expect, it } from "vitest";
import { failureFor, hasErrors, hasWarnings, runChecks } from "./validation";
import type { Check } from "./types";

describe("validation engine", () => {
  it("flags required fields that are empty (null, '', or [])", () => {
    const checks: Check[] = [{ id: "r", kind: "required", field: "name" }];
    expect(runChecks(checks, {})).toHaveLength(1);
    expect(runChecks(checks, { name: "" })).toHaveLength(1);
    expect(runChecks(checks, { name: "  " })).toHaveLength(1);
    expect(runChecks(checks, { name: [] })).toHaveLength(1);
    expect(runChecks(checks, { name: "ok" })).toHaveLength(0);
  });

  it("enforces minLength on trimmed strings", () => {
    const checks: Check[] = [{ id: "m", kind: "minLength", field: "q", min: 5 }];
    expect(runChecks(checks, { q: "abc" })).toHaveLength(1);
    expect(runChecks(checks, { q: "abcde" })).toHaveLength(0);
  });

  it("enforces minItems on arrays", () => {
    const checks: Check[] = [{ id: "i", kind: "minItems", field: "tags", min: 2 }];
    expect(runChecks(checks, { tags: ["a"] })).toHaveLength(1);
    expect(runChecks(checks, { tags: ["a", "b"] })).toHaveLength(0);
  });

  it("enforces numeric range and rejects non-numbers", () => {
    const checks: Check[] = [{ id: "n", kind: "range", field: "n", min: 0, max: 10 }];
    expect(runChecks(checks, { n: -1 })).toHaveLength(1);
    expect(runChecks(checks, { n: 11 })).toHaveLength(1);
    expect(runChecks(checks, { n: "" })).toHaveLength(1);
    expect(runChecks(checks, { n: 5 })).toHaveLength(0);
    expect(runChecks(checks, { n: 0 })).toHaveLength(0);
  });

  it("mustCheck requires a true value (booleans)", () => {
    const checks: Check[] = [{ id: "c", kind: "mustCheck", field: "agree" }];
    expect(runChecks(checks, {})).toHaveLength(1);
    expect(runChecks(checks, { agree: false })).toHaveLength(1);
    expect(runChecks(checks, { agree: true })).toHaveLength(0);
  });

  it("distinguishes errors from warnings", () => {
    const checks: Check[] = [
      { id: "e", kind: "required", field: "a" },
      { id: "w", kind: "required", field: "b", severity: "warn" },
    ];
    const failures = runChecks(checks, {});
    expect(failures).toHaveLength(2);
    expect(hasErrors(failures)).toBe(true);
    expect(hasWarnings(failures)).toBe(true);
  });

  it("warnings alone do not block (no errors)", () => {
    const checks: Check[] = [{ id: "w", kind: "required", field: "b", severity: "warn" }];
    expect(hasErrors(runChecks(checks, {}))).toBe(false);
  });

  it("failureFor prefers an error over a warning on the same field", () => {
    const checks: Check[] = [
      { id: "w", kind: "required", field: "x", severity: "warn", message: "soft" },
      { id: "e", kind: "minLength", field: "x", min: 3, message: "hard" },
    ];
    const f = failureFor(runChecks(checks, { x: "" }), "x");
    expect(f?.severity).toBe("error");
    expect(f?.message).toBe("hard");
  });
});
