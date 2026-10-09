/**
 * Paper compiler — assembles a reporting-standard-shaped manuscript from the
 * project's ACTUAL captured data (never invented). Front matter (authors), a
 * factual abstract, one section per pathway step (inputs + tool-output prose),
 * the generated figures/tables, statistical-method citations, and the reference
 * list. The output is explicitly a structured draft, not a submission.
 */
import type { Project } from "@/lib/db/schema";
import type { FieldSchema, StepConfig, StepData, StudyTypeConfig } from "@/lib/study/types";
import type { WorkRecord } from "@/lib/sources/types";
import { synthesisMode, rowsToEffects, type SynthRow } from "@/lib/stats/synthesis";
import { metaAnalyze, interpretI2, displayValue, type EffectMeasure } from "@/lib/stats/meta";

export interface ManuscriptSection {
  /** The pathway step this section came from — lets figures sit with their step. */
  stepId: string;
  heading: string;
  paragraphs: string[];
}

/** Editable front matter for the manuscript (byline, affiliation, correspondence). */
export interface ManuscriptFront {
  authors: string[];
  affiliation: string;
  correspondence: string;
  date: string;
}

export interface Manuscript {
  title: string;
  studyTypeLabel: string;
  reportingStandard: string;
  front: ManuscriptFront;
  /** Factual, data-derived structured abstract (empty when there's nothing yet). */
  abstract: string[];
  sections: ManuscriptSection[];
  references: WorkRecord[];
  /** Formatted statistical-method citations (Vancouver-style strings). */
  methodsCitations: string[];
}

function valueToString(field: FieldSchema, value: unknown): string | null {
  if (value == null || value === "") return null;
  switch (field.kind) {
    case "textarea":
    case "text":
      return String(value).trim() || null;
    case "number":
      return `${field.label}: ${value}${field.unit ? ` ${field.unit}` : ""}`;
    case "select": {
      const opt = field.options.find((o) => o.value === value);
      return opt ? `${field.label}: ${opt.label}` : null;
    }
    case "tags":
      return Array.isArray(value) && value.length ? `${field.label}: ${(value as string[]).join(", ")}` : null;
    case "checkbox":
      return value === true ? `${field.label}` : null;
  }
}

const fmtNum = (v: unknown): string => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? String(n) : "—";
};

const pStr = (p: number): string => (p < 0.001 ? "< 0.001" : `= ${p.toFixed(3)}`);

const MEASURE_LABEL: Record<string, string> = {
  SMD: "standardised mean difference (Hedges' g)",
  MD: "mean difference",
  OR: "odds ratio",
  RR: "risk ratio",
};

const ROB_DOMAINS = ["d1", "d2", "d3", "d4", "d5"] as const;
type RobRow = Record<string, "low" | "some-concern" | "high">;

/** RoB 2 overall = worst domain (undefined until all five are judged). */
function robOverall(row: RobRow): "low" | "some-concern" | "high" | undefined {
  if (ROB_DOMAINS.some((k) => !row[k])) return undefined;
  if (ROB_DOMAINS.some((k) => row[k] === "high")) return "high";
  if (ROB_DOMAINS.some((k) => row[k] === "some-concern")) return "some-concern";
  return "low";
}

/** Narrative for the risk-of-bias appraisal step, computed from the judgements. */
function robSummary(judgements: Record<string, RobRow>): string[] {
  const rows = Object.values(judgements);
  const n = rows.length;
  if (n === 0) return [];
  const out: string[] = [
    `Risk of bias was assessed for ${n} included stud${n === 1 ? "y" : "ies"} across five RoB 2 domains: ` +
      `randomisation process (D1), deviations from intended interventions (D2), missing outcome data (D3), ` +
      `measurement of the outcome (D4), and selection of the reported result (D5).`,
  ];
  const overalls = rows.map(robOverall).filter((o): o is NonNullable<typeof o> => o != null);
  if (overalls.length) {
    const c = { low: 0, "some-concern": 0, high: 0 };
    for (const o of overalls) c[o]++;
    out.push(
      `Overall, ${c.low} stud${c.low === 1 ? "y was" : "ies were"} judged at low risk of bias, ` +
        `${c["some-concern"]} raised some concerns, and ${c.high} ${c.high === 1 ? "was" : "were"} at high risk of bias ` +
        `(see the risk-of-bias table).`,
    );
  }
  return out;
}

