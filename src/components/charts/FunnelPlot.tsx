import { useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Download } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { useTheme } from "@/lib/theme/theme-store";
import { chartPalette } from "./palette";
import { exportSvg } from "./export";
import { displayValue, type MetaResult } from "@/lib/stats/meta";

const W = 520;
const H = 360;
const Z95 = 1.959964;

/**
 * Funnel plot: effect (x) against standard error (y, inverted so precise
 * studies sit at the top). The pseudo-95% funnel and the pooled line make
 * asymmetry — a hint of small-study/publication bias — visible.
 */
export function FunnelPlot({ result }: { result: MetaResult }) {
  const mode = useTheme((s) => s.mode);
  const p = chartPalette(mode);
  const prefersReduced = useReducedMotion() ?? false;
  const svgRef = useRef<SVGSVGElement>(null);

  const { studies, random, measure } = result;
  const center = random.estimate;
  const seMax = Math.max(...studies.map((s) => s.sei)) * 1.1 || 1;

  const half = Math.max(Z95 * seMax, ...studies.map((s) => Math.abs(s.yi - center))) * 1.15;
  const dmin = center - half;
  const dmax = center + half;

  const m = { top: 24, right: 20, bottom: 40, left: 52 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;
  const x = (v: number) => m.left + ((v - dmin) / (dmax - dmin)) * plotW;
  const y = (se: number) => m.top + (se / seMax) * plotH; // SE=0 at top

  const apexX = x(center);
  const fmt = (v: number) => displayValue(v, measure).toFixed(2);

  return (
    <div className="flex flex-col gap-2">
      <motion.svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Funnel plot of ${studies.length} studies. Asymmetry around the pooled estimate may indicate small-study effects or publication bias.`}
        initial={prefersReduced ? undefined : { opacity: 0 }}
        animate={prefersReduced ? undefined : { opacity: 1 }}
        className="w-full rounded-card bg-elevated/40"
        style={{ width: "100%", height: "auto", maxWidth: "100%", fontFamily: "Inter, sans-serif" }}
      >
        {/* Pseudo 95% CI funnel */}
        <polygon
          points={`${apexX},${y(0)} ${x(center - Z95 * seMax)},${y(seMax)} ${x(center + Z95 * seMax)},${y(seMax)}`}
          fill={p.accent}
          fillOpacity="0.08"
          stroke={p.axis}
          strokeOpacity="0.5"
          strokeDasharray="3 3"
        />
        {/* Pooled vertical line */}
        <line x1={apexX} y1={m.top} x2={apexX} y2={m.top + plotH} stroke={p.nullLine} strokeWidth="1" />

        {/* Axes */}
        <line x1={m.left} y1={m.top} x2={m.left} y2={m.top + plotH} stroke={p.axis} strokeWidth="1" />
        <line x1={m.left} y1={m.top + plotH} x2={m.left + plotW} y2={m.top + plotH} stroke={p.axis} strokeWidth="1" />

        {/* Y ticks (standard error) */}
        {[0, seMax / 2, seMax].map((se, i) => (
          <g key={i}>
            <line x1={m.left - 4} y1={y(se)} x2={m.left} y2={y(se)} stroke={p.axis} strokeWidth="1" />
            <text x={m.left - 7} y={y(se) + 3} fontSize="10" textAnchor="end" fill={p.sub}
              style={{ fontFamily: "ui-monospace, monospace" }}>{se.toFixed(2)}</text>
          </g>
        ))}
        <text x={14} y={m.top + plotH / 2} fontSize="10.5" textAnchor="middle" fill={p.sub}
          transform={`rotate(-90 14 ${m.top + plotH / 2})`}>Standard error</text>

        {/* X ticks (effect) */}
        {[dmin + half * 0.15, center, dmax - half * 0.15].map((v, i) => (
          <g key={i}>
            <line x1={x(v)} y1={m.top + plotH} x2={x(v)} y2={m.top + plotH + 4} stroke={p.axis} strokeWidth="1" />
            <text x={x(v)} y={m.top + plotH + 16} fontSize="10" textAnchor="middle" fill={p.sub}
              style={{ fontFamily: "ui-monospace, monospace" }}>{fmt(v)}</text>
          </g>
        ))}
        <text x={m.left + plotW / 2} y={H - 6} fontSize="10.5" textAnchor="middle" fill={p.sub}>
          {measure} (effect size)
        </text>

        {/* Study points */}
        {studies.map((s, i) => (
          <motion.circle
            key={s.id}
            cx={x(s.yi)}
            cy={y(s.sei)}
            r={4.5}
            fill={p.box}
            stroke={p.boxStroke}
            strokeWidth="1"
            initial={prefersReduced ? undefined : { opacity: 0, scale: 0 }}
            animate={prefersReduced ? undefined : { opacity: 1, scale: 1 }}
            transition={prefersReduced ? undefined : { delay: 0.03 * i, type: "spring", stiffness: 300, damping: 20 }}
          >
            <title>{`${s.label}: ${fmt(s.yi)} (SE ${s.sei.toFixed(3)})`}</title>
          </motion.circle>
        ))}
      </motion.svg>

      <div className="flex items-center justify-between gap-2">
        <p className="num-tabular text-xs text-ink-muted">
          {result.egger
            ? `Egger's intercept ${result.egger.intercept.toFixed(2)} (t = ${result.egger.t.toFixed(2)})${result.egger.asymmetrySuspected ? " — asymmetry suspected" : ""}`
            : "Egger's test needs ≥ 3 studies"}
        </p>
        <GlassButton variant="soft" size="sm" onClick={() => exportSvg(svgRef.current, "scholea-funnel-plot.svg")}>
          <Download className="h-4 w-4" aria-hidden="true" /> SVG
        </GlassButton>
      </div>
    </div>
  );
}
