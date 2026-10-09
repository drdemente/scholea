import { useRef } from "react";
import { Download } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { useProject } from "@/lib/study/project-store";
import { useTheme } from "@/lib/theme/theme-store";
import { chartPalette } from "@/components/charts/palette";
import { exportSvg } from "@/components/charts/export";
import { buildStrobeSvg } from "@/lib/paper/flow-svg";
import type { StepData } from "@/lib/study/types";

const FIELDS = [
  { key: "sfAssessed", label: "Assessed for eligibility" },
  { key: "sfExcluded", label: "Excluded (not eligible / declined)" },
  { key: "sfIncluded", label: "Included in study" },
  { key: "sfLost", label: "Lost to follow-up / missing data" },
  { key: "sfAnalysed", label: "Included in analysis" },
] as const;

/**
 * STROBE participant-flow diagram (observational studies). A single-cohort
 * flow — eligibility → inclusion → follow-up → analysis — with an exclusions
 * side-box. Self-contained: counts persist to the step data; the diagram is
 * themed and exportable.
 */
export function StrobeFlow({ stepId }: { stepId: string }) {
  const project = useProject((s) => s.project);
  const setField = useProject((s) => s.setField);
  const persist = useProject((s) => s.persist);
  const mode = useTheme((s) => s.mode);
  const p = chartPalette(mode);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const d = (project?.stepData[stepId] as StepData) ?? {};
  const svg = buildStrobeSvg(d, p);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <label key={f.key} className="flex items-center justify-between gap-2 text-sm text-ink">
            <span className="text-ink-soft">{f.label}</span>
            <input
              type="number"
              min={0}
              inputMode="numeric"
              aria-label={f.label}
              value={(d[f.key] as number | string | undefined) ?? ""}
              onChange={(e) => setField(stepId, f.key, e.target.value === "" ? undefined : Number(e.target.value))}
              onBlur={() => void persist()}
              className="num-tabular w-24 rounded-input border border-hairline bg-elevated/70 px-2 py-1 text-sm text-ink outline-none focus-visible:focus-ring"
            />
          </label>
        ))}
      </div>

      <div
        ref={(el) => {
          svgRef.current = el?.querySelector("svg") ?? null;
        }}
        className="overflow-x-auto rounded-card bg-elevated/40 p-3"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div className="flex justify-end">
        <GlassButton variant="soft" size="sm" onClick={() => exportSvg(svgRef.current, "scholea-strobe-flow.svg")}>
          <Download className="h-4 w-4" aria-hidden="true" /> Export SVG
        </GlassButton>
      </div>
    </div>
  );
}
