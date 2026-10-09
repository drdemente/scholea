/**
 * Authoring helpers — concise, consistent builders for study-type configs.
 * These construct the same data shapes the engine consumes (study/types.ts);
 * they exist only to keep the content files readable. Methodologists edit the
 * configs; these helpers are the vocabulary.
 */
import type {
  Check,
  CheckSeverity,
  FieldSchema,
  GuideBlock,
  GuideContent,
  Level,
} from "./types";

// --- Guide blocks ---------------------------------------------------------
export const para = (text: string): GuideBlock => ({ type: "paragraph", text });
export const tip = (text: string): GuideBlock => ({ type: "tip", text });
export const warn = (text: string): GuideBlock => ({ type: "warning", text });
export const list = (items: string[], ordered = false): GuideBlock => ({ type: "list", items, ordered });
export const example = (text: string, title?: string): GuideBlock => ({ type: "example", text, title });

export const guide = (basic: GuideBlock[], medium?: GuideBlock[], advanced?: GuideBlock[]): GuideContent => ({
  basic,
  ...(medium ? { medium } : {}),
  ...(advanced ? { advanced } : {}),
});

// --- Fields ---------------------------------------------------------------
type FieldOpts = { help?: string; placeholder?: string; required?: boolean; level?: Level };

export const fText = (id: string, label: string, o: FieldOpts = {}): FieldSchema => ({ kind: "text", id, label, ...o });
export const fArea = (id: string, label: string, o: FieldOpts & { rows?: number } = {}): FieldSchema => ({ kind: "textarea", id, label, ...o });
export const fNum = (id: string, label: string, o: FieldOpts & { min?: number; max?: number; step?: number; unit?: string } = {}): FieldSchema => ({ kind: "number", id, label, ...o });
export const fSelect = (id: string, label: string, options: { value: string; label: string }[], o: FieldOpts = {}): FieldSchema => ({ kind: "select", id, label, options, ...o });
export const fTags = (id: string, label: string, o: FieldOpts = {}): FieldSchema => ({ kind: "tags", id, label, ...o });
export const fCheck = (id: string, label: string, o: FieldOpts = {}): FieldSchema => ({ kind: "checkbox", id, label, ...o });

// --- Checks ---------------------------------------------------------------
let checkSeq = 0;
const cid = (kind: string, field: string) => `${kind}-${field}-${checkSeq++}`;

export const required = (field: string, message?: string, severity: CheckSeverity = "error"): Check => ({ id: cid("req", field), kind: "required", field, message, severity });
export const minLen = (field: string, min: number, message?: string): Check => ({ id: cid("len", field), kind: "minLength", field, min, message });
export const minItems = (field: string, min: number, message?: string, severity: CheckSeverity = "error"): Check => ({ id: cid("items", field), kind: "minItems", field, min, message, severity });
export const range = (field: string, bounds: { min?: number; max?: number }, message?: string): Check => ({ id: cid("range", field), kind: "range", field, ...bounds, message });
export const mustCheck = (field: string, message?: string): Check => ({ id: cid("must", field), kind: "mustCheck", field, message });
