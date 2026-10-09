/**
 * Reporting-standard checklist library. Condensed, paraphrased prompts derived
 * from each EQUATOR guideline — a practical working checklist, NOT the official
 * verbatim instrument. Always confirm against the source at
 * https://www.equator-network.org before submission. Keyed by a config's
 * `reportingStandard`; unmatched standards fall back to GENERIC.
 */
export interface ChecklistItem {
  id: string;
  text: string;
}
export interface ChecklistSection {
  title: string;
  items: ChecklistItem[];
}

const s = (title: string, items: [string, string][]): ChecklistSection => ({
  title,
  items: items.map(([id, text]) => ({ id, text })),
});

const GENERIC: ChecklistSection[] = [
  s("Title & abstract", [["ta1", "Study design identifiable in the title"], ["ta2", "Structured abstract covering aim, methods, results, conclusion"]]),
  s("Introduction", [["in1", "Background and rationale"], ["in2", "Explicit objectives / questions"]]),
  s("Methods", [["me1", "Design and setting"], ["me2", "Participants / data sources & eligibility"], ["me3", "Variables, measurement, and bias control"], ["me4", "Analysis methods (pre-specified)"]]),
  s("Results", [["re1", "Participant / study flow and descriptive data"], ["re2", "Main results with precision (CIs)"]]),
  s("Discussion", [["di1", "Key findings vs objectives"], ["di2", "Limitations and bias"], ["di3", "Interpretation and generalisability"]]),
  s("Other", [["ot1", "Funding and conflicts of interest"], ["ot2", "Registration / protocol and data availability"]]),
];

const PRISMA_2020: ChecklistSection[] = [
  s("Title & abstract", [["p1", "Identify the report as a systematic review"], ["p2", "Structured abstract (PRISMA-A)"]]),
  s("Introduction", [["p3", "Rationale for the review"], ["p4", "Objectives with a PICO/eligibility framework"]]),
  s("Methods", [
    ["p5", "Eligibility criteria and grouping"],
    ["p6", "Information sources and last-search dates"],
    ["p7", "Full search strategy for ≥1 database"],
    ["p8", "Selection process (screeners, tools, blinding)"],
    ["p9", "Data-collection process and items"],
    ["p10", "Risk-of-bias assessment method"],
    ["p11", "Effect measures and synthesis methods (incl. heterogeneity)"],
    ["p12", "Reporting-bias and certainty (GRADE) assessment"],
  ]),
  s("Results", [
    ["p13", "Study selection with a PRISMA flow diagram"],
    ["p14", "Study characteristics and risk of bias"],
    ["p15", "Results of syntheses (forest plots, heterogeneity)"],
    ["p16", "Reporting-bias and certainty of evidence"],
  ]),
  s("Discussion & other", [["p17", "Interpretation, limitations"], ["p18", "Registration (PROSPERO), protocol, funding, COI, data availability"]]),
];

const PRISMA_SCR: ChecklistSection[] = [
  s("Introduction", [["sc1", "Rationale and objectives (population, concept, context)"]]),
  s("Methods", [["sc2", "Protocol and eligibility"], ["sc3", "Information sources and search"], ["sc4", "Selection and charting process"], ["sc5", "Data items and synthesis approach (no risk-of-bias required)"]]),
  s("Results", [["sc6", "Selection (PRISMA-ScR flow)"], ["sc7", "Characteristics and results of sources of evidence"]]),
  s("Discussion", [["sc8", "Summary, limitations, implications"], ["sc9", "Funding and registration"]]),
];

const SANRA: ChecklistSection[] = [
  s("Narrative review quality (SANRA)", [
    ["sa1", "Justification of the article's importance"],
    ["sa2", "Statement of concrete aims or questions"],
    ["sa3", "Description of the literature search"],
    ["sa4", "Referencing of key statements"],
    ["sa5", "Scientific reasoning (evidence appraised, not just cited)"],
    ["sa6", "Appropriate presentation of data / findings"],
  ]),
];

const STROBE: ChecklistSection[] = [
  s("Title & abstract", [["st1", "Design in title/abstract; informative summary"]]),
  s("Introduction", [["st2", "Background/rationale"], ["st3", "Objectives and hypotheses"]]),
  s("Methods", [
    ["st4", "Study design and setting/dates"],
    ["st5", "Eligibility; sources and selection"],
    ["st6", "Variables: outcomes, exposures, confounders"],
    ["st7", "Measurement / data sources"],
    ["st8", "Bias, study size, quantitative handling of variables"],
    ["st9", "Statistical methods, confounding, missing data"],
  ]),
  s("Results", [["st10", "Participant flow and descriptive data"], ["st11", "Outcome data and main results (adjusted estimates + CIs)"]]),
  s("Discussion & other", [["st12", "Key results, limitations, interpretation, generalisability"], ["st13", "Funding"]]),
];

const CONSORT: ChecklistSection[] = [
  s("Title & abstract", [["c1", "Identified as a randomised trial; structured abstract"]]),
  s("Introduction", [["c2", "Background and objectives"]]),
  s("Methods", [
    ["c3", "Trial design and any changes"],
    ["c4", "Participants, settings, interventions"],
    ["c5", "Primary/secondary outcomes"],
    ["c6", "Sample size"],
    ["c7", "Randomisation: sequence, allocation concealment, implementation"],
    ["c8", "Blinding"],
    ["c9", "Statistical methods"],
  ]),
  s("Results", [["c10", "Participant flow (CONSORT diagram) and recruitment"], ["c11", "Baseline data, numbers analysed"], ["c12", "Outcomes, estimation (effect size + CI), harms"]]),
  s("Discussion & other", [["c13", "Limitations, generalisability, interpretation"], ["c14", "Registration, protocol, funding"]]),
];

