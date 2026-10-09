import { type ReactNode } from "react";
import { useTheme } from "@/lib/theme/theme-store";
import { chartPalette } from "@/components/charts/palette";
import { ForestPlot } from "@/components/charts/ForestPlot";
import { FunnelPlot } from "@/components/charts/FunnelPlot";
import { BarChart, type Bar } from "@/components/charts/BarChart";
import { RocCurve } from "@/components/charts/RocCurve";
import { PrismaFlow } from "@/components/runner/tools/PrismaFlow";
import { buildConsortSvg, buildStrobeSvg } from "@/lib/paper/flow-svg";
import { metaAnalyze, displayValue, type MetaResult } from "@/lib/stats/meta";
import { rowsToEffects, synthesisMode, type SynthRow } from "@/lib/stats/synthesis";
import { rocAuc, type RocPoint } from "@/lib/stats/diagnostics";
import { includedStudies, recordLabelMap } from "@/lib/study/included";
import { robVisual, type RobLevel } from "@/components/appraisal/TrafficLight";
import type { VolumeResult } from "@/lib/sources/openalex";
import type { Project } from "@/lib/db/schema";
import type { StepData, StudyTypeConfig } from "@/lib/study/types";

const ROB_DOMAINS = [
  { key: "d1", code: "D1" },
  { key: "d2", code: "D2" },
  { key: "d3", code: "D3" },
  { key: "d4", code: "D4" },
  { key: "d5", code: "D5" },
] as const;

/** A figure/table descriptor, tagged with the pathway step it belongs to so the
 *  manuscript can place it alongside that step's text (not all at the end). */
export interface ReportFigure {
  id: string;
  /** The step this figure is pulled from. */
  stepId: string;
  caption: string;
  node: ReactNode;
}

/** One captioned figure/table. `data-fig` + `data-step` let the exporter find,
 *  serialise, and place it within the right section. */
export function Figure({ id, stepId, n, caption, children }: { id: string; stepId: string; n: number; caption: string; children: ReactNode }) {
  return (
    <figure data-fig={id} data-step={stepId} className="mt-4 flex flex-col gap-1.5">
      <div className="rounded-card">{children}</div>
      <figcaption className="text-sm text-ink-soft">
        <span className="font-semibold text-ink">Figure {n}.</span> {caption}
      </figcaption>
    </figure>
  );
}

function RawSvg({ svg }: { svg: string }) {
  return <div className="overflow-x-auto rounded-card bg-elevated/40 p-3" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/**
 * Every figure and table the project generated, each tagged with the pathway
 * step it is pulled from so the manuscript can place it alongside that step's
 * text: the reporting-standard flow diagram (study selection), the forest +
 * funnel plots and per-study table (synthesis), the risk-of-bias table
 * (appraisal), the ROC curve (results), and the saturation chart (feasibility).
 * Each appears only when its underlying data exists. Recomputed from persisted
 * step data (single source of truth), so nothing goes stale.
 */
export function useReportFigures(project: Project | null, config: StudyTypeConfig | null): ReportFigure[] {
  const mode = useTheme((s) => s.mode);
  const palette = chartPalette(mode);
  const figures: ReportFigure[] = [];
  if (!project || !config) return figures;
  const step = (id: string): StepData => (project.stepData[id] as StepData) ?? {};

  // --- Study-flow diagram (by reporting standard) → study-selection step -----
  const std = config.reportingStandard;
  if (std.includes("PRISMA")) {
    figures.push({ id: "flow-prisma", stepId: "screening", caption: `${std} study-selection flow diagram.`, node: <PrismaFlow /> });
  } else if (std.includes("CONSORT")) {
    const flow = step("flow");
    if (flow.nRandomised != null) {
      figures.push({ id: "flow-consort", stepId: "flow", caption: "CONSORT participant-flow diagram.", node: <RawSvg svg={buildConsortSvg(flow, palette)} /> });
    }
  } else if (std === "STROBE") {
    const analysis = step("analysis");
    if (analysis.sfAssessed != null || analysis.sfIncluded != null) {
      figures.push({ id: "flow-strobe", stepId: "analysis", caption: "STROBE participant-flow diagram.", node: <RawSvg svg={buildStrobeSvg(analysis, palette)} /> });
    }
  }

  // --- Meta-analysis: forest, funnel, study table → synthesis step -----------
  const synthRows = (step("synthesis").rows as SynthRow[] | undefined) ?? [];
  const mode2 = synthesisMode(project);
  const effects = rowsToEffects(synthRows, mode2);
  if (effects.length > 0) {
    const m = metaAnalyze(effects, mode2.measure);
    figures.push({ id: "forest", stepId: "synthesis", caption: `Forest plot (random-effects) of the pooled ${m.measure}.`, node: <ForestPlot result={m} /> });
    if (m.studies.length >= 3) {
      figures.push({ id: "funnel", stepId: "synthesis", caption: "Funnel plot for small-study/publication-bias assessment.", node: <FunnelPlot result={m} /> });
    }
    figures.push({ id: "meta-table", stepId: "synthesis", caption: `Per-study effect estimates and weights (${m.measure}).`, node: <MetaTable result={m} /> });
  }

  // --- Risk-of-bias table → appraisal step -----------------------------------
  const judgements = step("appraisal").judgements as Record<string, Record<string, RobLevel>> | undefined;
  if (judgements && Object.keys(judgements).length > 0) {
    figures.push({ id: "rob-table", stepId: "appraisal", caption: "Risk-of-bias judgements by study and domain.", node: <RobTable project={project} judgements={judgements} /> });
  }

  // --- Diagnostic ROC curve → results step -----------------------------------
  const results = step("results");
  const rocRows = results.rocRows as { sens: string; spec: string }[] | undefined;
  const points: RocPoint[] = (rocRows ?? [])
    .map((r) => ({ fpr: 1 - Number(r.spec), tpr: Number(r.sens) }))
    .filter((q) => [q.fpr, q.tpr].every((v) => Number.isFinite(v) && v >= 0 && v <= 1));
  if (points.length > 0) {
    figures.push({ id: "roc", stepId: "results", caption: "Receiver operating characteristic (ROC) curve.", node: <RocCurve points={points} auc={rocAuc(points)} /> });
  }

  // --- Saturation / feasibility chart → feasibility step ---------------------
  const vol = step("feasibility").scopingVolume as VolumeResult | undefined;
  if (vol?.byYear?.length) {
    const bars: Bar[] = vol.byYear.map((y) => ({ label: String(y.year), value: y.count }));
    figures.push({ id: "saturation", stepId: "feasibility", caption: "Publications per year (feasibility / saturation scan).", node: <BarChart bars={bars} title="Publications per year" /> });
  }

  return figures;
}

function MetaTable({ result }: { result: MetaResult }) {
  const d = (v: number) => displayValue(v, result.measure).toFixed(2);
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="text-ink-muted">
          <th className="border border-hairline px-2 py-1 text-left font-medium">Study</th>
          <th className="border border-hairline px-2 py-1 text-right font-medium">{result.measure}</th>
          <th className="border border-hairline px-2 py-1 text-right font-medium">95% CI</th>
          <th className="border border-hairline px-2 py-1 text-right font-medium">Weight</th>
        </tr>
      </thead>
      <tbody>
        {result.studies.map((s) => (
          <tr key={s.id}>
            <td className="border border-hairline px-2 py-1 text-ink">{s.label}</td>
            <td className="num-tabular border border-hairline px-2 py-1 text-right">{d(s.yi)}</td>
            <td className="num-tabular border border-hairline px-2 py-1 text-right">{d(s.ciLow)} to {d(s.ciHigh)}</td>
            <td className="num-tabular border border-hairline px-2 py-1 text-right">{s.weightPct.toFixed(1)}%</td>
          </tr>
        ))}
        <tr className="font-semibold">
          <td className="border border-hairline px-2 py-1">
            Pooled (random effects{result.hksj ? ", HKSJ" : ""})
          </td>
          <td className="num-tabular border border-hairline px-2 py-1 text-right">{d(result.random.estimate)}</td>
          <td className="num-tabular border border-hairline px-2 py-1 text-right">
            {d((result.hksj ?? result.random).ciLow)} to {d((result.hksj ?? result.random).ciHigh)}
          </td>
          <td className="num-tabular border border-hairline px-2 py-1 text-right">100%</td>
        </tr>
      </tbody>
    </table>
  );
}

