import type { StudyTypeConfig } from "../types";
import { fArea, fCheck, fSelect, fText, guide, list, minLen, para, required, tip, warn } from "../authoring";

/**
 * Quasi-experimental / non-randomised intervention study — authored from TREND
 * (Des Jarlais et al., 2004) with ROBINS-I bias prompts. An intervention is
 * evaluated without randomisation, so confounding control is the central
 * challenge.
 */
export const quasiExperimental: StudyTypeConfig = {
  id: "quasi-experimental",
  label: "Quasi-experimental Study",
  family: "experimental",
  reportingStandard: "TREND",
  steps: [
    {
      id: "question",
      title: "Question & rationale",
      short: "Question",
      subtitle: "An intervention evaluated without randomisation.",
      glossary: [{ term: "Quasi-experiment", definition: "An intervention study where allocation is not random (e.g. by site, time, or self-selection). Useful when randomisation is impractical or unethical, but more open to confounding." }],
      guide: guide(
        [para("Quasi-experimental designs test an intervention when randomisation isn’t possible — using comparison groups, pre/post measurement, or interrupted time series."),
         warn("Without randomisation, groups may differ at baseline. Your design must make the comparison as fair as possible (ROBINS-I: confounding).")],
      ),
      inputs: [
        fArea("objective", "Objective", { required: true, rows: 2 }),
        fSelect("design", "Design", [
          { value: "nonrand-parallel", label: "Non-randomised parallel groups" },
          { value: "prepost", label: "Single-group pre/post" },
          { value: "its", label: "Interrupted time series" },
        ], { required: true }),
      ],
      validations: [minLen("objective", 15, "State your objective."), required("design")],
    },
    {
      id: "groups",
      title: "Groups & assignment",
      short: "Groups",
      subtitle: "How are the intervention and comparison defined?",
      extraTool: "samplesize",
      guide: guide(
        [para("Describe the intervention, the comparison condition, and exactly how units came to be in each — this non-random assignment is the key threat to validity."),
         tip("A concurrent comparison group is far stronger than a pre/post-only design for ruling out secular trends.")],
      ),
      inputs: [
        fText("intervention", "Intervention", { required: true }),
        fText("comparison", "Comparison condition", { required: true }),
        fArea("assignment", "How were units assigned?", { required: true, rows: 2 }),
      ],
      validations: [required("intervention"), required("comparison"), minLen("assignment", 15, "Describe how units were assigned.")],
    },
    {
      id: "confounding",
      title: "Confounding & bias control",
      short: "Confounding",
      subtitle: "ROBINS-I: plan how you’ll handle baseline differences.",
      guide: guide(
        [para("List likely confounders and your strategy to address them — baseline adjustment, matching, difference-in-differences, or propensity methods."),
         list(["Baseline characteristics you’ll measure", "Adjustment/analysis strategy", "Co-interventions and how you’ll account for them"])],
      ),
      inputs: [fArea("confounding", "Confounders & control strategy", { required: true, rows: 4 })],
      validations: [minLen("confounding", 20, "Describe your confounding-control strategy.")],
    },
    {
      id: "analysis",
      title: "Analysis plan",
      short: "Analysis",
      subtitle: "Estimate the effect with adjustment for baseline differences.",
      tool: "generalstats",
      guide: guide([para("Plan an adjusted analysis (e.g. ANCOVA on change scores, difference-in-differences, or segmented regression for ITS), reporting effect sizes with CIs.")]),
      inputs: [fArea("analysisPlan", "Statistical analysis plan", { required: true, rows: 3 })],
      validations: [minLen("analysisPlan", 20, "Outline your analysis plan.")],
    },
    {
      id: "report",
      title: "TREND report & export",
      short: "Report",
      subtitle: "Report against the TREND checklist for non-randomised designs.",
      guide: guide([para("Report the design, group assignment, baseline comparability, and adjusted estimates honestly."), warn("Label AI-assisted text as a structured draft, never ‘ready to submit.’")]),
      inputs: [fCheck("trend", "Checked against the TREND checklist")],
      validations: [],
    },
  ],
};
