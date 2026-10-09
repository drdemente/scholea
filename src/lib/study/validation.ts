/**
 * Validation engine — interprets declarative {@link Check}s against a step's
 * captured data. Pure and synchronous, so it's trivially unit-testable and
 * runs anywhere (engine, Pathway Map derivation, tests).
 */
import type { Check, CheckSeverity, StepData } from "./types";

export interface CheckFailure {
  id: string;
  field: string;
  severity: CheckSeverity;
  message: string;
}

function isEmpty(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function rangeMessage(min?: number, max?: number): string {
  if (min != null && max != null) return `Enter a value between ${min} and ${max}.`;
  if (min != null) return `Enter a value of at least ${min}.`;
  if (max != null) return `Enter a value of at most ${max}.`;
  return "Enter a valid number.";
}

/** Run all checks; return only the failures (empty array = step is valid). */
export function runChecks(checks: Check[], data: StepData): CheckFailure[] {
  const failures: CheckFailure[] = [];

  for (const c of checks) {
    const severity = c.severity ?? "error";
    const value = data[c.field];
    let failed = false;
    let message = c.message ?? "";

    switch (c.kind) {
      case "required":
        failed = isEmpty(value);
        message ||= "This field is required.";
        break;
      case "minLength":
        failed = typeof value !== "string" || value.trim().length < c.min;
        message ||= `Enter at least ${c.min} characters.`;
        break;
      case "minItems":
        failed = !Array.isArray(value) || value.length < c.min;
        message ||= `Add at least ${c.min} item${c.min > 1 ? "s" : ""}.`;
        break;
      case "range": {
        const n = typeof value === "number" ? value : Number(value);
        failed =
          isEmpty(value) ||
          Number.isNaN(n) ||
          (c.min != null && n < c.min) ||
          (c.max != null && n > c.max);
        message ||= rangeMessage(c.min, c.max);
        break;
      }
      case "mustCheck":
        failed = value !== true;
        message ||= "Please confirm to continue.";
        break;
    }

    if (failed) failures.push({ id: c.id, field: c.field, severity, message });
  }

  return failures;
}

export const hasErrors = (failures: CheckFailure[]): boolean =>
  failures.some((f) => f.severity === "error");

export const hasWarnings = (failures: CheckFailure[]): boolean =>
  failures.some((f) => f.severity === "warn");

/** First failure (error preferred) for a given field — for inline display. */
export function failureFor(failures: CheckFailure[], field: string): CheckFailure | undefined {
  return (
    failures.find((f) => f.field === field && f.severity === "error") ??
    failures.find((f) => f.field === field)
  );
}
