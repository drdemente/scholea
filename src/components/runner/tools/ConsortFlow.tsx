import { useRef } from "react";
import { Download } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { useProject } from "@/lib/study/project-store";
import { useTheme } from "@/lib/theme/theme-store";
import { chartPalette } from "@/components/charts/palette";
import { exportSvg } from "@/components/charts/export";
import { buildConsortSvg } from "@/lib/paper/flow-svg";
import type { StepData } from "@/lib/study/types";

/**
 * CONSORT 2010 participant-flow diagram, generated from the counts captured on
 * the RCT flow step. Two-arm parallel layout: enrolment → allocation →
 * follow-up → analysis. Themed and exportable.
 */
export function ConsortFlow({ stepId }: { stepId: string }) {
  const project = useProject((s) => s.project);
  const mode = useTheme((s) => s.mode);
  const p = chartPalette(mode);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const d = (project?.stepData[stepId] as StepData) ?? {};
  const svg = buildConsortSvg(d, p);

  return (
    <div className="flex flex-col gap-2">
      <div ref={(el) => { svgRef.current = el?.querySelector("svg") ?? null; }}
        className="overflow-x-auto rounded-card bg-elevated/40 p-3" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="flex justify-end">
        <GlassButton variant="soft" size="sm" onClick={() => exportSvg(svgRef.current, "scholea-consort-flow.svg")}>
          <Download className="h-4 w-4" aria-hidden="true" /> Export SVG
        </GlassButton>
      </div>
    </div>
  );
}
