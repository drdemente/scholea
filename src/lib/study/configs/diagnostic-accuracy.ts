import type { StudyTypeConfig } from "../types";
import { fArea, fCheck, fText, guide, list, minLen, para, required, tip, warn } from "../authoring";

/**
 * Diagnostic accuracy study — authored from STARD 2015 with QUADAS-2 bias
 * prompts. Compares an index test against a reference standard; the diagnostic
 * tool computes sensitivity/specificity/PPV/NPV/LRs and the ROC/AUC.
 */
export const diagnosticAccuracy: StudyTypeConfig = {
  id: "diagnostic-accuracy",
  label: "Diagnostic Accuracy Study",
  family: "diagnostic",
  reportingStandard: "STARD",
  steps: [
    {
      id: "question",
      title: "Question: index test vs reference",
      short: "Question",
      subtitle: "How well does the index test identify the target condition?",
      glossary: [
        { term: "Index test", definition: "The test under evaluation." },
        { term: "Reference standard", definition: "The best available method to establish the true presence/absence of the target condition — what you judge the index test against." },
      ],
      guide: guide(
        [para("Define the index test, the reference standard, and the target condition. Accuracy is only meaningful relative to a sound reference standard."),
         warn("If the reference standard is weak or applied differently to test-positives and test-negatives, your accuracy estimates are biased (QUADAS-2).")],
      ),
      inputs: [
        fText("indexTest", "Index test", { required: true }),
        fText("reference", "Reference standard", { required: true }),
        fText("target", "Target condition", { required: true }),
      ],
      validations: [required("indexTest"), required("reference"), required("target")],
    },
    {
      id: "design",
      title: "Design & participants",
      short: "Design",
      subtitle: "STARD: recruitment, sampling, and blinding.",
      extraTool: "samplesize",
      guide: guide(
        [para("Describe how participants were sampled and whether index and reference were interpreted blind to each other."),
         list(["Consecutive/random vs selected sampling", "Both tests applied to all participants?", "Interpreters blinded to the other test?"])],
        [tip("A consecutive or random series with both tests on everyone, interpreted blind, is the low-bias ideal (QUADAS-2: patient selection, flow & timing).")],
      ),
      inputs: [fArea("design", "Sampling, flow & blinding", { required: true, rows: 3 })],
      validations: [minLen("design", 20, "Describe sampling, flow, and blinding.")],
    },
    {
      id: "results",
      title: "Accuracy results",
      short: "Results",
      subtitle: "Enter the 2×2 and operating points; see metrics + ROC.",
      tool: "diagnostic",
      guide: guide(
        [para("Cross-tabulate the index test against the reference standard. Scholea computes sensitivity, specificity, predictive values, likelihood ratios, and the ROC/AUC."),
         warn("Predictive values depend on prevalence — report likelihood ratios too, as they don’t.")],
      ),
      inputs: [],
      validations: [],
    },
    {
      id: "report",
      title: "STARD report & export",
      short: "Report",
      subtitle: "Report against the STARD 2015 checklist + flow diagram.",
      guide: guide([para("Report the 2×2, accuracy estimates with CIs, the ROC, and a STARD participant-flow diagram."), warn("Label AI-assisted text as a structured draft, never ‘ready to submit.’")]),
      inputs: [fCheck("stard", "Checked against the STARD checklist")],
      validations: [],
    },
  ],
};
