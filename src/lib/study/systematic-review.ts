import type { StepConfig, StudyTypeConfig } from "./types";

/**
 * Systematic Review — authored from PRISMA 2020 and the Cochrane Handbook.
 * Used to exercise the engine because it touches the widest capability range
 * (search → screening → extraction → appraisal → meta-analysis → GRADE →
 * flow diagram → reporting). This is an engineering stress-test, NOT a
 * methodological template for other study types — each type is authored
 * independently from its own guideline.
 *
 * Steps capture the numbers the PRISMA flow diagram reads (see study/prisma.ts):
 *   search.nIdentified · dedup.nDuplicates · screening.{nIncluded,nExcluded}Screening
 *   · fulltext.nFullTextExcluded.
 */

const question: StepConfig = {
  id: "question",
  title: "Frame the question (PICO)",
  short: "Question",
  subtitle: "A sharp, answerable question is the foundation everything else is built on.",
  glossary: [
    {
      term: "PICO",
      definition:
        "Population, Intervention, Comparator, Outcome — a framework for turning a clinical curiosity into a structured, searchable question.",
    },
    {
      term: "Eligibility criteria",
      definition:
        "The explicit rules that decide which studies are included or excluded. They flow directly from your PICO.",
    },
  ],
  guide: {
    basic: [
      {
        type: "paragraph",
        text: "Before searching, define exactly what you’re asking. The PICO framework breaks your question into four parts so it’s specific enough to answer and broad enough to find evidence.",
      },
      {
        type: "list",
        items: [
          "Population — who are you studying? (e.g. university students with exam anxiety)",
          "Intervention — what is being done? (e.g. a mindfulness programme)",
          "Comparator — compared to what? (e.g. no intervention, or usual support)",
          "Outcome — what are you measuring? (e.g. self-reported anxiety scores)",
        ],
      },
      {
        type: "tip",
        text: "If you can’t name the comparator yet, that’s fine — but a missing comparator is the most common reason a question is too vague to search well.",
      },
    ],
    medium: [
      {
        type: "paragraph",
        text: "A good question is neither too narrow (no studies will match) nor too broad (thousands will). Your eligibility criteria are the operational version of PICO — write them so a second reviewer would make the same include/exclude decisions you would.",
      },
      {
        type: "example",
        title: "Worked PICO",
        text: "In university students (P), does an 8-week mindfulness programme (I) compared with no intervention (C) reduce self-reported exam anxiety (O)?",
      },
    ],
    advanced: [
      {
        type: "paragraph",
        text: "Consider whether your question is one of effectiveness, prevalence, diagnosis, or prognosis — each implies a different study design to include and a different reporting standard. For interventions, also pre-specify study design limits and any timeframe or setting restrictions.",
      },
      {
        type: "warning",
        text: "Post-hoc changes to eligibility criteria are a recognised source of bias. Decide now and register them in your protocol before you screen.",
      },
    ],
  },
  inputs: [
    { id: "population", kind: "text", label: "Population", placeholder: "e.g. university students with exam anxiety", required: true },
    { id: "intervention", kind: "text", label: "Intervention", placeholder: "e.g. 8-week mindfulness programme", required: true },
    { id: "comparator", kind: "text", label: "Comparator", placeholder: "e.g. no intervention / usual support" },
    { id: "outcome", kind: "text", label: "Primary outcome", placeholder: "e.g. self-reported exam anxiety score", required: true },
    {
      id: "question",
      kind: "textarea",
      label: "Your review question (one sentence)",
      help: "Combine your PICO into a single, answerable sentence.",
      placeholder: "In …, does … compared with … affect …?",
      required: true,
      rows: 2,
    },
    {
      id: "designLimit",
      kind: "select",
      label: "Eligible study designs",
      level: "advanced",
      placeholder: "Select a design limit…",
      options: [
        { value: "rct", label: "RCTs only" },
        { value: "rct-nrsi", label: "RCTs + non-randomised studies" },
        { value: "any", label: "Any comparative design" },
      ],
    },
  ],
  validations: [
    { id: "pop", kind: "required", field: "population", message: "Name the population your review is about." },
    { id: "int", kind: "required", field: "intervention", message: "Name the intervention you’re evaluating." },
    { id: "out", kind: "required", field: "outcome", message: "Name the primary outcome you’ll measure." },
    { id: "q-len", kind: "minLength", field: "question", min: 15, message: "Write your question as a full sentence (at least 15 characters)." },
    { id: "comp", kind: "required", field: "comparator", severity: "warn", message: "No comparator yet — your question may be hard to search." },
  ],
  optionalAiAssist: {
    id: "pico-helper",
    label: "Refine my PICO",
    description: "Suggests sharper PICO wording grounded in your inputs.",
    promptTemplate:
      "Given Population={population}, Intervention={intervention}, Comparator={comparator}, Outcome={outcome}, propose a sharper one-sentence review question and note any ambiguity.",
  },
};

