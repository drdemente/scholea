import type { StudyTypeConfig } from "../types";
import { fArea, fCheck, fSelect, fText, guide, list, minLen, para, required, tip, warn } from "../authoring";

/**
 * Case-control study — authored from STROBE with Newcastle-Ottawa appraisal
 * prompts. Compares prior exposure in people with the outcome (cases) vs without
 * (controls); the effect measure is the odds ratio.
 */
export const caseControl: StudyTypeConfig = {
  id: "case-control",
  label: "Case-control Study",
  family: "observational",
  reportingStandard: "STROBE",
  steps: [
    {
      id: "question",
      title: "Question & rationale",
      short: "Question",
      subtitle: "Efficient for rare outcomes — work backwards from outcome to exposure.",
      glossary: [{ term: "Case-control", definition: "Starts from outcome status (cases vs controls) and looks back at exposure. Efficient for rare outcomes; yields an odds ratio, and is prone to selection and recall bias." }],
      guide: guide(
        [para("Case-control studies start from the outcome and compare past exposure between cases and controls — efficient when the outcome is rare."),
         warn("They’re especially vulnerable to selection bias (how controls are chosen) and recall bias (how exposure is remembered). Design against both.")],
      ),
      inputs: [fArea("objective", "Objective", { required: true, rows: 2 })],
      validations: [minLen("objective", 15, "State your objective.")],
    },
    {
      id: "casesControls",
      title: "Define cases & controls",
      short: "Cases",
      subtitle: "STROBE Item 6: case definition, control source, matching.",
      extraTool: "samplesize",
      guide: guide(
        [para("Define cases with an explicit diagnostic rule, and choose controls from the same source population that gave rise to the cases."),
         list(["Case definition + source", "Control source + selection", "Matching variables (if any) and ratio"])],
        [tip("If you match, you must analyse the matching (conditional logistic regression) — matched data analysed as unmatched biases the estimate.")],
      ),
      inputs: [
        fArea("caseDef", "Case definition & source", { required: true, rows: 2 }),
        fArea("controlDef", "Control definition & source", { required: true, rows: 2 }),
        fSelect("matching", "Matching", [{ value: "none", label: "Unmatched" }, { value: "individual", label: "Individually matched" }, { value: "frequency", label: "Frequency matched" }], { required: true }),
      ],
      validations: [minLen("caseDef", 15, "Define your cases."), minLen("controlDef", 15, "Define your controls."), required("matching")],
    },
    {
      id: "exposure",
      title: "Exposure measurement",
      short: "Exposure",
      subtitle: "Measure exposure the same way in cases and controls.",
      guide: guide(
        [para("Define the exposure and ascertain it identically in both groups, ideally blinded to case/control status to limit information bias."),
         tip("Pre-register exposure definitions and use objective sources (records, biomarkers) over recall where possible.")],
      ),
      inputs: [
        fText("exposure", "Exposure", { required: true }),
        fArea("ascertainment", "How is exposure ascertained (both groups)?", { required: true, rows: 2 }),
      ],
      validations: [required("exposure"), minLen("ascertainment", 15, "Describe exposure ascertainment.")],
    },
    {
      id: "analysis",
      title: "Analysis plan",
      short: "Analysis",
      subtitle: "Odds ratios with confounder adjustment.",
      tool: "strobeflow",
      extraTool: "generalstats",
      guide: guide(
        [para("Plan odds ratios with confidence intervals; adjust for confounders with logistic regression (conditional logistic if individually matched)."),
         warn("Don’t interpret a case-control odds ratio as a risk ratio unless the outcome is rare.")],
      ),
      inputs: [fArea("analysisPlan", "Statistical analysis plan", { required: true, rows: 4 })],
      validations: [minLen("analysisPlan", 20, "Outline your analysis plan.")],
    },
    {
      id: "report",
      title: "STROBE report & export",
      short: "Report",
      subtitle: "Report against the STROBE case-control checklist.",
      guide: guide([para("Report how cases and controls were selected, exposure measurement, and adjusted estimates."), warn("Label AI-assisted text as a structured draft, never ‘ready to submit.’")]),
      inputs: [fCheck("strobe", "Checked against the STROBE checklist")],
      validations: [],
    },
  ],
};