/** Full synthesis Methods + Results prose, recomputed from the captured rows. */
function synthesisSummary(d: StepData, project: Project): { paragraphs: string[]; citations: string[] } {
  const rows = d.rows as SynthRow[] | undefined;
  const mode = synthesisMode(project);
  const effects = rows ? rowsToEffects(rows, mode) : [];
  if (effects.length === 0) {
    // Fall back to persisted scalars if the tool ran but rows aren't present.
    if (d.pooledEstimate == null) return { paragraphs: [], citations: [] };
    const measure = (d.effectMeasure as string) || "SMD";
    const exp = measure === "OR" || measure === "RR";
    const est = (exp ? Math.exp(Number(d.pooledEstimate)) : Number(d.pooledEstimate)).toFixed(2);
    const label = MEASURE_LABEL[measure] ?? measure;
    return {
      paragraphs: [`Random-effects synthesis gave a pooled ${label} of ${est} (I² = ${Number(d.i2 ?? 0).toFixed(0)}%).`],
      citations: [],
    };
  }

  const r = metaAnalyze(effects, mode.measure);
  const exp = mode.measure === "OR" || mode.measure === "RR";
  const tx = (v: number) => displayValue(v, mode.measure).toFixed(2);
  const label = MEASURE_LABEL[mode.measure] ?? mode.measure;
  const ci = r.hksj ?? r.random;

  const methods =
    `Effect estimates were expressed as the ${label} for each study. ` +
    `Studies were pooled with a random-effects model, estimating the between-study variance (τ²) by the ` +
    `DerSimonian and Laird method of moments; ${r.hksj ? "the confidence interval used the Hartung-Knapp-Sidik-Jonkman adjustment, recommended for a small number of studies. " : ""}` +
    `Statistical heterogeneity was quantified with the I² statistic and Cochran's Q test. ` +
    `Small-study effects were examined with a funnel plot${r.egger ? " and Egger's regression test" : ""}.`;

  const results =
    `Pooling ${r.k} stud${r.k === 1 ? "y" : "ies"} yielded a ${label} of ${tx(r.random.estimate)} ` +
    `(95% CI ${tx(ci.ciLow)} to ${tx(ci.ciHigh)}${r.hksj ? ", Hartung-Knapp" : ""}; p ${pStr(ci.p)}). ` +
    `Heterogeneity was I² = ${r.random.i2.toFixed(0)}% (${interpretI2(r.random.i2).toLowerCase()}), ` +
    `τ² = ${r.random.tau2.toFixed(3)}, Q = ${r.random.Q.toFixed(2)} on ${r.random.df} df (p ${pStr(r.random.pQ)}).` +
    (r.egger ? ` Egger's test intercept was ${r.egger.intercept.toFixed(2)} (t = ${r.egger.t.toFixed(2)}), ${r.egger.asymmetrySuspected ? "suggesting possible funnel-plot asymmetry" : "with no strong evidence of asymmetry"}.` : "");

  const assumptions =
    `This synthesis assumes independent studies whose true effects vary (random effects), with ` +
    `${exp ? "log-scale effects" : "effects"} approximately normally distributed. ` +
    `The pooled estimate should be read alongside the forest and funnel plots and the risk-of-bias assessment.`;

  return { paragraphs: [methods, results, assumptions], citations: statisticalCitations(r.measure, !!r.hksj, !!r.egger) };
}

/** Vancouver-style citations for the statistical methods actually used. */
function statisticalCitations(measure: EffectMeasure, hksj: boolean, egger: boolean): string[] {
  const cites = [
    "DerSimonian R, Laird N. Meta-analysis in clinical trials. Control Clin Trials. 1986;7(3):177-188.",
    "Higgins JPT, Thompson SG. Quantifying heterogeneity in a meta-analysis. Stat Med. 2002;21(11):1539-1558.",
  ];
  if (measure === "SMD") cites.push("Hedges LV, Olkin I. Statistical Methods for Meta-Analysis. Orlando: Academic Press; 1985.");
  if (hksj) cites.push("Hartung J, Knapp G. A refined method for the meta-analysis of controlled clinical trials with a binary outcome. Stat Med. 2001;20(24):3875-3889.");
  if (egger) cites.push("Egger M, Davey Smith G, Schneider M, Minder C. Bias in meta-analysis detected by a simple, graphical test. BMJ. 1997;315(7109):629-634.");
  return cites;
}

/** Short prose summaries of tool outputs, drawn from the step's captured data. */
function toolSummary(step: StepConfig, d: StepData, project: Project, collectCites: (c: string[]) => void): string[] {
  const out: string[] = [];
  switch (step.tool) {
    case "search":
      if (d.nIdentified != null) {
        const dbs = (d.databases as string[] | undefined)?.length ? ` (${(d.databases as string[]).join(", ")})` : "";
        out.push(`The search identified ${fmtNum(d.nIdentified)} records across the selected databases${dbs}.`);
      }
      break;
    case "dedup":
      if (d.nDuplicates != null) out.push(`After removing ${fmtNum(d.nDuplicates)} duplicate records, the remaining records were screened.`);
      break;
    case "screening":
      if (d.nScreened != null)
        out.push(`${fmtNum(d.nScreened)} records were screened; ${fmtNum(d.nIncludedScreening)} were included and ${fmtNum(d.nExcludedScreening)} excluded at title/abstract stage.`);
      break;
    case "fulltext":
      if (d.nFullTextExcluded != null) out.push(`Full texts were assessed for eligibility; ${fmtNum(d.nFullTextExcluded)} were excluded with reasons.`);
      break;
    case "appraisal":
      out.push(...robSummary((d.judgements as Record<string, RobRow>) ?? {}));
      break;
    case "synthesis": {
      const { paragraphs, citations } = synthesisSummary(d, project);
      out.push(...paragraphs);
      if (citations.length) collectCites(citations);
      break;
    }
    case "consort":
      if (d.nRandomised != null) out.push(`${fmtNum(d.nRandomised)} participants were randomised.`);
      break;
    case "reliability":
      if (d.alpha != null) out.push(`Internal consistency was acceptable (Cronbach's α = ${Number(d.alpha).toFixed(2)}).`);
      break;
    case "coding":
      if (d.themeCount != null) out.push(`Thematic analysis produced ${fmtNum(d.themeCount)} themes.`);
      break;
    case "diagnostic":
      if (d.tp != null && d.tn != null) {
        const tp = Number(d.tp), fp = Number(d.fp), fn = Number(d.fn), tn = Number(d.tn);
        const sens = tp / (tp + fn), spec = tn / (tn + fp);
        if (Number.isFinite(sens) && Number.isFinite(spec))
          out.push(`The index test had a sensitivity of ${(sens * 100).toFixed(1)}% and specificity of ${(spec * 100).toFixed(1)}% against the reference standard.`);
      }
      break;
  }
  return out;
}

