import type { StudyTypeConfig } from "../types";
import { fArea, fCheck, fSelect, guide, list, minLen, para, required, warn } from "../authoring";

/**
 * Mixed-methods study — authored from GRAMMS (O'Cathain et al., 2008). Composes
 * a quantitative and a qualitative track; the value is in their integration.
 */
export const mixedMethods: StudyTypeConfig = {
  id: "mixed-methods",
  label: "Mixed-methods Study",
  family: "mixed",
  reportingStandard: "GRAMMS",
  steps: [
    {
      id: "rationale",
      title: "Rationale & design",
      short: "Rationale",
      subtitle: "GRAMMS Item 1: justify a mixed-methods design.",
      glossary: [{ term: "Integration", definition: "The point where qualitative and quantitative strands are brought together — at design, methods, analysis, or interpretation. Integration is what distinguishes mixed-methods from two parallel studies." }],
      guide: guide(
        [para("Mixed-methods is justified when one method can’t fully answer your question. State why you need both and how they relate."),
         list(["Convergent — collect both, compare", "Explanatory sequential — quant → qual to explain", "Exploratory sequential — qual → quant to generalise"])],
      ),
      inputs: [
        fArea("rationale", "Why mixed-methods?", { required: true, rows: 2 }),
        fSelect("design", "Design", [
          { value: "convergent", label: "Convergent parallel" },
          { value: "explanatory", label: "Explanatory sequential" },
          { value: "exploratory", label: "Exploratory sequential" },
        ], { required: true }),
      ],
      validations: [minLen("rationale", 15, "Justify the mixed-methods design."), required("design")],
    },
    {
      id: "quant",
      title: "Quantitative strand",
      short: "Quant",
      subtitle: "GRAMMS Item 2: describe the quantitative methods.",
      guide: guide([para("Outline the quantitative design, sampling, measures, and analysis. (You can run this strand as its own Scholea study and link back.)")]),
      inputs: [fArea("quant", "Quantitative methods", { required: true, rows: 3 })],
      validations: [minLen("quant", 20, "Describe the quantitative strand.")],
    },
    {
      id: "qual",
      title: "Qualitative strand",
      short: "Qual",
      subtitle: "GRAMMS Item 2: describe the qualitative methods.",
      guide: guide([para("Outline the qualitative approach, sampling, data collection, and analysis.")]),
      inputs: [fArea("qual", "Qualitative methods", { required: true, rows: 3 })],
      validations: [minLen("qual", 20, "Describe the qualitative strand.")],
    },
    {
      id: "integration",
      title: "Integration",
      short: "Integration",
      subtitle: "GRAMMS Items 3–4: where and how the strands meet.",
      guide: guide(
        [para("Describe exactly where integration happens and how you’ll combine findings — a joint display (matrix) is a powerful integration device."),
         warn("Reporting two strands side by side is NOT integration. State the meta-inferences that draw on both.")],
      ),
      inputs: [fArea("integration", "Integration plan & joint display", { required: true, rows: 3 })],
      validations: [minLen("integration", 20, "Describe how the strands will be integrated.")],
    },
    {
      id: "report",
      title: "GRAMMS report & export",
      short: "Report",
      subtitle: "Report against GRAMMS, foregrounding integration.",
      guide: guide([para("Report both strands, the integration, and the meta-inferences — plus any insight gained from combining methods."), warn("Label AI-assisted text as a structured draft, never ‘ready to submit.’")]),
      inputs: [fCheck("gramms", "Checked against GRAMMS")],
      validations: [],
    },
  ],
};
