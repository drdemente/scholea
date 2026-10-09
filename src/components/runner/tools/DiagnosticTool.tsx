import { useState } from "react";
import { GlassPanel } from "@/components/glass";
import { RocCurve } from "@/components/charts/RocCurve";
import { useProject } from "@/lib/study/project-store";
import { from2x2, rocAuc, type RocPoint } from "@/lib/stats/diagnostics";
import type { StepData } from "@/lib/study/types";

interface RocRow { id: string; sens: string; spec: string }

const SEED_ROWS: RocRow[] = [
  { id: "r1", sens: "0.55", spec: "0.95" },
  { id: "r2", sens: "0.78", spec: "0.82" },
  { id: "r3", sens: "0.90", spec: "0.65" },
  { id: "r4", sens: "0.96", spec: "0.40" },
];

const num = (s: unknown) => (typeof s === "number" ? s : Number(s));

/**
 * Diagnostic-accuracy workspace. A 2×2 against the reference standard gives
 * sensitivity/specificity/PPV/NPV/likelihood ratios; an operating-point table
 * gives the ROC curve + AUC. All via the validated diagnostics engine.
 */
export function DiagnosticTool({ stepId }: { stepId: string }) {
  const project = useProject((s) => s.project);
  const setField = useProject((s) => s.setField);
  const persist = useProject((s) => s.persist);
  const data = (project?.stepData[stepId] as StepData) ?? {};

  const cell = (k: string) => (data[k] === undefined ? "" : String(data[k]));
  const setCell = (k: string, v: string) => {
    setField(stepId, k, v === "" ? "" : Number(v));
    void persist();
  };

  const tp = num(data.tp), fp = num(data.fp), fn = num(data.fn), tn = num(data.tn);
  const hasTable = [tp, fp, fn, tn].every((v) => Number.isFinite(v));
  const m = hasTable ? from2x2(tp, fp, fn, tn) : null;

  const [rows, setRows] = useState<RocRow[]>((data.rocRows as RocRow[]) ?? SEED_ROWS);
  const points: RocPoint[] = rows
    .map((r) => ({ fpr: 1 - num(r.spec), tpr: num(r.sens) }))
    .filter((q) => Number.isFinite(q.fpr) && Number.isFinite(q.tpr) && q.tpr >= 0 && q.tpr <= 1 && q.fpr >= 0 && q.fpr <= 1);
  const auc = points.length ? rocAuc(points) : NaN;

  const updateRow = (id: string, key: "sens" | "spec", v: string) => {
    const next = rows.map((r) => (r.id === id ? { ...r, [key]: v } : r));
    setRows(next);
    setField(stepId, "rocRows", next);
    if (Number.isFinite(auc)) setField(stepId, "auc", auc);
    void persist();
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 2x2 */}
      <div>
        <p className="mb-2 text-sm font-medium text-ink">2×2 vs reference standard (at one threshold)</p>
        <div className="grid max-w-md grid-cols-2 gap-2">
          {([["tp", "True positives"], ["fp", "False positives"], ["fn", "False negatives"], ["tn", "True negatives"]] as const).map(([k, label]) => (
            <label key={k} className="flex flex-col gap-1 text-xs text-ink-soft">
              {label}
              <input inputMode="numeric" value={cell(k)} onChange={(e) => setCell(k, e.target.value)}
                className="num-tabular rounded-input border border-hairline bg-elevated/70 px-2 py-1.5 text-base text-ink outline-none focus-visible:focus-ring" />
            </label>
          ))}
        </div>
      </div>

      {m && (
        <GlassPanel noAnimate className="grid grid-cols-2 gap-x-6 gap-y-1.5 p-4 sm:grid-cols-4">
          <Metric label="Sensitivity" v={m.sensitivity} pct />
          <Metric label="Specificity" v={m.specificity} pct />
          <Metric label="PPV" v={m.ppv} pct />
          <Metric label="NPV" v={m.npv} pct />
          <Metric label="LR+" v={m.lrPositive} />
          <Metric label="LR−" v={m.lrNegative} />
          <Metric label="Accuracy" v={m.accuracy} pct />
        </GlassPanel>
      )}

      {/* ROC operating points */}
      <div>
        <p className="mb-2 text-sm font-medium text-ink">Operating points (sensitivity / specificity per threshold)</p>
        <div className="flex flex-col gap-1.5">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-2">
              <input aria-label="sensitivity" inputMode="decimal" value={r.sens} onChange={(e) => updateRow(r.id, "sens", e.target.value)}
                className="num-tabular w-24 rounded-input border border-hairline bg-elevated/70 px-2 py-1 text-sm text-ink outline-none focus-visible:focus-ring" />
              <span className="text-xs text-ink-muted">sens</span>
              <input aria-label="specificity" inputMode="decimal" value={r.spec} onChange={(e) => updateRow(r.id, "spec", e.target.value)}
                className="num-tabular w-24 rounded-input border border-hairline bg-elevated/70 px-2 py-1 text-sm text-ink outline-none focus-visible:focus-ring" />
              <span className="text-xs text-ink-muted">spec</span>
            </div>
          ))}
        </div>
      </div>

      {points.length > 0 && <RocCurve points={points} auc={auc} />}
    </div>
  );
}

function Metric({ label, v, pct }: { label: string; v: number; pct?: boolean }) {
  const display = Number.isNaN(v) ? "—" : pct ? `${(v * 100).toFixed(1)}%` : v.toFixed(2);
  return (
    <div>
      <p className="num-tabular text-lg font-bold text-ink">{display}</p>
      <p className="text-xs text-ink-muted">{label}</p>
    </div>
  );
}