function compileSection(step: StepConfig, project: Project, collectCites: (c: string[]) => void): ManuscriptSection {
  const data = (project.stepData[step.id] as StepData) ?? {};
  const paragraphs: string[] = [];
  for (const field of step.inputs) {
    const s = valueToString(field, data[field.id]);
    if (s) paragraphs.push(s);
  }
  paragraphs.push(...toolSummary(step, data, project, collectCites));
  return { stepId: step.id, heading: step.title, paragraphs };
}

/** Build a short, strictly factual structured abstract from present data only. */
function buildAbstract(config: StudyTypeConfig, project: Project): string[] {
  const step = (id: string): StepData => (project.stepData[id] as StepData) ?? {};
  const q = step("question");
  const search = step("search");
  const screening = step("screening");
  const fulltext = step("fulltext");
  const synthesis = step("synthesis");
  const out: string[] = [];

  const background =
    typeof q.question === "string" && q.question.trim()
      ? q.question.trim()
      : [q.population, q.intervention, q.comparator, q.outcome].filter((v) => typeof v === "string" && v).join("; ");
  if (background) out.push(`Background: ${background}`);

  const methodBits: string[] = [`following the ${config.reportingStandard} reporting standard`];
  const dbs = search.databases as string[] | undefined;
  if (dbs?.length) methodBits.push(`${dbs.join(", ")} were searched`);
  out.push(`Methods: We conducted a ${config.label.toLowerCase()}, ${methodBits.join("; ")}.`);

  const resultBits: string[] = [];
  if (search.nIdentified != null) resultBits.push(`${fmtNum(search.nIdentified)} records were identified`);
  const included = fulltext.includedRecords as unknown[] | undefined;
  if (included?.length) resultBits.push(`${included.length} studies were included`);
  else if (screening.nIncludedScreening != null) resultBits.push(`${fmtNum(screening.nIncludedScreening)} records advanced to full-text review`);
  if (synthesis.pooledEstimate != null) {
    const measure = (synthesis.effectMeasure as string) || "SMD";
    const exp = measure === "OR" || measure === "RR";
    const est = (exp ? Math.exp(Number(synthesis.pooledEstimate)) : Number(synthesis.pooledEstimate)).toFixed(2);
    resultBits.push(`the pooled ${MEASURE_LABEL[measure] ?? measure} was ${est} (I² = ${Number(synthesis.i2 ?? 0).toFixed(0)}%)`);
  }
  if (resultBits.length) out.push(`Results: ${resultBits.join("; ")}.`);

  return out;
}

export function compileManuscript(
  config: StudyTypeConfig,
  project: Project,
  front?: Partial<ManuscriptFront>,
): Manuscript {
  const methodsCitations: string[] = [];
  const collectCites = (c: string[]) => {
    for (const cite of c) if (!methodsCitations.includes(cite)) methodsCitations.push(cite);
  };

  const sections = config.steps
    .map((s) => compileSection(s, project, collectCites))
    .filter((s) => s.paragraphs.length > 0);

  const dedup = (project.stepData["dedup"] as StepData)?.records as WorkRecord[] | undefined;
  const search = (project.stepData["search"] as StepData)?.records as WorkRecord[] | undefined;
  const references = dedup?.length ? dedup : search?.length ? search : [];

  return {
    title: project.title,
    studyTypeLabel: config.label,
    reportingStandard: config.reportingStandard,
    front: {
      authors: (front?.authors ?? []).filter((a) => a.trim() !== ""),
      affiliation: front?.affiliation?.trim() ?? "",
      correspondence: front?.correspondence?.trim() ?? "",
      date: front?.date ?? new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }),
    },
    abstract: buildAbstract(config, project),
    sections,
    references,
    methodsCitations,
  };
}

export const INTEGRITY_NOTE =
  "This is an AI-assisted structured draft compiled to a reporting standard from your own project data — not a finished manuscript. Review and verify every statement, number, and citation before use.";
