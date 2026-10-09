import type { StudyTypeConfig } from "../types";
import { fArea, fCheck, fText, guide, list, minLen, para, required, tip, warn } from "../authoring";

/**
 * Case report / case series — authored from the CARE guideline (Gagnier et al.,
 * 2013). A structured narrative of one (or a few) instructive cases.
 */
export const caseReport: StudyTypeConfig = {
  id: "case-report",
  label: "Case Report / Series",
  family: "report",
  reportingStandard: "CARE",
  steps: [
    {
      id: "rationale",
      title: "Why this case?",
      short: "Rationale",
      subtitle: "CARE: what makes this case worth reporting?",
      guide: guide(
        [para("A good case report teaches something: an unexpected presentation, a rare condition, an unanticipated effect, or a lesson in management."),
         warn("Patient consent is required before writing — and identifying details must be removed.")],
      ),
      inputs: [
        fArea("rationale", "What is novel or instructive here?", { required: true, rows: 3 }),
        fCheck("consent", "Informed consent for publication obtained"),
      ],
      validations: [minLen("rationale", 20, "Explain what makes this case worth reporting."), required("consent", "CARE requires patient consent before publication.", "warn")],
    },
    {
      id: "presentation",
      title: "Patient & presentation",
      short: "Presentation",
      subtitle: "CARE: de-identified demographics, history, and findings.",
      guide: guide(
        [para("Describe the de-identified patient, the presenting complaint, relevant history, and examination/investigation findings."),
         list(["De-identified demographics", "Presenting symptoms + timeline", "Relevant past history", "Clinical and investigation findings"])],
      ),
      inputs: [
        fArea("presentation", "Case presentation", { required: true, rows: 4 }),
      ],
      validations: [minLen("presentation", 30, "Describe the presentation.")],
    },
    {
      id: "timeline",
      title: "Diagnosis, intervention & timeline",
      short: "Timeline",
      subtitle: "CARE: a clear chronology of assessment and management.",
      guide: guide(
        [para("Give the diagnostic reasoning, the intervention(s), and a timeline so readers can follow the course of events."),
         tip("A simple timeline figure (dates → events) is a CARE hallmark and greatly aids readability.")],
      ),
      inputs: [
        fText("diagnosis", "Diagnosis", { required: true }),
        fArea("management", "Intervention & timeline", { required: true, rows: 3 }),
      ],
      validations: [required("diagnosis"), minLen("management", 20, "Describe the intervention and timeline.")],
    },
    {
      id: "outcome",
      title: "Outcome & discussion",
      short: "Outcome",
      subtitle: "CARE: outcomes, follow-up, and the take-home lesson.",
      guide: guide(
        [para("Report outcomes and follow-up, then discuss the case against the literature and state the clear take-away."),
         warn("Don’t over-generalise from a single case — frame the lesson as hypothesis-generating.")],
      ),
      inputs: [fArea("discussion", "Outcome, follow-up & lessons", { required: true, rows: 4 })],
      validations: [minLen("discussion", 20, "Report outcomes and the lesson learned.")],
    },
    {
      id: "report",
      title: "CARE report & export",
      short: "Report",
      subtitle: "Assemble against the CARE checklist.",
      guide: guide([para("Compile against CARE, including the timeline and a patient-perspective statement where possible."), warn("Label AI-assisted text as a structured draft, never ‘ready to submit.’")]),
      inputs: [fCheck("care", "Checked against the CARE checklist")],
      validations: [],
    },
  ],
};
