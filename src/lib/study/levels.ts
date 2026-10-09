import type { Level } from "./types";

/** Ordinal rank for progressive disclosure. */
export const levelRank: Record<Level, number> = { basic: 0, medium: 1, advanced: 2 };

/** True when `current` meets or exceeds the `required` level (undefined = always). */
export function atLeast(current: Level, required?: Level): boolean {
  return required ? levelRank[current] >= levelRank[required] : true;
}
