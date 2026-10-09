import type { StudyTypeConfig } from "../types";
import { fArea, fCheck, fSelect, guide, list, minLen, para, required, tip, warn } from "../authoring";

/**
 * Qualitative study — authored from SRQR (O'Brien et al., 2014) and COREQ (Tong
 * et al., 2007). No inferential statistics; the analytic core is thematic
 * coding, supported by the coding tool.
 */
export const qualitative: StudyTypeConfig = {
  id: "qualitative",
  label: "Qualitative Study",
  family: "qualitative",
  reportingStandard: "SRQR / COREQ",
  steps: [
    {
      id: "question",
      title: "Question & approach",
      short: "Question",
      subtitle: "Understand meaning, experience, or process — not frequency.",
      glossary: [{ term: "Reflexivity", definition: "The researcher’s critical self-awareness of how their background and assumptions shape data collection and interpretation — a hallmark of rigorous qualitative work." }],
      guide: guide(
        [para("Qualitative research explores how and why — experiences, meanings, processes. Choose a methodology that fits your question."),
         list(["Thematic analysis — flexible, patterns across data", "Grounded theory — build theory from data", "Phenomenology — lived experience", "Framework analysis — applied, matrix-based"])],
        [tip("Name your epistemological stance; it shapes every later choice (COREQ domain 1: research team & reflexivity).")],
      ),
      inputs: [
        fArea("question", "Research question", { required: true, rows: 2 }),
        fSelect("approach", "Methodology", [
          { value: "thematic", label: "Thematic analysis" },
          { value: "grounded", label: "Grounded theory" },
          { value: "phenomenology", label: "Phenomenology" },
          { value: "framework", label: "Framework analysis" },
        ], { required: true }),
      ],
      validations: [minLen("question", 15, "State your research question."), required("approach")],
    },
    {
      id: "sampling",
      title: "Sampling & data collection",
      short: "Sampling",
      subtitle: "Purposive sampling toward information power / saturation.",
      guide: guide(
        [para("Describe your purposive sampling, the data-collection method (interviews, focus groups, observation), and how you’ll judge sufficiency."),
         warn("Primary data needs ethics approval and informed consent. Plan anonymisation of transcripts.")],
      ),
      inputs: [
        fArea("sampling", "Sampling & participants", { required: true, rows: 2 }),
        fSelect("method", "Data collection", [
          { value: "interview", label: "Semi-structured interviews" },
          { value: "focusgroup", label: "Focus groups" },
          { value: "observation", label: "Observation" },
          { value: "documents", label: "Documents" },
        ], { required: true }),
        fCheck("ethics", "Ethics approval obtained (or in progress)"),
      ],
      validations: [minLen("sampling", 15, "Describe your sampling and participants."), required("method")],
    },
    {
      id: "coding",
      title: "Coding & themes",
      short: "Coding",
      subtitle: "Build codes from the data and organise them into themes.",
      tool: "coding",
      guide: guide(
        [para("Code the data inductively, then cluster codes into candidate themes. Keep an audit trail of your decisions."),
         tip("Have a second coder check a subset and discuss disagreements — it strengthens trustworthiness (COREQ domain 3).")],
      ),
      inputs: [],
      validations: [],
    },
    {
      id: "trustworthiness",
      title: "Trustworthiness",
      short: "Rigour",
      subtitle: "Credibility, dependability, confirmability, transferability.",
      guide: guide(
        [para("Show how you ensured rigour: member checking, triangulation, an audit trail, reflexive memos, and thick description."),
         list(["Credibility — member checking, triangulation", "Dependability — audit trail", "Confirmability — reflexivity", "Transferability — thick description"])],
      ),
      inputs: [fArea("trustworthiness", "Trustworthiness strategies used", { required: true, rows: 3 })],
      validations: [minLen("trustworthiness", 20, "Describe your trustworthiness strategies.")],
    },
    {
      id: "report",
      title: "SRQR / COREQ report & export",
      short: "Report",
      subtitle: "Report against SRQR (or COREQ for interviews/focus groups).",
      guide: guide([para("Write up with rich, quotation-grounded findings, your reflexive position, and the analytic process."), warn("Label AI-assisted text as a structured draft, never ‘ready to submit.’")]),
      inputs: [fCheck("srqr", "Checked against SRQR / COREQ")],
      validations: [],
    },
  ],
};
