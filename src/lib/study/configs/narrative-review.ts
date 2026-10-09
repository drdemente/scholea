import type { StudyTypeConfig } from "../types";
import { fArea, fText, guide, list, minLen, para, required, tip, warn } from "../authoring";

/**
 * Narrative / literature review — authored against SANRA (Scale for the
 * Assessment of Narrative Review Articles; Baethge et al., 2019). Structured
 * but non-systematic synthesis; no formal screening, appraisal, or pooling.
 */
export const narrativeReview: StudyTypeConfig = {
  id: "narrative-review",
  label: "Narrative / Literature Review",
  family: "review",
  reportingStandard: "SANRA",
  steps: [
    {
      id: "topic",
      title: "Define the topic & importance",
      short: "Topic",
      subtitle: "SANRA Item 1: justify why this review matters.",
      glossary: [{ term: "SANRA", definition: "A 6-item quality scale for narrative reviews: importance, aims, literature search, referencing, evidence for claims, and appropriate data presentation." }],
      guide: guide(
        [para("A narrative review synthesises a body of literature to give an expert overview. Start by stating the topic’s importance to your readership."),
         warn("A narrative review is not a substitute for a systematic review when you need an unbiased answer to a focused question. Be honest about its scope.")],
      ),
      inputs: [
        fText("topic", "Review topic", { required: true }),
        fArea("importance", "Why is this review needed now?", { required: true, rows: 3 }),
      ],
      validations: [required("topic"), minLen("importance", 20, "Explain why the review is needed (SANRA Item 1).")],
    },
    {
      id: "aims",
      title: "Aims & questions",
      short: "Aims",
      subtitle: "SANRA Item 2: state clear aims or questions.",
      guide: guide([para("Even a narrative review needs explicit aims so readers know what it does and doesn’t cover.")]),
      inputs: [fArea("aims", "Aims / guiding questions", { required: true, rows: 3 })],
      validations: [minLen("aims", 15, "State your aims (SANRA Item 2).")],
    },
    {
      id: "search",
      title: "Describe your literature search",
      short: "Search",
      subtitle: "SANRA Item 3: be transparent about how you found sources.",
      guide: guide(
        [para("Narrative reviews don’t require an exhaustive search, but you should describe where and how you looked so readers can judge coverage."),
         tip("You can still use Scholea’s search tools to find and organise sources — just don’t claim systematic completeness.")],
      ),
      inputs: [
        fText("databases", "Where did you search?", { required: true, placeholder: "e.g. PubMed, Google Scholar, key journals" }),
        fArea("approach", "Search approach", { rows: 2, level: "medium" }),
      ],
      validations: [required("databases", "Describe where you searched (SANRA Item 3).")],
    },
    {
      id: "synthesis",
      title: "Structure & synthesise",
      short: "Synthesis",
      subtitle: "SANRA Items 4–5: support claims with appropriate references.",
      guide: guide(
        [para("Organise the literature thematically and synthesise — don’t just summarise paper by paper."),
         list(["Group sources by theme or chronology", "Compare and contrast findings", "Back every claim with a citation (SANRA Item 5)"])],
        [tip("Signpost the strength of evidence behind each claim; distinguish well-supported statements from your interpretation.")],
      ),
      inputs: [fArea("structure", "Thematic structure / outline", { required: true, rows: 4 })],
      validations: [minLen("structure", 20, "Sketch your thematic structure.")],
    },
    {
      id: "write",
      title: "Write & self-assess (SANRA)",
      short: "Write",
      subtitle: "SANRA Item 6: present data and conclusions appropriately.",
      guide: guide(
        [para("Write the review, then self-score against the six SANRA items to catch weak spots before submission."),
         warn("AI-assisted text is a structured draft — verify every claim and citation yourself.")],
      ),
      inputs: [fArea("draftNotes", "Draft notes / outline of conclusions", { required: true, rows: 4 })],
      validations: [minLen("draftNotes", 15, "Capture your draft conclusions.")],
    },
  ],
};
