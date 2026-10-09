import type { StudyTypeConfig } from "../types";
import { fArea, fSelect, guide, list, minLen, para, range, required, tip, warn } from "../authoring";

/**
 * Umbrella review (review of reviews) — authored from PRISMA + JBI umbrella
 * methodology, appraising included systematic reviews with AMSTAR-2.
 */
export const umbrellaReview: StudyTypeConfig = {
  id: "umbrella-review",
  label: "Umbrella Review",
  family: "review",
  reportingStandard: "PRISMA-2020",
  steps: [
    {
      id: "question",
      title: "Frame the question",
      short: "Question",
      subtitle: "Your unit of analysis is the systematic review, not the primary study.",
      glossary: [{ term: "AMSTAR-2", definition: "A 16-item critical-appraisal tool for systematic reviews, yielding an overall confidence rating (high / moderate / low / critically low)." }],
      guide: guide(
        [para("An umbrella review summarises existing systematic reviews on a broad question — ideal when several reviews already exist and you need the big picture."),
         warn("If only one or two current reviews exist, an update or a new systematic review may serve better than an umbrella review.")],
      ),
      inputs: [fArea("question", "Umbrella review question", { required: true, rows: 2 })],
      validations: [minLen("question", 15, "State your umbrella-review question.")],
    },
    {
      id: "protocol",
      title: "Protocol & eligibility",
      short: "Protocol",
      subtitle: "Include systematic reviews/meta-analyses; define overlap handling.",
      guide: guide(
        [para("Pre-specify which reviews are eligible and how you’ll handle overlap when the same primary studies appear in multiple reviews."),
         tip("A citation matrix (which primary study appears in which review) makes overlap explicit — compute the corrected covered area (CCA).")],
      ),
      inputs: [
        fSelect("registry", "Registration", [{ value: "prospero", label: "PROSPERO" }, { value: "osf", label: "OSF" }, { value: "none", label: "Not registering" }], { required: true }),
        fArea("eligibility", "Eligibility (review types, overlap handling)", { required: true, rows: 3 }),
      ],
      validations: [required("registry"), minLen("eligibility", 30, "Define eligibility and overlap handling.")],
    },
    { id: "search", title: "Search for reviews", short: "Search", subtitle: "Find existing systematic reviews and meta-analyses.", tool: "search", inputs: [], guide: guide([para("Search for systematic reviews and meta-analyses; filter your strategy to review designs.")]), validations: [range("nIdentified", { min: 1 }, "Run a search to identify reviews.")] },
    { id: "dedup", title: "Import & deduplicate", short: "Dedup", subtitle: "Remove duplicate reviews.", tool: "dedup", inputs: [], guide: guide([para("Deduplicate the retrieved reviews.")]), validations: [required("nDuplicates", "Run deduplication to continue.")] },
    { id: "screening", title: "Screen reviews", short: "Screen", subtitle: "Two reviewers select eligible reviews.", tool: "screening", inputs: [], guide: guide([para("Screen reviews against eligibility; record exclusions.")]), validations: [range("nScreened", { min: 1 }, "Screen at least one review.")] },
    {
      id: "appraisal",
      title: "Appraise reviews (AMSTAR-2)",
      short: "Appraise",
      subtitle: "Rate confidence in each included review.",
      guide: guide(
        [para("Appraise each included systematic review with AMSTAR-2, recording the overall confidence rating."),
         list(["Was the protocol registered before commencement?", "Was study selection/extraction in duplicate?", "Was risk of bias assessed and accounted for?", "Were the methods for meta-analysis appropriate?"]),
         warn("Critically-low-confidence reviews should not be relied on for your conclusions.")],
      ),
      inputs: [fArea("amstar", "AMSTAR-2 ratings per review (overall + key domains)", { required: true, rows: 4 })],
      validations: [minLen("amstar", 20, "Record AMSTAR-2 ratings for the included reviews.")],
    },
    {
      id: "synthesis",
      title: "Synthesise across reviews",
      short: "Synthesis",
      subtitle: "Summarise effects, certainty, and overlap.",
      guide: guide(
        [para("Tabulate each review’s population, effect estimates, and certainty (GRADE if reported). Note where reviews agree and disagree."),
         tip("Re-pooling primary studies across reviews risks double-counting — describe overlap rather than naively combining.")],
      ),
      inputs: [fArea("synthesis", "Cross-review synthesis", { required: true, rows: 4 })],
      validations: [minLen("synthesis", 20, "Summarise findings across the included reviews.")],
    },
    { id: "report", title: "Report & export", short: "Report", subtitle: "Report against PRISMA with your flow diagram.", tool: "prisma", inputs: [], guide: guide([para("Report selection, AMSTAR-2 confidence, overlap, and your synthesis."), warn("Label AI-assisted text as a structured draft, never ‘ready to submit.’")]), validations: [] },
  ],
};
