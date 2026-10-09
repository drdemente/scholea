import type { StudyTypeConfig } from "../types";
import { fArea, fCheck, fNum, fSelect, fText, guide, list, minLen, para, range, required, tip, warn } from "../authoring";

/**
 * Survey / questionnaire study — a cross-sectional core plus CHERRIES (Eysenbach,
 * 2004) for web surveys, with a reliability (Cronbach's α) step.
 */
export const survey: StudyTypeConfig = {
  id: "survey",
  label: "Survey / Questionnaire",
  family: "survey",
  reportingStandard: "CHERRIES",
  steps: [
    {
      id: "question",
      title: "Objective & constructs",
      short: "Objective",
      subtitle: "What will the survey measure, and in whom?",
      guide: guide(
        [para("Define the survey’s objective and the constructs each section measures. A survey is only as good as the constructs behind its items."),
         tip("Prefer validated instruments where they exist — borrowing a validated scale beats writing your own from scratch.")],
      ),
      inputs: [
        fArea("objective", "Objective", { required: true, rows: 2 }),
        fText("population", "Target population", { required: true }),
      ],
      validations: [minLen("objective", 15, "State your objective."), required("population")],
    },
    {
      id: "instrument",
      title: "Instrument design",
      short: "Instrument",
      subtitle: "Items, response formats, and validity checks.",
      guide: guide(
        [para("Design clear, unbiased items with appropriate response scales, and plan content/face validity checks (e.g. expert review, cognitive interviews)."),
         list(["Avoid double-barrelled and leading items", "Match the response scale to the construct", "Pilot for comprehension before launch"])],
        [warn("Pre-test the questionnaire — CHERRIES asks you to report pilot testing and any usability/technical testing for web surveys.")],
      ),
      inputs: [
        fNum("nItems", "Number of items", { min: 1 }),
        fArea("validity", "Validity checks planned", { required: true, rows: 3 }),
      ],
      validations: [minLen("validity", 15, "Describe your validity checks.")],
    },
    {
      id: "administration",
      title: "Administration & sampling",
      short: "Administration",
      subtitle: "CHERRIES: mode, recruitment, and how you’ll report response.",
      extraTool: "samplesize",
      guide: guide(
        [para("Describe the mode (web, paper, phone), how you recruit, and how you’ll compute and report the response/completion rate."),
         tip("For web surveys, record whether it was open or closed, and how you prevented duplicate submissions (CHERRIES).")],
      ),
      inputs: [
        fSelect("mode", "Mode", [{ value: "web", label: "Web" }, { value: "paper", label: "Paper" }, { value: "phone", label: "Phone/interview" }], { required: true }),
        fNum("targetN", "Target responses", { min: 1 }),
      ],
      validations: [required("mode"), range("targetN", { min: 1 }, "Enter a target number of responses.")],
    },
    {
      id: "reliability",
      title: "Reliability (Cronbach's α)",
      short: "Reliability",
      subtitle: "Estimate internal consistency of your scale(s).",
      tool: "reliability",
      guide: guide(
        [para("After piloting, estimate internal consistency for each multi-item scale. Standardized α follows from the item count and mean inter-item correlation."),
         warn("A very high α (> 0.95) can signal redundant items, not just a ‘good’ scale.")],
      ),
      inputs: [],
      validations: [],
    },
    {
      id: "analysis",
      title: "Analysis & CHERRIES report",
      short: "Report",
      subtitle: "Analyse responses and report against CHERRIES.",
      tool: "generalstats",
      guide: guide([para("Plan descriptive and (if analytic) association analyses, and report response rates, the instrument, and reliability against CHERRIES."), warn("Label AI-assisted text as a structured draft, never ‘ready to submit.’")]),
      inputs: [fArea("analysisPlan", "Analysis plan", { required: true, rows: 3 }), fCheck("cherries", "Checked against CHERRIES (web surveys)")],
      validations: [minLen("analysisPlan", 15, "Outline your analysis plan.")],
    },
  ],
};
