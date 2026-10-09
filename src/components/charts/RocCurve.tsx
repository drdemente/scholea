import { useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Download } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { useTheme } from "@/lib/theme/theme-store";
import { chartPalette } from "./palette";
import { exportSvg } from "./export";
import type { RocPoint } from "@/lib/stats/diagnostics";

const S = 360;
const M = 44;

/** ROC curve from operating points, with the chance diagonal and AUC label. */
export function RocCurve({ points, auc }: { points: RocPoint[]; auc: number }) {
  const mode = useTheme((s) => s.mode);
  const p = chartPalette(mode);
  const prefersReduced = useReducedMotion() ?? false;
  const svgRef = useRef<SVGSVGElement | null>(null);

  const pts = [...points];
  if (!pts.some((q) => q.fpr === 0 && q.tpr === 0)) pts.push({ fpr: 0, tpr: 0 });
  if (!pts.some((q) => q.fpr === 1 && q.tpr === 1)) pts.push({ fpr: 1, tpr: 1 });
  pts.sort((a, b) => a.fpr - b.fpr || a.tpr - b.tpr);

  const x = (v: number) => M + v * (S - 2 * M);
  const y = (v: number) => S - M - v * (S - 2 * M);
  const curve = pts.map((q) => `${x(q.fpr)},${y(q.tpr)}`).join(" ");
  const area = `${x(0)},${y(0)} ${curve} ${x(1)},${y(0)}`;

  return (
    <div className="flex flex-col gap-2">
      <motion.svg
        ref={svgRef}
        viewBox={`0 0 ${S} ${S}`}
        width="100%"
        role="img"
        aria-label={`ROC curve, area under the curve ${auc.toFixed(3)}.`}
        initial={prefersReduced ? undefined : { opacity: 0 }}
        animate={prefersReduced ? undefined : { opacity: 1 }}
        className="mx-auto max-w-sm rounded-card bg-elevated/40"
        style={{ fontFamily: "Inter, sans-serif" }}
      >
        {/* Axes */}
        <line x1={x(0)} y1={y(0)} x2={x(0)} y2={y(1)} stroke={p.axis} strokeWidth="1" />
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(0)} stroke={p.axis} strokeWidth="1" />
        {/* Chance diagonal */}
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke={p.nullLine} strokeWidth="1" strokeDasharray="4 3" />
        {/* Area + curve */}
        <polygon points={area} fill={p.accent} fillOpacity="0.12" />
        <motion.polyline
          points={curve}
          fill="none"
          stroke={p.box}
          strokeWidth="2"
          initial={prefersReduced ? undefined : { pathLength: 0 }}
          animate={prefersReduced ? undefined : { pathLength: 1 }}
          transition={prefersReduced ? undefined : { duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        />
        {points.map((q, i) => (
          <circle key={i} cx={x(q.fpr)} cy={y(q.tpr)} r={3.5} fill={p.boxStroke} />
        ))}
        {/* Labels */}
        <text x={S / 2} y={S - 8} fontSize="11" textAnchor="middle" fill={p.sub}>1 − specificity (FPR)</text>
        <text x={14} y={S / 2} fontSize="11" textAnchor="middle" fill={p.sub} transform={`rotate(-90 14 ${S / 2})`}>Sensitivity (TPR)</text>
        <text x={x(0.55)} y={y(0.2)} fontSize="13" fontWeight="700" fill={p.text}
          style={{ fontFamily: "ui-monospace, monospace" }}>AUC = {auc.toFixed(3)}</text>
      </motion.svg>
      <div className="flex justify-end">
        <GlassButton variant="soft" size="sm" onClick={() => exportSvg(svgRef.current, "scholea-roc-curve.svg")}>
          <Download className="h-4 w-4" aria-hidden="true" /> SVG
        </GlassButton>
      </div>
    </div>
  );
}