const feasibility: StepConfig = {
  id: "feasibility",
  title: "Feasibility & saturation check",
  short: "Feasibility",
  subtitle: "Is this review worth doing, and can you actually finish it?",
  glossary: [
    {
      term: "Saturation",
      definition:
        "Whether the existing literature is large/mature enough that another review adds value — or so sparse that a review would be empty.",
    },
  ],
  guide: {
    basic: [
      {
        type: "paragraph",
        text: "A quick scoping search now saves months later. Check whether recent systematic reviews already answer your question, and whether there’s enough primary evidence to synthesise.",
      },
      { type: "tip", text: "Search PROSPERO and a database for existing or in-progress reviews on your exact question before committing." },
    ],
    medium: [
      {
        type: "paragraph",
        text: "If recent high-quality reviews exist, consider whether yours is still justified — a different population, newer trials, or a methodological gap can all justify a new review. State that gap explicitly.",
      },
    ],
    advanced: [
      {
        type: "warning",
        text: "Duplicate reviews without a clear gap are research waste. If two or more current, low-bias reviews already answer your question, an umbrella review or update may be the better design.",
      },
    ],
  },
  tool: "feasibility",
  inputs: [
    { id: "existingReviews", kind: "number", label: "Recent systematic reviews found on this question", help: "Roughly how many current reviews already cover your PICO?", min: 0, required: true },
    { id: "primaryStudies", kind: "number", label: "Approximate primary studies available", help: "A rough count from your scoping search.", min: 0, level: "medium" },
    { id: "gap", kind: "textarea", label: "Why is your review still justified?", placeholder: "e.g. existing reviews predate three large 2024 trials…", rows: 3 },
    { id: "proceed", kind: "checkbox", label: "I’ve done a scoping search and this review is feasible and justified." },
  ],
  validations: [
    { id: "exist", kind: "required", field: "existingReviews", message: "Enter how many existing reviews you found (0 is a valid answer)." },
    { id: "confirm", kind: "mustCheck", field: "proceed", message: "Confirm your scoping check before continuing." },
    { id: "gap-warn", kind: "required", field: "gap", severity: "warn", message: "Consider stating the gap your review fills." },
  ],
};

const protocol: StepConfig = {
  id: "protocol",
  title: "Write & register the protocol",
  short: "Protocol",
  subtitle: "Lock in your methods before you look at the results.",
  glossary: [
    {
      term: "PROSPERO",
      definition:
        "An international registry for systematic review protocols. Registering before screening protects against outcome-switching and selective reporting.",
    },
  ],
  guide: {
    basic: [
      { type: "paragraph", text: "A protocol records what you’ll do — and how — before you do it. Registering it publicly is a hallmark of a trustworthy review." },
      {
        type: "list",
        items: [
          "Your finalised eligibility criteria",
          "Your planned search sources",
          "How you’ll screen, extract, and appraise",
          "Your planned synthesis / analysis approach",
        ],
      },
    ],
    medium: [
      { type: "tip", text: "PROSPERO registration is free and usually accepted within a few weeks. Register before you begin screening." },
    ],
    advanced: [
      { type: "paragraph", text: "Pre-specify subgroup and sensitivity analyses now. Anything decided after seeing the data should be clearly labelled post-hoc in your report." },
    ],
  },
  inputs: [
    {
      id: "registry",
      kind: "select",
      label: "Where will you register?",
      required: true,
      placeholder: "Choose a registry…",
      options: [
        { value: "prospero", label: "PROSPERO" },
        { value: "osf", label: "OSF Registries" },
        { value: "none", label: "Not registering" },
      ],
    },
    { id: "regId", kind: "text", label: "Registration ID (once you have it)", placeholder: "e.g. CRD42026XXXXXX" },
    { id: "eligibility", kind: "textarea", label: "Finalised eligibility criteria", help: "The explicit include/exclude rules a second reviewer would apply.", required: true, rows: 4 },
  ],
  validations: [
    { id: "reg", kind: "required", field: "registry", message: "Choose where you’ll register (or that you won’t)." },
    { id: "elig", kind: "minLength", field: "eligibility", min: 30, message: "Spell out your eligibility criteria in a little more detail." },
  ],
};

