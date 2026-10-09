import { GlassPanel } from "@/components/glass";
import { useProject } from "@/lib/study/project-store";
import { interpretAlpha, standardizedAlpha } from "@/lib/stats/diagnostics";
import type { StepData } from "@/lib/study/types";

const num = (v: unknown) => (typeof v === "number" ? v : Number(v));

/**
 * Internal-consistency reliability via standardized Cronbach's α, from the item
 * count and the mean inter-item correlation (validated formula). For raw
 * item-level α, the Pyodide stats path will compute from response data.
 */
export function ReliabilityTool({ stepId }: { stepId: string }) {
  const project = useProject((s) => s.project);
  const setField = useProject((s) => s.setField);
  const persist = useProject((s) => s.persist);
  const data = (project?.stepData[stepId] as StepData) ?? {};

  const k = num(data.nItems);
  const r = num(data.meanR);
  const alpha = Number.isFinite(k) && Number.isFinite(r) ? standardizedAlpha(k, r) : NaN;

  const set = (key: string, v: string) => {
    setField(stepId, key, v === "" ? "" : Number(v));
    if (Number.isFinite(alpha)) setField(stepId, "alpha", alpha);
    void persist();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid max-w-md grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-xs text-ink-soft">
          Number of items (k)
          <input inputMode="numeric" value={data.nItems === undefined ? "" : String(data.nItems)} onChange={(e) => set("nItems", e.target.value)}
            className="num-tabular rounded-input border border-hairline bg-elevated/70 px-2 py-1.5 text-base text-ink outline-none focus-visible:focus-ring" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-soft">
          Mean inter-item correlation (r̄)
          <input inputMode="decimal" value={data.meanR === undefined ? "" : String(data.meanR)} onChange={(e) => set("meanR", e.target.value)}
            className="num-tabular rounded-input border border-hairline bg-elevated/70 px-2 py-1.5 text-base text-ink outline-none focus-visible:focus-ring" />
        </label>
      </div>

      {Number.isFinite(alpha) ? (
        <GlassPanel noAnimate className="flex items-baseline gap-3 p-4">
          <span className="num-tabular text-3xl font-bold text-ink">α = {alpha.toFixed(3)}</span>
          <span className="rounded-pill bg-primary-soft px-2.5 py-1 text-xs font-semibold text-primary">{interpretAlpha(alpha)}</span>
        </GlassPanel>
      ) : (
        <p className="rounded-input bg-info-soft p-3 text-sm text-ink">
          Enter the number of items and the mean inter-item correlation to estimate standardized Cronbach’s α.
        </p>
      )}
      <p className="text-xs text-ink-muted">
        Standardized α = k·r̄ / (1 + (k−1)·r̄) (Cronbach, 1951). Aim for ≥ 0.70 for group-level use.
      </p>
    </div>
  );
}
