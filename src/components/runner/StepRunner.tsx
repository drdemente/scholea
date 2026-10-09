import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Info, Lock, RotateCcw, Sparkles } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { Field, type FieldAssist } from "@/components/form/fields";
import { GuideContent } from "./GuideContent";
import { ToolHost } from "./tools";
import { StepCollab } from "./StepCollab";
import { GlossaryPopover } from "@/components/teaching/GlossaryPopover";
import { useProject } from "@/lib/study/project-store";
import { useTheme } from "@/lib/theme/theme-store";
import { useSettings } from "@/lib/settings/settings-store";
import { useUI } from "@/lib/ui-store";
import { generateText } from "@/lib/ai/client";
import { buildAssistPrompt, buildFieldAssistPrompt } from "@/lib/ai/prompts";
import { atLeast } from "@/lib/study/levels";
import { failureFor, hasErrors, runChecks } from "@/lib/study/validation";
import { reducedFade, stepEnter, withReduced } from "@/lib/motion";
import type { FieldSchema, StudyTypeConfig } from "@/lib/study/types";

/**
 * The generic, methodology-blind step-runner. It renders whatever the active
 * step's config provides — level-gated guide, structured inputs, validation —
 * and gates progress on the validation engine. It contains no study-type
 * knowledge: swapping `config` swaps the entire pathway.
 */