const TREND: ChecklistSection[] = [
  s("Methods (non-randomised, TREND)", [
    ["tr1", "Theories used to design the intervention"],
    ["tr2", "Eligibility and non-random assignment method"],
    ["tr3", "Units of assignment and analysis"],
    ["tr4", "Comparability of groups; adjustment for confounders"],
  ]),
  s("Results & discussion", [["tr5", "Participant flow and baseline equivalence"], ["tr6", "Outcomes with effect sizes and CIs"], ["tr7", "Limitations of non-random design"]]),
];

const CARE: ChecklistSection[] = [
  s("Case report (CARE)", [
    ["ca1", "'Case report' in the title; structured abstract"],
    ["ca2", "Patient information and de-identified demographics"],
    ["ca3", "Clinical findings and timeline"],
    ["ca4", "Diagnostic assessment and reasoning"],
    ["ca5", "Therapeutic intervention"],
    ["ca6", "Follow-up and outcomes (incl. patient-reported)"],
    ["ca7", "Discussion, takeaway, and informed consent"],
  ]),
];

const STARD: ChecklistSection[] = [
  s("Diagnostic accuracy (STARD)", [
    ["sd1", "Identified as a diagnostic accuracy study; structured abstract"],
    ["sd2", "Research question (index test vs reference standard, in whom)"],
    ["sd3", "Eligibility, setting, and participant sampling"],
    ["sd4", "Index test and reference standard (with rationale, blinding)"],
    ["sd5", "Methods for estimating/comparing accuracy; sample size"],
    ["sd6", "Participant flow (STARD diagram) and 2×2 cross-tabulation"],
    ["sd7", "Estimates of accuracy with precision (e.g. sensitivity/specificity + CIs)"],
    ["sd8", "Limitations, applicability, registration, funding"],
  ]),
];

const QUAL: ChecklistSection[] = [
  s("Qualitative (SRQR / COREQ)", [
    ["q1", "Research team, reflexivity, and relationship to participants"],
    ["q2", "Theoretical framework / methodological orientation"],
    ["q3", "Participant selection and setting"],
    ["q4", "Data collection (guide, recording, saturation)"],
    ["q5", "Analysis: coding, deriving themes, software, trustworthiness"],
    ["q6", "Findings with participant quotations"],
    ["q7", "Reflexive discussion and ethics"],
  ]),
];

const CHERRIES: ChecklistSection[] = [
  s("Survey (CHERRIES)", [
    ["ch1", "Design, IRB approval, and informed consent"],
    ["ch2", "Development, pre-testing, and mode of the survey"],
    ["ch3", "Recruitment, sample frame, and voluntariness"],
    ["ch4", "Response rates (view/participation/completion) and how computed"],
    ["ch5", "Handling of incomplete responses and analysis"],
  ]),
];

const GRAMMS: ChecklistSection[] = [
  s("Mixed methods (GRAMMS)", [
    ["g1", "Justification for a mixed-methods design"],
    ["g2", "Design: priority, sequence, and purpose of integration"],
    ["g3", "Each method described (sampling, collection, analysis)"],
    ["g4", "Where and how integration occurred"],
    ["g5", "Limitations of one method addressed by the other; inferences"],
  ]),
];

const CHEERS: ChecklistSection[] = [
  s("Economic evaluation (CHEERS)", [
    ["e1", "Study question, perspective, and target population"],
    ["e2", "Comparators, time horizon, and discount rate"],
    ["e3", "Outcomes, effectiveness, and resource/cost valuation"],
    ["e4", "Model, assumptions, and analytics"],
    ["e5", "Incremental costs/outcomes and uncertainty (sensitivity analysis)"],
    ["e6", "Funding and conflicts of interest"],
  ]),
];

const ARRIVE: ChecklistSection[] = [
  s("Animal research (ARRIVE 2.0 essentials)", [
    ["a1", "Study design: groups, experimental unit"],
    ["a2", "Sample size and how determined"],
    ["a3", "Inclusion/exclusion criteria"],
    ["a4", "Randomisation and blinding"],
    ["a5", "Outcome measures"],
    ["a6", "Statistical methods"],
    ["a7", "Animals: species, strain, sex, age, source"],
    ["a8", "Experimental procedures and results with variability"],
  ]),
];

export const CHECKLISTS: Record<string, ChecklistSection[]> = {
  "PRISMA-2020": PRISMA_2020,
  "PRISMA-ScR": PRISMA_SCR,
  SANRA,
  STROBE,
  "CONSORT-2010": CONSORT,
  TREND,
  CARE,
  STARD,
  "SRQR / COREQ": QUAL,
  CHERRIES,
  GRAMMS,
  CHEERS,
  ARRIVE,
  NONE: GENERIC,
};

export function checklistFor(standard: string): ChecklistSection[] {
  return CHECKLISTS[standard] ?? GENERIC;
}

/** Total number of checklist items for a standard. */
export function checklistTotal(sections: ChecklistSection[]): number {
  return sections.reduce((n, sec) => n + sec.items.length, 0);
}
