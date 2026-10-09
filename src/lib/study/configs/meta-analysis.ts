import type { StudyTypeConfig } from "../types";
import { fArea, fSelect, fText, guide, list, minLen, para, range, required, tip, warn } from "../authoring";

/**
 * Meta-analysis (first-class) — authored from PRISMA 2020 + the Cochrane
 * Handbook. Distinct from a systematic review in emphasis: the quantitative
 * synthesis is the centre of gravity. Reuses the shared review tools (search,
 * dedup, screening, appraisal, synthesis, PRISMA flow).
 */
export const metaAnalysis: StudyTypeConfig = {
  id: "meta-analysis",
  label: "Meta-analysis",
  family: "review",
  reportingStandard: "PRISMA-2020",
  steps: [
    {
      id: "question",
      title: "Frame the question (PICO)",
      short: "Question",
      subtitle: "A poolable question needs one clearly-defined effect to estimate.",
      glossary: [{ term: "Effect measure", definition: "The statistic you’ll pool — e.g. standardised mean difference for continuous outcomes, odds/risk ratio for binary outcomes." }],
      guide: guide(
        [
          para("Meta-analysis estimates a single combined effect, so your question must point at one outcome measured comparably across studies."),
          list(["Population, Intervention, Comparator, Outcome", "The effect measure you’ll pool (SMD, OR, RR…)", "Whether a pooled estimate is even sensible for these studies"]),
          tip("If the studies measure the outcome in wildly different ways, a standardised effect (SMD) or a narrative synthesis may be safer than a raw pooled mean."),
        ],
        [para("Decide a priori whether you expect a fixed common effect or a distribution of effects (random-effects). The latter is the usual default in clinical research.")],
      ),
      inputs: [
        fText("population", "Population", { required: true }),
        fText("intervention", "Intervention", { required: true }),
        fText("comparator", "Comparator", { placeholder: "e.g. placebo / usual care" }),
        fText("outcome", "Primary outcome", { required: true }),
        fSelect("measure", "Effect measure", [
          { value: "SMD", label: "Standardised mean difference" },
          { value: "MD", label: "Mean difference" },
          { value: "OR", label: "Odds ratio" },
          { value: "RR", label: "Risk ratio" },
        ], { required: true }),
      ],
      validations: [required("population"), required("intervention"), required("outcome"), required("measure", "Choose the effect measure you’ll pool.")],
    },
    {
      id: "protocol",
      title: "Protocol & analysis plan",
      short: "Protocol",
      subtitle: "Pre-specify the model and the subgroup/sensitivity analyses.",
      guide: guide(
        [
          para("Register the protocol (PROSPERO) and pre-specify your statistical model before extracting data."),
          warn("Choosing fixed vs random effects after seeing heterogeneity is a form of bias. Decide now."),
        ],
        [list(["Fixed-effect vs random-effects (and estimator, e.g. DerSimonian-Laird or REML)", "Planned subgroup analyses", "Planned sensitivity analyses (e.g. excluding high-risk-of-bias studies)", "How you’ll assess publication bias"], true)],
      ),
      inputs: [
        fSelect("model", "Primary model", [{ value: "random", label: "Random effects" }, { value: "fixed", label: "Fixed effect" }], { required: true }),
        fArea("subgroups", "Pre-specified subgroup / sensitivity analyses", { rows: 3, level: "medium" }),
      ],
      validations: [required("model", "Pre-specify your primary model.")],
    },
    { id: "search", title: "Build the search strategy", short: "Search", subtitle: "A sensitive, reproducible, multi-database search.", tool: "search", inputs: [], guide: guide([para("Search several databases and record everything for reproducibility.")], [tip("Hand-search reference lists and trial registries for unpublished results — a key defence against publication bias.")]), validations: [range("nIdentified", { min: 1 }, "Run a search to identify records.")] },
    { id: "dedup", title: "Import & deduplicate", short: "Dedup", subtitle: "Remove duplicate records before screening.", tool: "dedup", inputs: [], guide: guide([para("Deduplicate so each study is screened once; record the count for the flow diagram.")]), validations: [required("nDuplicates", "Run deduplication to continue.")] },
    { id: "screening", title: "Screen records", short: "Screen", subtitle: "Dual independent screening against your criteria.", tool: "screening", inputs: [], guide: guide([para("Screen titles/abstracts, then full texts. Two reviewers reduce selection bias."), tip("Watch the live kappa — calibrate before screening the whole set.")]), validations: [range("nScreened", { min: 1 }, "Screen at least one record.")] },
    {
      id: "extraction",
      title: "Extract effect data",
      short: "Extract",
      subtitle: "Capture exactly what you need to compute effect sizes.",
      guide: guide(
        [
          para("For each study, extract the numbers your effect measure needs — means/SDs/group sizes for continuous outcomes, or events/totals for binary outcomes."),
          tip("Extract in duplicate. A single transcription slip can flip a pooled estimate."),
        ],
        [warn("If a study reports medians/IQRs instead of means/SDs, plan a conversion or a sensitivity analysis now.")],
      ),
      inputs: [
        fArea("extractionPlan", "What will you extract per study?", { required: true, rows: 4, placeholder: "design, n per arm, means + SDs (or events + totals), timepoint…" }),
      ],
      validations: [minLen("extractionPlan", 20, "Describe the effect data you’ll extract.")],
    },
    { id: "appraisal", title: "Risk-of-bias appraisal", short: "Appraise", subtitle: "Appraise each included study for the pooled outcome.", tool: "appraisal", inputs: [], guide: guide([para("Appraise every included study (RoB 2 for trials). The judgements feed your interpretation and any sensitivity analysis.")]), validations: [range("nAppraised", { min: 1 }, "Appraise at least one included study.")] },
    { id: "synthesis", title: "Meta-analysis", short: "Synthesis", subtitle: "Pool the effects, inspect heterogeneity and publication bias.", tool: "synthesis", inputs: [fArea("interpretation", "Interpretation of the pooled estimate", { rows: 3, level: "medium" })], guide: guide([para("Pool the effects and read the forest plot. High heterogeneity (I²) warns that a single summary may mislead."), tip("Use the funnel plot + Egger’s test to probe small-study/publication-bias effects.")]), validations: [] },
    {
      id: "report",
      title: "PRISMA report & export",
      short: "Report",
      subtitle: "Report the synthesis transparently against PRISMA 2020.",
      tool: "prisma",
      guide: guide([para("Report your flow, your pooled estimates with CIs, heterogeneity, and your bias assessments."), warn("AI-assisted text is a structured draft to a reporting standard — never ‘ready to submit.’")]),
      inputs: [],
      validations: [],
    },
  ],
};
