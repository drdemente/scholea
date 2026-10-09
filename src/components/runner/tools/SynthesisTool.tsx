import { useEffect, useMemo, useState } from "react";
import { BookText, Download, Plus, Trash2, FlaskConical } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { ForestPlot } from "@/components/charts/ForestPlot";
import { FunnelPlot } from "@/components/charts/FunnelPlot";
import { useProject } from "@/lib/study/project-store";
import { includedStudies, hasRealStudies } from "@/lib/study/included";
import { runMetaAnalysis } from "@/lib/workers/stats-client";
import { hasSparseEvents, mantelHaenszel, type EffectMeasure, type MetaResult, type MhResult } from "@/lib/stats/meta";
import { rowsToEffects, rowsToTables, synthesisMode, type SynthRow } from "@/lib/stats/synthesis";
import { webrRandomEffects, type WebRMeta } from "@/lib/stats/webr";
import type { StepData } from "@/lib/study/types";

type Row = SynthRow;

const SEED_CONT: Row[] = [
  { id: "s1", label: "Hassan 2025", m1: "13", sd1: "4", n1: "27", m2: "17", sd2: "4.5", n2: "27" },
  { id: "s2", label: "Nakamura 2025", m1: "15", sd1: "4.8", n1: "82", m2: "17.5", sd2: "5", n2: "82" },
  { id: "s3", label: "Okafor 2024", m1: "14", sd1: "5", n1: "106", m2: "18", sd2: "5.2", n2: "106" },
  { id: "s4", label: "Romero 2024", m1: "20", sd1: "6", n1: "45", m2: "22", sd2: "6.1", n2: "45" },
];
const SEED_DICH: Row[] = [
  { id: "s1", label: "Hassan 2025", ev1: "12", tot1: "60", ev2: "20", tot2: "60" },
  { id: "s2", label: "Nakamura 2025", ev1: "18", tot1: "90", ev2: "27", tot2: "88" },
  { id: "s3", label: "Okafor 2024", ev1: "25", tot1: "106", ev2: "40", tot2: "106" },
  { id: "s4", label: "Romero 2024", ev1: "8", tot1: "45", ev2: "15", tot2: "45" },
];

const emptyRow = (id: string, label: string): Row => ({ id, label });

/** Column layout per outcome type — drives both the header and the cell inputs. */
const CONT_COLS: (keyof Row)[] = ["m1", "sd1", "n1", "m2", "sd2", "n2"];
const DICH_COLS: (keyof Row)[] = ["ev1", "tot1", "ev2", "tot2"];

/**
 * Meta-analysis workspace. The input fields follow the outcome type chosen in
 * the data-extraction step (or the effect measure chosen for a meta-analysis):
 * continuous outcomes take means/SDs/group sizes (pooled as an SMD or raw mean
 * difference); dichotomous outcomes take events/totals (pooled as an odds ratio
 * or risk ratio). Pooling runs on the validated engine off the main thread, with
 * a forest + funnel plot and full method transparency.
 */
