/**
 * Grounded prompt construction for the AI guidance layer. Prompts are built from
 * the step's optional AiTask template + the project's captured data, with a
 * system prompt that enforces grounding and honesty (§8: "always grounded in
 * the user's project data + canonical sources"; output is a draft, not final).
 */
import type { AiTask, StepData } from "@/lib/study/types";

/** Replace {field} placeholders with values from the step's data. */
export function interpolate(template: string, data: StepData): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = data[key];
    if (v == null || v === "") return "(not provided)";
    if (Array.isArray(v)) return v.join(", ");
    return String(v);
  });
}

export const AI_SYSTEM_PROMPT =
  "You are Scholea, a careful research mentor. Ground every statement strictly in the project data the user provides and in canonical methodology (Cochrane Handbook, JBI, PRISMA 2020 and its extensions, EQUATOR, GRADE). " +
  "Produce a concise structured draft, never final submission-ready text. Flag anything uncertain or missing rather than inventing it. Do not fabricate citations, data, or results. Teach the reasoning; don't ghostwrite.";

export interface GroundedPrompt {
  system: string;
  user: string;
}

export function buildAssistPrompt(task: AiTask, studyLabel: string, stepData: StepData): GroundedPrompt {
  const filled = interpolate(task.promptTemplate, stepData);
  const user =
    `Study type: ${studyLabel}\n\n` +
    `${filled}\n\n` +
    "Use only the information above. Where something is marked “(not provided)” or is missing, say so explicitly instead of guessing. " +
    "Return a short, structured draft the researcher will review and verify — not finished text.";
  return { system: AI_SYSTEM_PROMPT, user };
}

/** Context for writing (or refining) the content of a single form field. */
export interface FieldAssistContext {
  studyLabel: string;
  standard: string;
  stepTitle: string;
  stepSubtitle?: string;
  fieldLabel: string;
  fieldHelp?: string;
  placeholder?: string;
  /** True for multi-line (textarea) fields; false for single-line text / tags. */
  multiline: boolean;
  /** True for keyword tag fields — the model should return comma-separated items. */
  tags?: boolean;
  /** The researcher's current draft in this field (may be empty). */
  current: string;
  /** A formatted summary of what the researcher has entered elsewhere in the step. */
  siblings: string;
}

/**
 * Build a grounded prompt that writes ONLY the text for one specific field, in
 * context of the field's purpose, the step, and the whole project. The model is
 * told to return the field content alone (no labels, quotes, or commentary) so
 * the result can be dropped straight into the input.
 */
export function buildFieldAssistPrompt(ctx: FieldAssistContext): GroundedPrompt {
  const lengthHint = ctx.tags
    ? "Return 3–6 short items as a single comma-separated line (no numbering, no sentences)."
    : ctx.multiline
      ? "Write a focused draft of two to five sentences (short bullet-style lines are fine if the field calls for a list)."
      : "Write a single concise line of about 10–25 words.";

  const user =
    "You are helping a researcher write ONE field of their study in Scholea. Write the content that belongs in this field.\n\n" +
    `• Study type: ${ctx.studyLabel} (reporting standard: ${ctx.standard}).\n` +
    `• Current step: ${ctx.stepTitle}${ctx.stepSubtitle ? " — " + ctx.stepSubtitle : ""}.\n` +
    `• Field to write: "${ctx.fieldLabel}".` +
    (ctx.fieldHelp ? ` Field guidance: ${ctx.fieldHelp}.` : "") +
    (ctx.placeholder ? ` Example of the expected format: "${ctx.placeholder}".` : "") +
    "\n\n" +
    `What the researcher has already entered in this step:\n${ctx.siblings || "(nothing yet)"}\n\n` +
    (ctx.current ? `Their current draft for this field — improve and tighten it rather than discarding their intent:\n${ctx.current}\n\n` : "") +
    `${lengthHint}\n\n` +
    "Ground it strictly in the information above and in standard methodology for this study type and reporting standard. " +
    "If essential specifics are missing (a number, a name, a setting), write a clearly editable generic placeholder — never invent data, results, or citations. " +
    "Return ONLY the text that should go in the field: no field name, no surrounding quotation marks, no preamble, no markdown.";

  return { system: AI_SYSTEM_PROMPT, user };
}
