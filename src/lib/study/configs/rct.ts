import type { StudyTypeConfig } from "../types";
import { fArea, fCheck, fNum, fSelect, fText, guide, list, minLen, para, range, required, tip, warn } from "../authoring";

/**
 * Randomized controlled trial — authored from CONSORT 2010 with RoB 2 design
 * prompts. The flow step captures the CONSORT enrolment→analysis counts that
 * drive the CONSORT flow diagram.
 */
export const rct: StudyTypeConfig = {
  id: "rct",
  label: "Randomized Controlled Trial",
  family: "experimental",
  reportingStandard: "CONSORT-2010",
  steps: [
    {
      id: "question",
      title: "Question & hypothesis",
      short: "Question",
      subtitle: "A testable hypothesis with a pre-specified primary outcome.",
      guide: guide(
        [para("An RCT tests whether an intervention causes a change versus a comparator, using randomisation to balance confounders."),
         tip("State one primary outcome and a directional hypothesis before you start — multiple primary outcomes invite cherry-picking.")],
      ),
      inputs: [
        fText("population", "Population", { required: true }),
        fText("intervention", "Intervention", { required: true }),
        fText("comparator", "Comparator", { required: true, placeholder: "e.g. placebo / usual care" }),
        fText("primaryOutcome", "Primary outcome", { required: true }),
      ],
      validations: [required("population"), required("intervention"), required("comparator"), required("primaryOutcome")],
    },
    {
      id: "design",
      title: "Design & randomisation",
      short: "Design",
      subtitle: "CONSORT Item 8: how the allocation sequence is generated.",
      glossary: [{ term: "Allocation concealment", definition: "Preventing those enrolling participants from foreseeing the upcoming assignment (e.g. central randomisation). Distinct from blinding, and a key RoB 2 domain." }],
      guide: guide(
        [para("Specify the trial design, allocation ratio, and how the random sequence is generated and concealed."),
         list(["Design: parallel-group, crossover, cluster…", "Allocation ratio (e.g. 1:1)", "Sequence generation (computer RNG, random blocks)", "Allocation concealment mechanism"])],
        [warn("A truly random sequence with poor concealment still admits selection bias. Both matter (RoB 2: randomisation domain).")],
      ),
      inputs: [
        fSelect("design", "Design", [{ value: "parallel", label: "Parallel-group" }, { value: "crossover", label: "Crossover" }, { value: "cluster", label: "Cluster" }], { required: true }),
        fText("ratio", "Allocation ratio", { placeholder: "e.g. 1:1" }),
        fArea("randomisation", "Sequence generation & concealment", { required: true, rows: 3 }),
      ],
      validations: [required("design"), minLen("randomisation", 20, "Describe sequence generation and allocation concealment.")],
    },
    {
      id: "blinding",
      title: "Blinding & outcomes",
      short: "Blinding",
      subtitle: "CONSORT Items 11–12: who is blinded; how outcomes are measured.",
      guide: guide(
        [para("State who is blinded (participants, carers, outcome assessors, analysts) and define how each outcome is measured."),
         tip("Blinding the outcome assessor is often the most feasible and the most important for subjective outcomes (RoB 2: measurement domain).")],
      ),
      inputs: [
        fSelect("blinding", "Blinding", [{ value: "open", label: "Open-label" }, { value: "single", label: "Single-blind" }, { value: "double", label: "Double-blind" }], { required: true }),
        fArea("outcomes", "Outcome definitions & measurement", { required: true, rows: 3 }),
      ],
      validations: [required("blinding"), minLen("outcomes", 15, "Define how outcomes are measured.")],
    },
    {
      id: "sampleSize",
      title: "Sample size",
      short: "Sample size",
      subtitle: "CONSORT Item 7: power the trial for the primary outcome.",
      tool: "samplesize",
      guide: guide(
        [para("Justify your sample size with a power calculation for the primary outcome: effect size of interest, α, power, and expected attrition."),
         tip("Inflate for expected dropout so the analysed sample still meets your powered target.")],
      ),
      inputs: [
        fNum("targetN", "Target randomised (total)", { required: true, min: 2 }),
        fArea("powerCalc", "Power calculation assumptions", { rows: 3, level: "medium" }),
      ],
      validations: [range("targetN", { min: 2 }, "Enter your target randomised sample size.")],
    },
    {
      id: "flow",
      title: "CONSORT participant flow",
      short: "Flow",
      subtitle: "Record enrolment → allocation → follow-up → analysis counts.",
      tool: "consort",
      guide: guide(
        [para("Track participants through the trial. These counts generate your CONSORT flow diagram and must reconcile (allocated = analysed + lost + excluded)."),
         warn("Every participant randomised should be accounted for, including those lost or excluded from analysis.")],
      ),
      inputs: [
        fNum("nAssessed", "Assessed for eligibility", { min: 0 }),
        fNum("nExcluded", "Excluded before randomisation", { min: 0 }),
        fNum("nRandomised", "Randomised", { min: 0 }),
        fNum("intAllocated", "Intervention: allocated", { min: 0 }),
        fNum("intLost", "Intervention: lost to follow-up", { min: 0 }),
        fNum("intAnalysed", "Intervention: analysed", { min: 0 }),
        fNum("ctrlAllocated", "Control: allocated", { min: 0 }),
        fNum("ctrlLost", "Control: lost to follow-up", { min: 0 }),
        fNum("ctrlAnalysed", "Control: analysed", { min: 0 }),
      ],
      validations: [range("nRandomised", { min: 1 }, "Enter how many participants were randomised.")],
    },
    {
      id: "analysis",
      title: "Analysis (intention-to-treat)",
      short: "Analysis",
      subtitle: "CONSORT Item 16: analyse by assigned group.",
      tool: "generalstats",
      glossary: [{ term: "Intention-to-treat", definition: "Analyse participants in the group they were randomised to, regardless of adherence. Preserves randomisation and avoids optimistic bias." }],
      guide: guide(
        [para("Pre-specify an intention-to-treat analysis as primary, with a plan for missing data, and any per-protocol analysis as secondary."),
         warn("Switching to per-protocol because ITT ‘didn’t work’ breaks randomisation and biases toward the intervention.")],
      ),
      inputs: [fArea("analysisPlan", "Statistical analysis plan (ITT primary)", { required: true, rows: 4 })],
      validations: [minLen("analysisPlan", 20, "Outline your ITT analysis plan.")],
    },
    {
      id: "report",
      title: "CONSORT report & export",
      short: "Report",
      subtitle: "Report against the CONSORT 2010 checklist + flow diagram.",
      guide: guide([para("Write up against CONSORT, including the flow diagram, the per-arm results, and harms."), warn("Label AI-assisted text as a structured draft, never ‘ready to submit.’")]),
      inputs: [fCheck("consort", "Checked against the CONSORT checklist")],
      validations: [],
    },
  ],
};