const search: StepConfig = {
  id: "search",
  title: "Build the search strategy",
  short: "Search",
  subtitle: "Translate your question into a reproducible, multi-database search.",
  glossary: [
    {
      term: "Boolean operators",
      definition:
        "AND narrows (all terms must appear), OR widens (any term), NOT excludes. Combined with synonyms and database subject headings to balance sensitivity and precision.",
    },
  ],
  guide: {
    basic: [
      { type: "paragraph", text: "A systematic search covers multiple databases so you don’t miss eligible studies. Build the strategy in one database, then translate it to the others." },
      { type: "list", items: ["List synonyms for each PICO concept", "Join synonyms with OR, concepts with AND", "Search at least two databases (e.g. PubMed + Europe PMC)"] },
      { type: "tip", text: "Save every search string verbatim with its date — reproducibility is a PRISMA requirement." },
    ],
    medium: [
      { type: "paragraph", text: "Use database subject headings (e.g. MeSH) alongside free-text terms. Consider searching trial registries and reference lists of included studies to catch grey literature." },
    ],
    advanced: [
      { type: "warning", text: "Over-using NOT or narrow date limits can silently drop eligible studies. Prefer a sensitive search and exclude at screening, where decisions are recorded." },
    ],
  },
  inputs: [],
  tool: "search",
  validations: [
    { id: "nid", kind: "range", field: "nIdentified", min: 1, message: "Run a search to identify records before continuing." },
  ],
};

const dedup: StepConfig = {
  id: "dedup",
  title: "Import & deduplicate records",
  short: "Dedup",
  subtitle: "Bring everything in, then remove duplicates so each study is screened once.",
  guide: {
    basic: [
      { type: "paragraph", text: "The same study often appears in several databases. Remove duplicate records before screening so reviewers don’t screen the same paper twice." },
      { type: "tip", text: "Record the number removed — it’s the first branch of your PRISMA flow diagram." },
    ],
    medium: [
      { type: "paragraph", text: "Automated deduplication (by DOI/title) is a good first pass, but always eyeball near-duplicates: conference abstracts and full papers of the same trial should be linked, not both screened." },
    ],
  },
  inputs: [],
  tool: "dedup",
  validations: [
    { id: "dup", kind: "required", field: "nDuplicates", message: "Run deduplication to continue." },
  ],
};

const screening: StepConfig = {
  id: "screening",
  title: "Title / abstract screening",
  short: "Screen",
  subtitle: "Two reviewers, independently, against your eligibility criteria.",
  glossary: [
    {
      term: "Cohen's kappa",
      definition:
        "A measure of agreement between two reviewers that corrects for chance. Above ~0.6 is substantial; low values mean your criteria need clarifying.",
    },
  ],
  guide: {
    basic: [
      { type: "paragraph", text: "Screen each record’s title and abstract against your eligibility criteria. Use the keyboard to move fast — include, exclude, or undo." },
      { type: "tip", text: "Dual independent screening (two reviewers) with a measured agreement reduces selection bias. Switch reviewers above to double-screen." },
    ],
    medium: [
      { type: "paragraph", text: "Watch the live kappa as both reviewers screen the same records. A low kappa is a signal to pause and clarify your criteria, not to push on." },
    ],
    advanced: [
      { type: "warning", text: "Resolve include/exclude conflicts by discussion or a third reviewer before moving to full text — don’t let the lead reviewer silently overrule." },
    ],
  },
  inputs: [],
  tool: "screening",
  validations: [
    { id: "screened", kind: "range", field: "nScreened", min: 1, message: "Screen at least one record before continuing." },
  ],
};

