/**
 * Study-type config schema — the heart of the pathway engine.
 *
 * A study type is **data, not code**. The engine is methodology-blind: it
 * renders whatever steps a config provides, gates guide content by the user's
 * level, runs validation checks before allowing progress, and persists inputs.
 * Adding or altering a study type requires only config + content — never engine
 * changes. Each type is authored independently from its own reporting guideline.
 */

/** Progressive-disclosure level. Canonical definition lives here; the theme
 *  store re-exports it for UI use. */
export type Level = "basic" | "medium" | "advanced";

export type StudyFamily =
  | "review"
  | "observational"
  | "experimental"
  | "diagnostic"
  | "qualitative"
  | "survey"
  | "mixed"
  | "report";

/** Captured inputs for a single step: fieldId → value. */
export type StepData = Record<string, unknown>;

// --- Guide content (level-gated progressive disclosure) -------------------

export type GuideBlock =
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered?: boolean; items: string[] }
  | { type: "tip"; text: string }
  | { type: "warning"; text: string }
  | { type: "example"; title?: string; text: string };

/**
 * The SAME canonical content, progressively disclosed. `basic` always renders;
 * `medium` adds depth for medium+advanced; `advanced` adds the most for advanced.
 */
export interface GuideContent {
  basic: GuideBlock[];
  medium?: GuideBlock[];
  advanced?: GuideBlock[];
}

/** Just-in-time teaching: a term + definition surfaced as a glossary popover. */
export interface GlossaryEntry {
  term: string;
  definition: string;
}

// --- Inputs (structured data captured at a step) --------------------------

interface FieldBase {
  id: string;
  label: string;
  help?: string;
  placeholder?: string;
  required?: boolean;
  /** Hide this field unless the user is at this level or higher. */
  level?: Level;
}

export type FieldSchema =
  | (FieldBase & { kind: "text" })
  | (FieldBase & { kind: "textarea"; rows?: number })
  | (FieldBase & { kind: "number"; min?: number; max?: number; step?: number; unit?: string })
  | (FieldBase & { kind: "select"; options: { value: string; label: string }[] })
  | (FieldBase & { kind: "tags" })
  | (FieldBase & { kind: "checkbox" });

// --- Validation checks (declarative — pure data, methodologist-editable) ---

export type CheckSeverity = "error" | "warn";

/**
 * Declarative checks so methodologists can review/PR them without touching
 * engine code. `error` blocks progress; `warn` is advisory (flags the step as
 * needs-attention but allows continuing).
 */
export type Check =
  | { id: string; kind: "required"; field: string; message?: string; severity?: CheckSeverity }
  | { id: string; kind: "minLength"; field: string; min: number; message?: string; severity?: CheckSeverity }
  | { id: string; kind: "minItems"; field: string; min: number; message?: string; severity?: CheckSeverity }
  | { id: string; kind: "range"; field: string; min?: number; max?: number; message?: string; severity?: CheckSeverity }
  | { id: string; kind: "mustCheck"; field: string; message?: string; severity?: CheckSeverity };

// --- Optional AI assist (BYO key; provider-agnostic; grounded) ------------

export interface AiTask {
  id: string;
  label: string;
  description?: string;
  /** Template grounded in the user's project data + canonical sources. */
  promptTemplate: string;
}

// --- Step + study-type config --------------------------------------------

/** Family-shared interactive tools a step can mount (screening grid, appraisal
 *  matrix, PRISMA flow, …). The engine resolves these from a registry; the tool
 *  reads/writes the step's data through the project store, so the engine stays
 *  methodology-blind. */
export type ToolId =
  | "search"
  | "dedup"
  | "screening"
  | "appraisal"
  | "synthesis"
  | "prisma"
  | "consort"
  | "diagnostic"
  | "coding"
  | "reliability"
  | "feasibility"
  | "strobeflow"
  | "generalstats"
  | "fulltext"
  | "samplesize";

export interface StepConfig {
  id: string;
  title: string;
  /** 1–3 word label for the compact (mobile) stepper. */
  short?: string;
  subtitle?: string;
  guide: GuideContent;
  glossary?: GlossaryEntry[];
  inputs: FieldSchema[];
  validations: Check[];
  /** Optional rich tool rendered alongside the inputs. */
  tool?: ToolId;
  /** A second tool rendered below the first (e.g. flow diagram + statistics). */
  extraTool?: ToolId;
  optionalAiAssist?: AiTask;
}

export interface StudyTypeConfig {
  id: string;
  label: string;
  family: StudyFamily;
  /** e.g. "PRISMA-2020", "STROBE", "CONSORT". */
  reportingStandard: string;
  steps: StepConfig[];
}