export function SynthesisTool({ stepId }: { stepId: string }) {
  const project = useProject((s) => s.project);
  const setField = useProject((s) => s.setField);
  const persist = useProject((s) => s.persist);

  // Resolve the outcome type + effect measure from earlier steps (shared with
  // the compiled report so both compute the same effects).
  const metaMeasure = ((project?.stepData["question"] as StepData)?.measure as string | undefined) ?? "";
  const base = project ? synthesisMode(project) : { dichotomous: false, measure: "SMD" as EffectMeasure };
  const dichotomous = base.dichotomous;
  // A meta-analysis pins the effect; a review can toggle OR/RR.
  const [dichEffect, setDichEffect] = useState<"OR" | "RR">(
    metaMeasure === "OR" || metaMeasure === "RR" ? metaMeasure : "RR",
  );
  const measure: EffectMeasure = dichotomous ? dichEffect : base.measure;
  const lockDichEffect = metaMeasure === "OR" || metaMeasure === "RR";

  const saved = (project?.stepData[stepId] as StepData)?.rows as Row[] | undefined;
  const included = useMemo(() => (project ? includedStudies(project) : []), [project]);
  const real = project ? hasRealStudies(project) : false;
  const [rows, setRows] = useState<Row[]>(() => {
    if (saved?.length) return saved;
    if (real && included.length) return included.map((s) => emptyRow(s.id, s.label));
    return dichotomous ? SEED_DICH : SEED_CONT;
  });
  const [result, setResult] = useState<MetaResult | null>(null);
  const [webr, setWebr] = useState<{ loading: boolean; result?: WebRMeta; error?: string } | null>(null);

  /** Merge newly-included studies into the table without touching entered data. */
  const importIncluded = () => {
    const have = new Set(rows.map((r) => r.id));
    const added = included.filter((s) => !have.has(s.id)).map((s) => emptyRow(s.id, s.label));
    if (added.length === 0) return;
    const next = [...rows, ...added];
    setRows(next);
    setField(stepId, "rows", next);
    void persist();
  };
  const missingIncluded = real ? included.filter((s) => !rows.some((r) => r.id === s.id)).length : 0;

  const effects = useMemo(() => rowsToEffects(rows, { dichotomous, measure }), [rows, dichotomous, measure]);

  // Mantel-Haenszel is preferred for sparse binary data (Module 5 §2d/§4). We
  // compute it on the main thread (cheap) and surface it alongside the
  // inverse-variance result when events are sparse.
  const mh = useMemo<MhResult | undefined>(() => {
    if (!dichotomous) return undefined;
    const tables = rowsToTables(rows);
    if (tables.length === 0 || !hasSparseEvents(tables)) return undefined;
    return mantelHaenszel(tables, measure as "OR" | "RR");
  }, [rows, dichotomous, measure]);

  // Recompute (in the worker) whenever the usable effects or measure change.
  const effectsKey = JSON.stringify(effects) + measure;
  useEffect(() => {
    let cancelled = false;
    if (effects.length === 0) {
      setResult(null);
      return;
    }
    void runMetaAnalysis(effects, measure).then((r) => {
      if (!cancelled) {
        setResult(r);
        // Prefer the HKSJ interval (small-sample correct) for the report.
        const ci = r.hksj ?? r.random;
        setField(stepId, "pooledEstimate", r.random.estimate);
        setField(stepId, "pooledCiLow", ci.ciLow);
        setField(stepId, "pooledCiHigh", ci.ciHigh);
        setField(stepId, "ciMethod", r.hksj ? "HKSJ" : "normal");
        setField(stepId, "i2", r.random.i2);
        setField(stepId, "pooledP", ci.p);
        setField(stepId, "pQ", r.random.pQ);
        setField(stepId, "effectMeasure", measure);
        void persist();
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectsKey]);

  const update = (id: string, key: keyof Row, value: string) => {
    const next = rows.map((r) => (r.id === id ? { ...r, [key]: value } : r));
    setRows(next);
    setField(stepId, "rows", next);
    void persist();
  };
  const addRow = () => {
    const next = [...rows, emptyRow(`s${Date.now() % 100000}`, "")];
    setRows(next);
    setField(stepId, "rows", next);
  };
  const removeRow = (id: string) => {
    const next = rows.filter((r) => r.id !== id);
    setRows(next);
    setField(stepId, "rows", next);
    void persist();
  };

  const cols = dichotomous ? DICH_COLS : CONT_COLS;

  return (
    <div className="flex flex-col gap-4">
      {/* What's being pooled */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="inline-flex items-center rounded-pill bg-primary-soft px-2.5 py-1 text-xs font-semibold text-primary">
          {dichotomous ? "Dichotomous outcome" : "Continuous outcome"}
        </span>
        {dichotomous ? (
          <label className="flex items-center gap-1.5 text-xs text-ink-soft">
            Effect
            <select
              value={dichEffect}
              disabled={lockDichEffect}
              onChange={(e) => setDichEffect(e.target.value as "OR" | "RR")}
              className="rounded-input border border-hairline bg-elevated/70 px-2 py-1 text-sm text-ink outline-none focus-visible:focus-ring disabled:opacity-60"
            >
              <option value="RR">Risk ratio</option>
              <option value="OR">Odds ratio</option>
            </select>
          </label>
        ) : (
          <span className="text-xs text-ink-muted">Pooled as {measure === "MD" ? "a raw mean difference" : "a standardised mean difference (Hedges' g)"}.</span>
        )}
        <span className="ml-auto text-xs text-ink-muted">
          Set by the {metaMeasure ? "effect measure" : "data-extraction"} step.
        </span>
      </div>

      {/* Editable data table (columns follow the outcome type) */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Per-study {dichotomous ? "events and totals" : "group means, standard deviations, and sample sizes"}
          </caption>
          <thead>
            <tr className="text-ink-muted">
              <th scope="col" className="px-1 py-1 text-left font-medium">Study</th>
              {dichotomous ? (
                <>
                  <th scope="col" colSpan={2} className="px-1 py-1 font-medium">Intervention (events, total)</th>
                  <th scope="col" colSpan={2} className="px-1 py-1 font-medium">Control (events, total)</th>
                </>
              ) : (
                <>
                  <th scope="col" colSpan={3} className="px-1 py-1 font-medium">Intervention (m, sd, n)</th>
                  <th scope="col" colSpan={3} className="px-1 py-1 font-medium">Control (m, sd, n)</th>
                </>
              )}
              <th scope="col" className="px-1 py-1" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-hairline">
                <td className="px-1 py-1">
                  <input aria-label="Study label" value={r.label} onChange={(e) => update(r.id, "label", e.target.value)}
                    className="w-28 rounded-input border border-hairline bg-elevated/70 px-2 py-1 text-sm text-ink outline-none focus-visible:focus-ring" />
                </td>
                {cols.map((k) => (
                  <td key={k} className="px-0.5 py-1">
                    <input aria-label={`${r.label || "study"} ${k}`} inputMode="decimal" value={(r[k] as string | undefined) ?? ""}
                      onChange={(e) => update(r.id, k, e.target.value)}
                      className="num-tabular w-14 rounded-input border border-hairline bg-elevated/70 px-1.5 py-1 text-sm text-ink outline-none focus-visible:focus-ring" />
                  </td>
                ))}
                <td className="px-1 py-1">
                  <button onClick={() => removeRow(r.id)} aria-label={`Remove ${r.label || "study"}`}
                    className="grid h-7 w-7 place-items-center rounded-input text-ink-muted hover:text-danger focus-visible:focus-ring">
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <GlassButton variant="soft" size="sm" onClick={addRow}>
          <Plus className="h-4 w-4" aria-hidden="true" /> Add study
        </GlassButton>
        {missingIncluded > 0 && (
          <GlassButton variant="ghost" size="sm" onClick={importIncluded}>
            <Download className="h-4 w-4" aria-hidden="true" /> Import {missingIncluded} included{" "}
            {missingIncluded === 1 ? "study" : "studies"}
          </GlassButton>
        )}
        {real && (
          <span className="text-xs text-ink-muted">
            Studies pulled from your review. Enter each study's{" "}
            {dichotomous ? "events and group totals" : "means, SDs, and group sizes"} from its full text.
          </span>
        )}
      </div>

      {result ? (
        <>
          <ForestPlot result={result} />
          <FunnelPlot result={result} />
          {mh && (
            <p className="rounded-input bg-warning-soft p-3 text-sm text-ink">
              <strong>Sparse events detected.</strong> Mantel-Haenszel is preferred over inverse-variance here:
              pooled {measure} <strong>{mh.estimate.toFixed(2)}</strong> (95% CI {mh.ciLow.toFixed(2)} to{" "}
              {mh.ciHigh.toFixed(2)}, p {mh.p < 0.001 ? "< 0.001" : `= ${mh.p.toFixed(3)}`}).{" "}
              {mh.measure === "OR" ? "Robins-Breslow-Greenland" : "Greenland-Robins"} variance.
            </p>
          )}
          <MethodPanel result={result} measure={measure} mh={mh} />

          {/* Optional gold-standard cross-check against metafor (WebR). */}
          <div className="rounded-input border border-hairline bg-elevated/40 p-3 text-sm">
            <GlassButton
              variant="soft"
              size="sm"
              loading={webr?.loading}
              onClick={async () => {
                setWebr({ loading: true });
                try {
                  const r = await webrRandomEffects(effects.map((e) => e.yi), effects.map((e) => e.vi));
                  setWebr({ loading: false, result: r });
                } catch {
                  setWebr({ loading: false, error: "The WebR cross-check could not be loaded. It is fetched from the internet when you ask for it. The result above does not depend on it." });
                }
              }}
            >
              <FlaskConical className="h-4 w-4" aria-hidden="true" /> Cross-check with metafor (WebR)
            </GlassButton>
            {webr?.result && (
              <p className="mt-2 rounded-input bg-success-soft px-2.5 py-1.5 text-xs text-ink">
                metafor (DL): pooled {webr.result.estimate.toFixed(3)} (95% CI {webr.result.ciLow.toFixed(3)} to{" "}
                {webr.result.ciHigh.toFixed(3)}), I² = {webr.result.i2.toFixed(0)}%. Compare to Scholea's estimate above.
              </p>
            )}
            {webr?.error && <p className="mt-2 text-xs text-ink-muted">{webr.error}</p>}
          </div>
        </>
      ) : (
        <p className="rounded-input bg-info-soft p-3 text-sm text-ink">
          {dichotomous
            ? "Enter at least one study with events and group totals (0 ≤ events ≤ total) to pool an estimate."
            : "Enter at least one study with valid means, SDs (> 0), and group sizes (≥ 2) to pool an estimate."}
        </p>
      )}
    </div>
  );
}

function effectDescription(measure: EffectMeasure): string {
  switch (measure) {
    case "OR":
      return "log odds ratio from each 2×2 table (Haldane-Anscombe 0.5 correction for any zero cell); displayed as an odds ratio.";
    case "RR":
      return "log risk ratio from each 2×2 table; displayed as a risk ratio.";
    case "MD":
      return "raw (unstandardised) mean difference, appropriate when every study uses the same outcome scale.";
    default:
      return "standardised mean difference (Hedges' g), bias-corrected (Hedges & Olkin, 1985).";
  }
}

function MethodPanel({ result, measure, mh }: { result: MetaResult; measure: EffectMeasure; mh?: MhResult }) {
  const exp = measure === "OR" || measure === "RR";
  const shown = (v: number) => (exp ? Math.exp(v) : v).toFixed(3);
  const hksj = result.hksj;
  const pQ = result.random.pQ;
  const pQStr = pQ < 0.001 ? "< 0.001" : `= ${pQ.toFixed(3)}`;
  return (
    <details className="rounded-input bg-elevated/40 p-3 text-sm">
      <summary className="flex cursor-pointer items-center gap-2 font-semibold text-ink">
        <BookText className="h-4 w-4 text-primary" aria-hidden="true" />
        Method, assumptions & citations
      </summary>
      <div className="mt-2 flex flex-col gap-1.5 text-ink-soft">
        <p>
          <strong className="text-ink">Effect size:</strong> {effectDescription(measure)}
        </p>
        <p>
          <strong className="text-ink">Model:</strong> random-effects, DerSimonian &amp; Laird (1986) method-of-moments τ²
          (offline default). REML is the preferred estimator and matches when the WebR + metafor cross-check below is run.
          Pooled {measure} {shown(result.random.estimate)}.
        </p>
        {hksj ? (
          <p>
            <strong className="text-ink">Confidence interval:</strong> Hartung-Knapp-Sidik-Jonkman (recommended for k &lt; 10):
            95% CI {shown(hksj.ciLow)} to {shown(hksj.ciHigh)} (t{" "}
            <span className="num-tabular">{hksj.tCrit.toFixed(3)}</span>, {hksj.df} df).{" "}
            {hksj.guardApplied && "Knapp-Hartung guard applied (widened to the DL interval). "}
            Standard normal CI for reference: {shown(result.random.ciLow)} to {shown(result.random.ciHigh)}.
          </p>
        ) : (
          <p>
            <strong className="text-ink">Confidence interval:</strong> 95% CI {shown(result.random.ciLow)} to{" "}
            {shown(result.random.ciHigh)} (single study, no pooling).
          </p>
        )}
        {mh && (
          <p>
            <strong className="text-ink">Sparse-event pooling:</strong> Mantel-Haenszel {mh.measure}{" "}
            {mh.estimate.toFixed(3)} (95% CI {mh.ciLow.toFixed(3)} to {mh.ciHigh.toFixed(3)}), with{" "}
            {mh.measure === "OR" ? "Robins-Breslow-Greenland" : "Greenland-Robins"} variance, preferred over
            inverse-variance when events are rare.
          </p>
        )}
        <p>
          <strong className="text-ink">Heterogeneity:</strong> I² (Higgins &amp; Thompson, 2002) = {result.random.i2.toFixed(0)}%;
          τ² = {result.random.tau2.toFixed(3)}; Q = {result.random.Q.toFixed(2)} on {result.random.df} df (p {pQStr}).
        </p>
        <p>
          <strong className="text-ink">Assumptions:</strong> independent studies; the true effect varies across studies
          (random effects); {exp ? "log-scale effects are approximately normal" : "effects are approximately normal"}.
          Inspect the forest and funnel plots before trusting the summary.
        </p>
        <p className="text-xs text-ink-muted">
          Computed with Scholea’s validated engine, reference-tested against published formulas (incl. the Module 5
          validation case). The gold-standard WebR + metafor backend produces matching estimates when enabled.
        </p>
      </div>
    </details>
  );
}
