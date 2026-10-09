import type { StudyTypeConfig } from "../types";
import { fArea, fCheck, fSelect, guide, list, minLen, para, required, tip, warn } from "../authoring";

/**
 * Economic evaluation (scaffold; optional/advanced per §3) — authored from
 * CHEERS 2022 (Husereau et al.). Compares costs and consequences of
 * alternatives.
 */
export const economic: StudyTypeConfig = {
  id: "economic",
  label: "Economic Evaluation",
  family: "report",
  reportingStandard: "CHEERS",
  steps: [
    {
      id: "question",
      title: "Decision problem & perspective",
      short: "Question",
      subtitle: "CHEERS: comparators, population, and analytic perspective.",
      glossary: [{ term: "Perspective", definition: "Whose costs and outcomes count — e.g. healthcare-payer vs societal. It determines which costs are included and strongly affects results." }],
      guide: guide(
        [para("Define the interventions compared, the population, and the perspective (payer, societal) — the perspective drives which costs you include."),
         list(["Cost-effectiveness — cost per natural unit", "Cost-utility — cost per QALY", "Cost-benefit — costs and benefits both in money"])],
      ),
      inputs: [
        fArea("decision", "Decision problem & comparators", { required: true, rows: 2 }),
        fSelect("type", "Evaluation type", [
          { value: "cea", label: "Cost-effectiveness" },
          { value: "cua", label: "Cost-utility (QALYs)" },
          { value: "cba", label: "Cost-benefit" },
        ], { required: true }),
      ],
      validations: [minLen("decision", 15, "Define the decision problem."), required("type")],
    },
    {
      id: "model",
      title: "Costs, outcomes & model",
      short: "Model",
      subtitle: "CHEERS: time horizon, discounting, and model structure.",
      guide: guide(
        [para("Specify costs and outcomes, the time horizon, the discount rate, and any model (decision tree, Markov) used to extrapolate."),
         tip("Match the time horizon to the disease — too short a horizon can miss long-run costs and benefits.")],
      ),
      inputs: [fArea("model", "Costs, outcomes, horizon, discounting, model", { required: true, rows: 4 })],
      validations: [minLen("model", 20, "Describe costs, outcomes, and model.")],
    },
    {
      id: "uncertainty",
      title: "Analysis & uncertainty",
      short: "Uncertainty",
      subtitle: "CHEERS: ICERs plus sensitivity / probabilistic analysis.",
      guide: guide(
        [para("Compute incremental cost-effectiveness ratios and characterise uncertainty with deterministic and probabilistic sensitivity analyses."),
         warn("A single point ICER without uncertainty analysis is not decision-ready.")],
      ),
      inputs: [fArea("analysis", "ICER & uncertainty analysis plan", { required: true, rows: 3 })],
      validations: [minLen("analysis", 20, "Outline your analysis and uncertainty plan.")],
    },
    {
      id: "report",
      title: "CHEERS report & export",
      short: "Report",
      subtitle: "Report against the CHEERS 2022 checklist.",
      guide: guide([para("Report the perspective, horizon, discounting, ICERs, and uncertainty transparently."), warn("Label AI-assisted text as a structured draft, never ‘ready to submit.’")]),
      inputs: [fCheck("cheers", "Checked against the CHEERS checklist")],
      validations: [],
    },
  ],
};
