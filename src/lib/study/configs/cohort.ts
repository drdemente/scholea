import type { StudyTypeConfig } from "../types";
import { fArea, fCheck, fSelect, fTags, fText, guide, list, minLen, para, required, tip, warn } from "../authoring";

/**
 * Cohort study (prospective or retrospective) — authored from STROBE with
 * Newcastle-Ottawa appraisal prompts. Follows exposed/unexposed groups forward
 * to incident outcomes (RR/HR, Kaplan-Meier, Cox).
 */
export const cohort: StudyTypeConfig = {
  id: "cohort",
  label: "Cohort Study",
  family: "observational",
  reportingStandard: "STROBE",
  steps: [
    {
      id: "question",
      title: "Question & direction",
      short: "Question",
      subtitle: "Does an exposure change the rate of a later outcome?",
      glossary: [{ term: "Cohort study", definition: "Groups defined by exposure are followed over time to compare the incidence of an outcome. Because exposure precedes outcome, cohorts can support temporality." }],
      guide: guide(
        [para("Cohort studies follow exposed and unexposed groups to incident outcomes — the strongest observational design for temporality."),
         list(["Prospective: enrol now, follow forward", "Retrospective: reconstruct a historical cohort from records"])],
      ),
      inputs: [
        fArea("objective", "Objective", { required: true, rows: 2 }),
        fSelect("direction", "Direction", [{ value: "prospective", label: "Prospective" }, { value: "retrospective", label: "Retrospective" }], { required: true }),
      ],
      validations: [minLen("objective", 15, "State your objective."), required("direction")],
    },
    {
      id: "cohortDef",
      title: "Define cohort & exposure",
      short: "Cohort",
      subtitle: "STROBE Item 6: eligibility, sources, exposure ascertainment.",
      extraTool: "samplesize",
      guide: guide(
        [para("Define who enters the cohort, how you measure exposure, and the source population."),
         tip("Exposed and unexposed groups should be comparable except for the exposure — describe how you’ll achieve that (Newcastle-Ottawa: selection).")],
      ),
      inputs: [
        fText("exposure", "Exposure", { required: true }),
        fArea("eligibility", "Cohort eligibility & sources", { required: true, rows: 3 }),
      ],
      validations: [required("exposure"), minLen("eligibility", 20, "Define your cohort eligibility and sources.")],
    },
    {
      id: "outcomes",
      title: "Outcomes & follow-up",
      short: "Outcomes",
      subtitle: "Define incident outcomes and the follow-up scheme.",
      guide: guide(
        [para("Define outcomes and how/when they’re ascertained, plus your follow-up duration and how you’ll handle loss to follow-up."),
         warn("Differential loss to follow-up between groups is a major source of bias (Newcastle-Ottawa: outcome). Plan to measure and report it.")],
      ),
      inputs: [
        fText("outcome", "Primary outcome", { required: true }),
        fText("followUp", "Planned follow-up duration", { placeholder: "e.g. 24 months" }),
        fTags("confounders", "Confounders to adjust for", { placeholder: "Press Enter after each" }),
      ],
      validations: [required("outcome")],
    },
    {
      id: "analysis",
      title: "Analysis plan",
      short: "Analysis",
      subtitle: "Incidence, relative risks/hazard ratios, survival analysis.",
      tool: "strobeflow",
      extraTool: "generalstats",
      guide: guide(
        [para("Plan incidence rates, relative risk or hazard ratios, and time-to-event analysis (Kaplan-Meier curves, Cox regression) where follow-up varies."),
         tip("Adjust for confounders in a multivariable model specified in advance; check the proportional-hazards assumption for Cox.")],
        [para("The validated survival/Cox tooling arrives with the stats workers; record your modelling plan and assumptions here now.")],
      ),
      inputs: [fArea("analysisPlan", "Statistical analysis plan", { required: true, rows: 4 })],
      validations: [minLen("analysisPlan", 20, "Outline your analysis plan.")],
    },
    {
      id: "report",
      title: "STROBE report & export",
      short: "Report",
      subtitle: "Report against the STROBE cohort checklist.",
      guide: guide([para("Report participant flow, follow-up completeness, adjusted and unadjusted estimates, and a characteristics table."), warn("Label AI-assisted text as a structured draft, never ‘ready to submit.’")]),
      inputs: [fCheck("strobe", "Checked against the STROBE checklist")],
      validations: [],
    },
  ],
};