const fulltext: StepConfig = {
  id: "fulltext",
  title: "Full-text eligibility",
  short: "Full text",
  subtitle: "Confirm eligibility and record every exclusion with a reason.",
  guide: {
    basic: [
      { type: "paragraph", text: "Retrieve the full text of records that passed screening and confirm they truly meet your criteria. Every full-text exclusion needs a recorded reason." },
      { type: "tip", text: "Exclusion reasons are required for the PRISMA flow diagram — capture them as you go." },
    ],
    medium: [
      { type: "paragraph", text: "Group exclusion reasons into a small set (wrong population, wrong comparator, no usable outcome, …) so they tally cleanly in the flow diagram." },
    ],
  },
  tool: "fulltext",
  inputs: [
    { id: "notes", kind: "textarea", label: "Notes", rows: 2, level: "advanced" },
  ],
  validations: [
    { id: "ftx", kind: "required", field: "nFullTextExcluded", message: "Decide full-text eligibility above (every study included or excluded with a reason)." },
  ],
};

const extraction: StepConfig = {
  id: "extraction",
  title: "Data extraction",
  short: "Extract",
  subtitle: "Pull the data you’ll synthesise into a structured, piloted form.",
  guide: {
    basic: [
      { type: "paragraph", text: "Extract study characteristics and outcome data into a consistent form. Extracting enough now means you won’t have to re-read every paper later." },
      { type: "tip", text: "Capture means, SDs, and group sizes (or events/totals) so you can compute effect sizes at the synthesis step." },
    ],
    medium: [
      { type: "paragraph", text: "Extract in duplicate where you can — two people extracting independently catches transcription errors that one person misses." },
    ],
    advanced: [
      { type: "warning", text: "If a study reports an outcome in a form you can’t pool (e.g. medians without spread), record that now and plan how you’ll handle it rather than discovering it at analysis." },
    ],
  },
  inputs: [
    { id: "form", kind: "textarea", label: "What will your extraction form capture?", help: "List the fields: study design, sample size, intervention detail, outcome measure, timepoints…", required: true, rows: 4 },
    { id: "outcomeType", kind: "select", label: "Primary outcome data type", level: "medium", placeholder: "Select…", options: [
      { value: "continuous", label: "Continuous (mean, SD)" },
      { value: "dichotomous", label: "Dichotomous (events / total)" },
    ] },
    { id: "duplicate", kind: "checkbox", label: "Data will be extracted in duplicate.", level: "advanced" },
  ],
  validations: [
    { id: "form-len", kind: "minLength", field: "form", min: 20, message: "Describe the fields your extraction form will capture." },
  ],
};

const appraisal: StepConfig = {
  id: "appraisal",
  title: "Risk-of-bias appraisal",
  short: "Appraise",
  subtitle: "Judge how much to trust each included study, domain by domain.",
  glossary: [
    {
      term: "Risk of bias",
      definition:
        "The degree to which a study’s design or conduct could systematically distort its results. RoB 2 judges five domains for randomised trials and gives an overall rating.",
    },
  ],
  guide: {
    basic: [
      { type: "paragraph", text: "Appraise each included study with the right tool. For randomised trials that’s RoB 2 — judge each domain low, some concerns, or high, and the overall follows the worst domain." },
      { type: "tip", text: "Click a cell to cycle its judgement. Colour is paired with a shape, so the matrix is readable without relying on colour." },
    ],
    medium: [
      { type: "paragraph", text: "Risk of bias is judged per outcome, not just per study — appraise the specific outcome you’ll pool. Non-randomised studies need ROBINS-I or Newcastle-Ottawa instead of RoB 2." },
    ],
    advanced: [
      { type: "warning", text: "Don’t let appraisal become a box-ticking exercise. The judgements should feed your GRADE rating and your interpretation — a body of high-risk studies can’t support a strong conclusion." },
    ],
  },
  inputs: [],
  tool: "appraisal",
  validations: [
    { id: "appr", kind: "range", field: "nAppraised", min: 1, message: "Give at least one included study an overall judgement." },
  ],
};

