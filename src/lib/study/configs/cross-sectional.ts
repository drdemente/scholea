import type { StudyTypeConfig } from "../types";
import { fArea, fCheck, fNum, fSelect, fTags, fText, guide, list, minLen, para, range, required, tip, warn } from "../authoring";

/**
 * Cross-sectional study — authored from STROBE (observational reporting) with
 * AXIS appraisal prompts. A primary study: design → variables → sample size →
 * collection → analysis → STROBE report.
 */
export const crossSectional: StudyTypeConfig = {
  id: "cross-sectional",
  label: "Cross-sectional Study",
  family: "observational",
  reportingStandard: "STROBE",
  steps: [
    {
      id: "question",
      title: "Research question & objectives",
      short: "Question",
      subtitle: "Prevalence, or an association measured at one point in time.",
      glossary: [{ term: "Cross-sectional", definition: "Exposure and outcome are measured simultaneously in a sample, giving a snapshot — good for prevalence and associations, but it can’t establish that cause preceded effect." }],
      guide: guide(
        [para("Cross-sectional studies measure variables at a single time point. They’re ideal for prevalence and for hypothesis-generating associations."),
         warn("Because exposure and outcome are measured together, you generally cannot infer temporality or causation.")],
      ),
      inputs: [
        fArea("objective", "Objective(s)", { required: true, rows: 2, placeholder: "To estimate the prevalence of… / To examine the association between…" }),
        fSelect("aimType", "Primary aim", [{ value: "prevalence", label: "Prevalence / descriptive" }, { value: "association", label: "Association / analytic" }], { required: true }),
      ],
      validations: [minLen("objective", 15, "State your objective."), required("aimType")],
    },
    {
      id: "variables",
      title: "Define variables",
      short: "Variables",
      subtitle: "STROBE Item 7: define outcomes, exposures, and confounders.",
      guide: guide(
        [para("Define every variable precisely, including how it’s measured. Distinguish your outcome, your key exposure(s), and potential confounders."),
         tip("Operationalise each variable now (units, cut-offs, instrument) — vague definitions wreck analysis later.")],
      ),
      inputs: [
        fText("outcomeVar", "Outcome variable", { required: true }),
        fTags("exposureVars", "Exposure variable(s)", { placeholder: "Press Enter after each" }),
        fTags("confounders", "Potential confounders", { placeholder: "Press Enter after each" }),
      ],
      validations: [required("outcomeVar", "Define your outcome variable.")],
    },
    {
      id: "sampleSize",
      title: "Sampling & sample size",
      short: "Sample size",
      subtitle: "Justify the number of participants and how you’ll recruit them.",
      tool: "samplesize",
      guide: guide(
        [para("State your sampling frame and method, and justify your target sample size with a calculation."),
         list(["For prevalence: precision-based n from expected prevalence + margin of error", "For associations: power-based n for the smallest effect of interest"])],
        [tip("Scholea’s validated sample-size calculators arrive with the stats workers; record your assumptions here now.")],
      ),
      inputs: [
        fSelect("sampling", "Sampling method", [{ value: "random", label: "Random / probability" }, { value: "consecutive", label: "Consecutive" }, { value: "convenience", label: "Convenience" }], { required: true }),
        fNum("targetN", "Target sample size", { required: true, min: 1 }),
        fArea("ssJustification", "Sample-size justification", { rows: 3, level: "medium" }),
      ],
      validations: [required("sampling"), range("targetN", { min: 1 }, "Enter your target sample size.")],
    },
    {
      id: "collection",
      title: "Data collection & ethics",
      short: "Collection",
      subtitle: "Instruments, bias control, and ethical approval.",
      guide: guide(
        [para("Describe your instruments and procedures, and how you’ll minimise selection and information bias (AXIS prompts)."),
         warn("Primary data collection needs ethics/IRB approval and informed consent before you start.")],
      ),
      inputs: [
        fArea("instruments", "Instruments / data sources", { required: true, rows: 3 }),
        fCheck("ethics", "Ethics/IRB approval obtained (or in progress)"),
      ],
      validations: [minLen("instruments", 15, "Describe your data-collection instruments.")],
    },
    {
      id: "analysis",
      title: "Analysis plan",
      short: "Analysis",
      subtitle: "Descriptives, then associations with confounder adjustment.",
      tool: "strobeflow",
      extraTool: "generalstats",
      guide: guide(
        [para("Plan descriptive statistics first, then your association analysis (e.g. prevalence ratios, or logistic/linear regression adjusting for confounders)."),
         tip("Pre-specify which confounders enter the model and why — post-hoc model fishing inflates false positives.")],
      ),
      inputs: [fArea("analysisPlan", "Statistical analysis plan", { required: true, rows: 4 })],
      validations: [minLen("analysisPlan", 20, "Outline your analysis plan.")],
    },
    {
      id: "report",
      title: "STROBE report & export",
      short: "Report",
      subtitle: "Report against the STROBE cross-sectional checklist.",
      guide: guide([para("Write up against STROBE, including a participant flow and a table of characteristics."), warn("Label AI-assisted text as a structured draft, never ‘ready to submit.’")]),
      inputs: [fCheck("strobe", "Checked against the STROBE checklist")],
      validations: [],
    },
  ],
};