export function StepRunner({ config }: { config: StudyTypeConfig }) {
  const prefersReduced = useReducedMotion() ?? false;
  const level = useTheme((s) => s.level);

  const activeStepId = useProject((s) => s.activeStepId);
  const project = useProject((s) => s.project);
  const setField = useProject((s) => s.setField);
  const persist = useProject((s) => s.persist);
  const markComplete = useProject((s) => s.markComplete);
  const setActiveStep = useProject((s) => s.setActiveStep);
  const resetStep = useProject((s) => s.resetStep);
  const settings = useSettings();
  const openSettings = useUI((s) => s.openSettings);
  const [assist, setAssist] = useState<{ loading: boolean; text: string; error: string | null } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  // Bumped on reset so the step (and its tools) remount and re-derive fresh.
  const [resetNonce, setResetNonce] = useState(0);

  const stepIndex = config.steps.findIndex((s) => s.id === activeStepId);
  const step = config.steps[stepIndex];

  // Directional transition between steps.
  const lastIndex = useRef(stepIndex);
  const dir: 1 | -1 = stepIndex >= lastIndex.current ? 1 : -1;
  useEffect(() => {
    lastIndex.current = stepIndex;
  }, [stepIndex]);

  // Per-step interaction state.
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  useEffect(() => {
    setTouched({});
    setSubmitAttempted(false);
    setAssist(null);
    setConfirmReset(false);
  }, [activeStepId]);

  const doReset = async () => {
    if (!step) return;
    await resetStep(step.id);
    setTouched({});
    setSubmitAttempted(false);
    setAssist(null);
    setConfirmReset(false);
    setResetNonce((n) => n + 1);
  };

  const hasLlm = settings.hasLlm();
  const runAssist = async () => {
    if (!step?.optionalAiAssist) return;
    if (!hasLlm) {
      openSettings();
      return;
    }
    setAssist({ loading: true, text: "", error: null });
    try {
      const { system, user } = buildAssistPrompt(step.optionalAiAssist, config.label, data);
      const out = await generateText(system, user, {
        provider: settings.llmProvider,
        apiKey: settings.llmKey,
        model: settings.llmModel,
        baseUrl: settings.llmBaseUrl,
      });
      setAssist({ loading: false, text: out, error: null });
    } catch (e) {
      setAssist({ loading: false, text: "", error: e instanceof Error ? e.message : "AI request failed." });
    }
  };

  if (!project || !step) return null;

  const data = (project.stepData[step.id] as Record<string, unknown>) ?? {};
  const visibleFields = step.inputs.filter((f) => atLeast(level, f.level));

  // Summarise the step's other answers so per-field AI drafts are in context.
  const fieldSiblings = (exceptId: string) =>
    step.inputs
      .filter((f) => f.id !== exceptId)
      .map((f) => {
        const v = data[f.id];
        const s = Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v);
        return s ? `- ${f.label}: ${s}` : null;
      })
      .filter(Boolean)
      .join("\n");

  // Contextual AI writing help for every text box (BYO key; a draft to verify).
  const fieldAssist: FieldAssist = {
    enabled: hasLlm,
    run: async (f, current) => {
      const meta = f as FieldSchema & { help?: string; placeholder?: string };
      const { system, user } = buildFieldAssistPrompt({
        studyLabel: config.label,
        standard: config.reportingStandard,
        stepTitle: step.title,
        stepSubtitle: step.subtitle,
        fieldLabel: f.label,
        fieldHelp: meta.help,
        placeholder: meta.placeholder,
        multiline: f.kind === "textarea",
        tags: f.kind === "tags",
        current,
        siblings: fieldSiblings(f.id),
      });
      return generateText(system, user, {
        provider: settings.llmProvider,
        apiKey: settings.llmKey,
        model: settings.llmModel,
        baseUrl: settings.llmBaseUrl,
      });
    },
  };
  const failures = runChecks(step.validations, data);
  const blocking = hasErrors(failures);
  const errorFailures = failures.filter((f) => f.severity === "error");
  const warnFailures = failures.filter((f) => f.severity === "warn");

  const showFieldError = (fieldId: string) =>
    touched[fieldId] || submitAttempted ? failureFor(failures, fieldId)?.message : undefined;

  const isLast = stepIndex === config.steps.length - 1;
  const completed = project.stepStatus[step.id]?.complete ?? false;
  // Offer a reset only once the step has captured something to reset.
  const hasStepData = Object.keys(data).length > 0 || completed;

  const goTo = (index: number) => {
    const target = config.steps[index];
    if (!target) return;
    void persist();
    setActiveStep(target.id);
  };

  const onContinue = async () => {
    if (blocking) {
      setSubmitAttempted(true);
      const first = errorFailures[0];
      if (first) document.getElementById(first.field)?.focus();
      return;
    }
    await persist();
    await markComplete(step.id, config.steps[stepIndex + 1]?.id);
  };

  return (
    <AnimatePresence mode="wait" custom={dir}>
      <motion.section
        key={`${step.id}:${resetNonce}`}
        variants={withReduced(stepEnter(dir), reducedFade, prefersReduced)}
        initial="hidden"
        animate="visible"
        exit="exit"
        className="glass-1 glass-highlight flex flex-col gap-5 p-5 sm:p-6"
        aria-labelledby="step-title"
      >
        {/* Header */}
        <div>
          <div className="flex items-center justify-between gap-3">
            <p className="num-tabular text-sm font-medium text-primary">
              Step {String(stepIndex + 1).padStart(2, "0")} of {config.steps.length}
            </p>
            <div className="flex items-center gap-3">
              {completed && (
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-success">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Completed
                </span>
              )}
              {hasStepData &&
                (confirmReset ? (
                  <span className="inline-flex items-center gap-2 text-xs">
                    <span className="text-ink-soft">Reset this step? This clears its data.</span>
                    <button
                      onClick={doReset}
                      className="font-semibold text-danger hover:underline focus-visible:focus-ring"
                    >
                      Reset
                    </button>
                    <button
                      onClick={() => setConfirmReset(false)}
                      className="text-ink-muted hover:underline focus-visible:focus-ring"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => setConfirmReset(true)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-ink-muted hover:text-danger focus-visible:focus-ring"
                    title="Clear this step's data and start it over (later steps re-read from earlier ones)"
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                    Reset step
                  </button>
                ))}
            </div>
          </div>
          <h2 id="step-title" className="mt-1 text-xl font-bold text-ink">
            {step.title}
          </h2>
          {step.subtitle && <p className="mt-1 max-w-prose text-ink-soft">{step.subtitle}</p>}
        </div>

        {/* Glossary chips (just-in-time teaching) */}
        {step.glossary && step.glossary.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-ink-muted">Key terms:</span>
            {step.glossary.map((g) => (
              <GlossaryPopover key={g.term} term={g.term} definition={g.definition} />
            ))}
          </div>
        )}

        {/* Level-gated guide */}
        <GuideContent guide={step.guide} level={level} />

        {/* Rich tool (screening grid, appraisal matrix, PRISMA flow, …) */}
        {step.tool && (
          <div className="border-t border-hairline pt-5">
            <ToolHost tool={step.tool} stepId={step.id} />
          </div>
        )}

        {/* Companion tool (e.g. a flow diagram plus the statistics workspace) */}
        {step.extraTool && (
          <div className="border-t border-hairline pt-5">
            <ToolHost tool={step.extraTool} stepId={step.id} />
          </div>
        )}

        {/* Inputs */}
        {visibleFields.length > 0 && (
          <div className="flex flex-col gap-4 border-t border-hairline pt-5">
            {visibleFields.map((f) => (
              <Field
                key={f.id}
                field={f}
                value={data[f.id]}
                error={showFieldError(f.id)}
                assist={fieldAssist}
                onChange={(v) => setField(step.id, f.id, v)}
                onBlur={() => {
                  setTouched((t) => ({ ...t, [f.id]: true }));
                  void persist();
                }}
              />
            ))}
          </div>
        )}

        {/* Validation banner */}
        <div aria-live="polite">
          {blocking ? (
            <div className="rounded-input bg-danger-soft p-3 text-sm">
              <p className="flex items-center gap-2 font-semibold text-ink">
                <AlertTriangle className="h-4 w-4 text-danger" aria-hidden="true" />
                {errorFailures.length} {errorFailures.length === 1 ? "check needs" : "checks need"} attention
              </p>
              <ul className="mt-2 flex flex-col gap-1">
                {errorFailures.map((f) => (
                  <li key={f.id}>
                    <button
                      onClick={() => document.getElementById(f.field)?.focus()}
                      className="text-left text-ink-soft underline decoration-dotted underline-offset-2 hover:text-ink focus-visible:focus-ring"
                    >
                      {f.message}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : warnFailures.length > 0 ? (
            <div className="flex items-start gap-2.5 rounded-input bg-warning-soft p-3 text-sm text-ink">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
              <span>{warnFailures.map((f) => f.message).join(" ")} You can still continue.</span>
            </div>
          ) : (
            <div className="flex items-start gap-2.5 rounded-input bg-info-soft p-3 text-sm text-ink">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden="true" />
              <span>All automated checks pass — you’re ready to continue when you are.</span>
            </div>
          )}
        </div>

        {/* AI assist result (optional, BYO key — a draft to verify) */}
        {assist && (
          <div className="rounded-input border border-hairline bg-accent-soft/40 p-3">
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-accent">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              AI draft — grounded in your data, but review and verify before using
            </p>
            {assist.loading && <p className="text-sm text-ink-soft">Thinking…</p>}
            {assist.error && (
              <p role="alert" className="text-sm font-medium text-danger">{assist.error}</p>
            )}
            {assist.text && (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{assist.text}</p>
            )}
          </div>
        )}

        {/* Footer actions */}
        <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-4">
          <GlassButton
            variant="ghost"
            onClick={() => goTo(stepIndex - 1)}
            disabled={stepIndex === 0}
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back
          </GlassButton>

          {step.optionalAiAssist && (
            <GlassButton
              variant="soft"
              onClick={runAssist}
              loading={assist?.loading}
              title={hasLlm ? "Grounded in your data — produces a draft to verify" : "Add an LLM key in Settings to enable AI assistance"}
            >
              {!assist?.loading && <Sparkles className="h-4 w-4" aria-hidden="true" />}
              {step.optionalAiAssist.label}
            </GlassButton>
          )}

          <div className="ml-auto flex items-center gap-2">
            {blocking && (
              <span className="hidden items-center gap-1 text-xs text-ink-muted sm:inline-flex">
                <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                Resolve checks to continue
              </span>
            )}
            <GlassButton onClick={onContinue} aria-disabled={blocking}>
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              {isLast ? "Mark complete" : "Mark complete & continue"}
              {!isLast && <ArrowRight className="h-4 w-4" aria-hidden="true" />}
            </GlassButton>
          </div>
        </div>

        {/* Per-step discussion + supervisor review */}
        <StepCollab projectId={project.id} stepId={step.id} />
      </motion.section>
    </AnimatePresence>
  );
}