function RobTable({ project, judgements }: { project: Project; judgements: Record<string, Record<string, RobLevel>> }) {
  // Every appraised study gets a row with a real "Author Year" name: use the
  // included-set label first, else resolve the id against all record pools, and
  // only fall back to the raw id if the record is truly unknown.
  const included = includedStudies(project);
  const includedLabel = new Map(included.map((s) => [s.id, s.label]));
  const poolLabel = recordLabelMap(project);
  const labelFor = (id: string) => includedLabel.get(id) ?? poolLabel.get(id) ?? id;
  const includedIds = new Set(included.map((s) => s.id));
  // Included studies (in their alphabetical order) first, then any extra judged
  // studies not in the current included set.
  const studies = [
    ...included.filter((s) => judgements[s.id]).map((s) => ({ id: s.id, label: s.label })),
    ...Object.keys(judgements)
      .filter((id) => !includedIds.has(id))
      .map((id) => ({ id, label: labelFor(id) }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
  ];
  const label = (lvl?: RobLevel) => (lvl ? robVisual[lvl].label : "—");
  const overall = (row?: Record<string, RobLevel>): RobLevel | undefined => {
    if (!row || ROB_DOMAINS.some((d) => !row[d.key])) return undefined;
    if (ROB_DOMAINS.some((d) => row[d.key] === "high")) return "high";
    if (ROB_DOMAINS.some((d) => row[d.key] === "some-concern")) return "some-concern";
    return "low";
  };
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="text-ink-muted">
          <th className="border border-hairline px-2 py-1 text-left font-medium">Study</th>
          {ROB_DOMAINS.map((d) => (
            <th key={d.key} className="border border-hairline px-2 py-1 text-center font-medium">{d.code}</th>
          ))}
          <th className="border border-hairline px-2 py-1 text-center font-medium">Overall</th>
        </tr>
      </thead>
      <tbody>
        {studies.map((s) => {
          const row = judgements[s.id];
          return (
            <tr key={s.id}>
              <td className="border border-hairline px-2 py-1 text-ink">{s.label}</td>
              {ROB_DOMAINS.map((d) => (
                <td key={d.key} className="border border-hairline px-2 py-1 text-center text-ink-soft">{label(row?.[d.key])}</td>
              ))}
              <td className="border border-hairline px-2 py-1 text-center font-medium text-ink">{label(overall(row))}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
