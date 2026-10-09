import type { StudyTypeConfig } from "../types";
import { fArea, fSelect, fText, guide, list, minLen, para, range, required, tip, warn } from "../authoring";

/**
 * Scoping review — authored from PRISMA-ScR (Tricco et al., 2018) and the JBI
 * scoping methodology. Maps the breadth of evidence rather than pooling it; uses
 * the PCC (Population–Concept–Context) framing and charting instead of
 * appraisal/meta-analysis.
 */
export const scopingReview: StudyTypeConfig = {
  id: "scoping-review",
  label: "Scoping Review",
  family: "review",
  reportingStandard: "PRISMA-ScR",
  steps: [
    {
      id: "question",
      title: "Frame the question (PCC)",
      short: "Question",
      subtitle: "Scoping questions are broad — map the field, don’t test an effect.",
      glossary: [{ term: "PCC", definition: "Population, Concept, Context — the scoping-review framing, broader than PICO because you’re charting breadth, not estimating an effect." }],
      guide: guide(
        [
          para("Scoping reviews answer ‘what exists?’ — the extent, range, and nature of evidence on a topic. Use the PCC framework."),
          list(["Population — who", "Concept — the core idea/intervention/phenomenon", "Context — setting, geography, timeframe"]),
          tip("A scoping review is the right choice when the literature is emergent or heterogeneous and a focused effect question would be premature."),
        ],
        [warn("Scoping reviews map evidence; they do NOT formally appraise risk of bias or pool results. If you need an effect estimate, run a systematic review/meta-analysis instead.")],
      ),
      inputs: [
        fText("population", "Population", { required: true }),
        fText("concept", "Concept", { required: true }),
        fText("context", "Context", { required: true }),
        fArea("objective", "Review objective", { required: true, rows: 2, placeholder: "This scoping review will map…" }),
      ],
      validations: [required("population"), required("concept"), required("context"), minLen("objective", 15, "State your scoping objective.")],
    },
    {
      id: "protocol",
      title: "Protocol & eligibility (PCC)",
      short: "Protocol",
      subtitle: "Register an a-priori protocol; pre-define inclusion by PCC.",
      guide: guide(
        [para("Register your protocol (e.g. OSF) and define inclusion criteria across all evidence sources — scoping reviews often include non-research sources too."),
         tip("Scoping reviews can include any study design and grey literature; say so explicitly.")],
      ),
      inputs: [
        fSelect("registry", "Protocol registration", [{ value: "osf", label: "OSF" }, { value: "jbi", label: "JBI" }, { value: "none", label: "Not registering" }], { required: true }),
        fArea("eligibility", "Eligibility by Population, Concept, Context, and source types", { required: true, rows: 4 }),
      ],
      validations: [required("registry"), minLen("eligibility", 30, "Define eligibility across PCC and source types.")],
    },
    { id: "search", title: "Search (incl. grey literature)", short: "Search", subtitle: "Broad, multi-source search — including grey literature.", tool: "search", inputs: [fArea("greyLit", "Grey-literature sources searched", { level: "medium", rows: 2 })], guide: guide([para("Cast a wide net across databases and grey literature; scoping breadth depends on a sensitive search.")]), validations: [range("nIdentified", { min: 1 }, "Run a search to identify records.")] },
    { id: "dedup", title: "Import & deduplicate", short: "Dedup", subtitle: "Remove duplicates before screening.", tool: "dedup", inputs: [], guide: guide([para("Deduplicate so each record is charted once.")]), validations: [required("nDuplicates", "Run deduplication to continue.")] },
    { id: "screening", title: "Screen for inclusion", short: "Screen", subtitle: "Two reviewers, against your PCC criteria.", tool: "screening", inputs: [], guide: guide([para("Screen against PCC inclusion. Scoping screening is usually more inclusive than a systematic review.")]), validations: [range("nScreened", { min: 1 }, "Screen at least one record.")] },
    {
      id: "charting",
      title: "Chart the data",
      short: "Chart",
      subtitle: "Extract a descriptive map, not outcome effects.",
      glossary: [{ term: "Charting", definition: "The scoping-review analogue of extraction: recording study characteristics into a structured table to map the field, without pooling." }],
      guide: guide(
        [para("Design a charting form to capture what matters for mapping: source type, population, concept details, context, key findings."),
         tip("Pilot the charting form on a few sources and refine it — charting categories often evolve as you read.")],
        [para("Charting is iterative and may be done by one reviewer with verification, unlike dual data extraction in a systematic review.")],
      ),
      inputs: [fArea("chartingForm", "Charting form fields", { required: true, rows: 4 })],
      validations: [minLen("chartingForm", 20, "List the fields your charting form will capture.")],
    },
    {
      id: "collate",
      title: "Collate, summarise & report",
      short: "Report",
      subtitle: "Summarise the map and report against PRISMA-ScR.",
      tool: "prisma",
      guide: guide(
        [para("Summarise the charted data numerically (counts by type/year) and narratively (themes), and relate it back to your objective."),
         warn("Don’t draw effectiveness conclusions from a scoping review — describe what exists and where the gaps are.")],
      ),
      inputs: [fArea("summary", "Summary of evidence mapped", { required: true, rows: 4 })],
      validations: [minLen("summary", 20, "Summarise what your map shows.")],
    },
  ],
};