const synthesis: StepConfig = {
  id: "synthesis",
  title: "Synthesis / meta-analysis",
  short: "Synthesis",
  subtitle: "Combine the evidence — quantitatively only when it’s appropriate.",
  glossary: [
    {
      term: "Heterogeneity (I²)",
      definition:
        "How much study results vary beyond chance. High I² (e.g. >75%) suggests the studies are too different to pool into a single meaningful estimate.",
    },
  ],
  guide: {
    basic: [
      { type: "paragraph", text: "Decide whether to pool results in a meta-analysis or synthesise narratively (SWiM) when studies are too different to combine." },
      { type: "tip", text: "Meta-analysis isn’t always better — pooling clinically diverse studies can produce a precise but meaningless number." },
    ],
    medium: [
      { type: "paragraph", text: "If you pool, inspect heterogeneity (I², τ²) and the forest plot before trusting the summary estimate. A random-effects model is usually the safer default." },
    ],
    advanced: [
      { type: "paragraph", text: "Plan subgroup analyses and sensitivity analyses (e.g. excluding high-risk-of-bias studies) — but only those you pre-specified in your protocol. The validated stats engine lands in the next build stage." },
    ],
  },
  inputs: [
    { id: "approach", kind: "select", label: "Synthesis approach", required: true, placeholder: "Choose…", options: [
      { value: "meta", label: "Meta-analysis (pool quantitatively)" },
      { value: "narrative", label: "Narrative synthesis (SWiM)" },
    ] },
    { id: "model", kind: "select", label: "Meta-analysis model", level: "advanced", placeholder: "Select…", options: [
      { value: "re", label: "Random effects" },
      { value: "fe", label: "Fixed effect" },
    ] },
    { id: "synthNotes", kind: "textarea", label: "Synthesis plan / notes", rows: 3 },
  ],
  tool: "synthesis",
  validations: [
    { id: "appr-req", kind: "required", field: "approach", message: "Choose how you’ll synthesise the evidence." },
  ],
};

const grade: StepConfig = {
  id: "grade",
  title: "Certainty of evidence (GRADE)",
  short: "GRADE",
  subtitle: "Rate how confident readers should be in each outcome.",
  glossary: [
    {
      term: "GRADE",
      definition:
        "A system for rating certainty in evidence (high → very low) per outcome, considering risk of bias, inconsistency, indirectness, imprecision, and publication bias.",
    },
  ],
  guide: {
    basic: [
      { type: "paragraph", text: "GRADE rates how much confidence to place in each outcome’s result — not just whether it’s statistically significant." },
      { type: "list", items: ["Start high for RCT evidence", "Rate down for risk of bias, inconsistency, indirectness, imprecision, publication bias", "Summarise in a Summary-of-Findings table"] },
    ],
    medium: [
      { type: "paragraph", text: "Certainty is judged per outcome, so your primary and secondary outcomes can end up at different levels. Record the reason for each downgrade." },
    ],
  },
  inputs: [
    { id: "certainty", kind: "select", label: "Certainty for the primary outcome", required: true, placeholder: "Rate…", options: [
      { value: "high", label: "High" },
      { value: "moderate", label: "Moderate" },
      { value: "low", label: "Low" },
      { value: "very-low", label: "Very low" },
    ] },
    { id: "downgrades", kind: "textarea", label: "Reasons for any downgrade", level: "medium", rows: 3 },
  ],
  validations: [
    { id: "cert", kind: "required", field: "certainty", message: "Rate the certainty of your primary outcome." },
  ],
};

const report: StepConfig = {
  id: "report",
  title: "PRISMA report & export",
  short: "Report",
  subtitle: "Write up to the standard — your flow diagram is built from your numbers.",
  guide: {
    basic: [
      { type: "paragraph", text: "Assemble your report against the PRISMA 2020 checklist. Your flow diagram below is generated live from the counts you entered along the way." },
      { type: "warning", text: "AI-assisted text is a structured draft to a reporting standard — never “ready to submit.” Review every line and every number." },
    ],
    medium: [
      { type: "paragraph", text: "Check the flow diagram adds up: identified − duplicates = screened; screened − excluded = assessed; assessed − excluded = included. If it doesn’t, fix the source step." },
    ],
  },
  inputs: [
    { id: "confirmChecklist", kind: "checkbox", label: "I’ve checked my report against the PRISMA 2020 checklist." },
  ],
  tool: "prisma",
  validations: [
    { id: "checklist", kind: "mustCheck", field: "confirmChecklist", message: "Confirm your PRISMA checklist review before finishing." },
  ],
};

export const systematicReview: StudyTypeConfig = {
  id: "systematic-review",
  label: "Systematic Review",
  family: "review",
  reportingStandard: "PRISMA-2020",
  steps: [
    question,
    feasibility,
    protocol,
    search,
    dedup,
    screening,
    fulltext,
    extraction,
    appraisal,
    synthesis,
    grade,
    report,
  ],
};
