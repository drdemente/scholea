import { useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Download } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { useTheme } from "@/lib/theme/theme-store";
import { chartPalette } from "./palette";
import { exportSvg } from "./export";
import { displayValue, interpretI2, type MetaResult } from "@/lib/stats/meta";

// Wide enough that the effect column, the "[95% CI]" text and the weight
// column all sit INSIDE the viewBox (so nothing is cropped); the SVG then
// scales down to the window via width:100%.
const W = 780;
const PLOT_X0 = 150;
const PLOT_X1 = 430;
const NUM_X = 440; // start of the "effect [95% CI]" text column
const WT_X = W - 12; // right edge — weight column (end-anchored)

function fmt(v: number, measure: MetaResult["measure"]): string {
  return displayValue(v, measure).toFixed(2);
}
function fmtP(p: number): string {
  return p < 0.001 ? "< 0.001" : p.toFixed(3);
}

/**
 * Forest plot rendered from validated meta-analysis output. Box area ∝ study
 * weight; a numeric weight column is shown too. The diamond is the
 * random-effects pooled estimate. For OR/RR the plotting scale is the log scale
 * (so CIs are symmetric) with the null line at the no-effect value. The SVG is
 * fully responsive — it scales to the container without clipping.
 */
export function ForestPlot({ result }: { result: MetaResult }) {
  const mode = useTheme((s) => s.mode);
  const p = chartPalette(mode);
  const prefersReduced = useReducedMotion() ?? false;
  const svgRef = useRef<SVGSVGElement>(null);

  const { studies, random, measure } = result;
  // Draw the pooled diamond with the spec-preferred interval: HKSJ when we have
  // ≥2 studies (small-sample correct), else the normal random-effects CI.
  const pooledCiLow = result.hksj?.ciLow ?? random.ciLow;
  const pooledCiHigh = result.hksj?.ciHigh ?? random.ciHigh;
  const pooledP = result.hksj?.p ?? random.p;
  const ciLabel = result.hksj ? "HKSJ" : "";

  const lo = Math.min(0, ...studies.map((s) => s.ciLow), pooledCiLow);
  const hi = Math.max(0, ...studies.map((s) => s.ciHigh), pooledCiHigh);
  const pad = (hi - lo) * 0.08 || 0.5;
  const dmin = lo - pad;
  const dmax = hi + pad;

  const plotW = PLOT_X1 - PLOT_X0;
  const headerH = 26;
  const rowH = 26;
  const pooledH = 32;
  const axisH = 30;
  const height = headerH + studies.length * rowH + pooledH + axisH + 10;

  const x = (v: number) => PLOT_X0 + ((v - dmin) / (dmax - dmin)) * plotW;
  const maxW = Math.max(...studies.map((s) => s.weightPct), 1);
  const boxSide = (wpct: number) => 5 + (wpct / maxW) * 11;

  const ariaLabel = `Forest plot. Pooled ${measure} (random effects) ${fmt(random.estimate, measure)} with 95% ${ciLabel} confidence interval ${fmt(pooledCiLow, measure)} to ${fmt(pooledCiHigh, measure)}, p ${fmtP(pooledP)}. I-squared ${random.i2.toFixed(0)} percent.`;

  return (
    <div className="flex w-full flex-col gap-2">
      <motion.svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={ariaLabel}
        initial={prefersReduced ? undefined : { opacity: 0 }}
        animate={prefersReduced ? undefined : { opacity: 1 }}
        className="w-full rounded-card bg-elevated/40"
        style={{ width: "100%", height: "auto", maxWidth: "100%", fontFamily: "Inter, sans-serif" }}
      >
        {/* Header */}
        <text x={12} y={17} fontSize="11" fontWeight="600" fill={p.sub}>Study</text>
        <text x={NUM_X} y={17} fontSize="11" fontWeight="600" fill={p.sub}>{measure} [95% CI]</text>
        <text x={WT_X} y={17} textAnchor="end" fontSize="11" fontWeight="600" fill={p.sub}>Weight</text>

        {/* Null line */}
        <line x1={x(0)} y1={headerH - 4} x2={x(0)} y2={headerH + studies.length * rowH + 6}
          stroke={p.nullLine} strokeWidth="1" strokeDasharray="3 3" />

        {/* Study rows */}
        {studies.map((s, i) => {
          const cy = headerH + i * rowH + rowH / 2;
          const side = boxSide(s.weightPct);
          return (
            <motion.g
              key={s.id}
              initial={prefersReduced ? undefined : { opacity: 0, x: -6 }}
              animate={prefersReduced ? undefined : { opacity: 1, x: 0 }}
              transition={prefersReduced ? undefined : { delay: 0.03 * i, duration: 0.25 }}
            >
              <title>{`${s.label}: ${fmt(s.yi, measure)} [${fmt(s.ciLow, measure)}, ${fmt(s.ciHigh, measure)}], weight ${s.weightPct.toFixed(1)}%`}</title>
              <text x={12} y={cy + 3} fontSize="11" fill={p.text}>
                {s.label.length > 24 ? s.label.slice(0, 23) + "…" : s.label}
              </text>
              <line x1={x(s.ciLow)} y1={cy} x2={x(s.ciHigh)} y2={cy} stroke={p.line} strokeWidth="1.25" />
              <rect x={x(s.yi) - side / 2} y={cy - side / 2} width={side} height={side}
                fill={p.box} stroke={p.boxStroke} strokeWidth="0.75" />
              <text x={NUM_X} y={cy + 3} fontSize="10.5" fill={p.sub}
                style={{ fontFamily: "ui-monospace, monospace" }}>
                {fmt(s.yi, measure)} [{fmt(s.ciLow, measure)}, {fmt(s.ciHigh, measure)}]
              </text>
              <text x={WT_X} y={cy + 3} textAnchor="end" fontSize="10.5" fill={p.sub}
                style={{ fontFamily: "ui-monospace, monospace" }}>
                {s.weightPct.toFixed(1)}%
              </text>
            </motion.g>
          );
        })}

        {/* Pooled diamond (random effects) */}
        {(() => {
          const cy = headerH + studies.length * rowH + pooledH / 2;
          const cxEst = x(random.estimate);
          const dh = 8;
          return (
            <motion.g
              initial={prefersReduced ? undefined : { opacity: 0, scale: 0.9 }}
              animate={prefersReduced ? undefined : { opacity: 1, scale: 1 }}
              transition={prefersReduced ? undefined : { delay: 0.03 * studies.length + 0.05 }}
              style={{ transformOrigin: `${cxEst}px ${cy}px` }}
            >
              <text x={12} y={cy + 3} fontSize="11" fontWeight="600" fill={p.text}>Random effects</text>
              <polygon
                points={`${x(pooledCiLow)},${cy} ${cxEst},${cy - dh} ${x(pooledCiHigh)},${cy} ${cxEst},${cy + dh}`}
                fill={p.diamond}
              />
              <text x={NUM_X} y={cy + 3} fontSize="10.5" fontWeight="600" fill={p.text}
                style={{ fontFamily: "ui-monospace, monospace" }}>
                {fmt(random.estimate, measure)} [{fmt(pooledCiLow, measure)}, {fmt(pooledCiHigh, measure)}]
              </text>
              <text x={WT_X} y={cy + 3} textAnchor="end" fontSize="10.5" fontWeight="600" fill={p.text}
                style={{ fontFamily: "ui-monospace, monospace" }}>
                100%
              </text>
            </motion.g>
          );
        })()}

        {/* Axis */}
        {(() => {
          const ay = height - axisH + 8;
          const ticks = [lo, (lo + hi) / 2, hi];
          return (
            <g>
              <line x1={PLOT_X0} y1={ay} x2={PLOT_X1} y2={ay} stroke={p.axis} strokeWidth="1" />
              {ticks.map((t, i) => (
                <g key={i}>
                  <line x1={x(t)} y1={ay} x2={x(t)} y2={ay + 4} stroke={p.axis} strokeWidth="1" />
                  <text x={x(t)} y={ay + 15} fontSize="10" textAnchor="middle" fill={p.sub}
                    style={{ fontFamily: "ui-monospace, monospace" }}>
                    {fmt(t, measure)}
                  </text>
                </g>
              ))}
            </g>
          );
        })()}
      </motion.svg>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="num-tabular text-xs text-ink-muted">
          Pooled {measure} {fmt(random.estimate, measure)} (95% CI{ciLabel ? ` ${ciLabel}` : ""} {fmt(pooledCiLow, measure)} to {fmt(pooledCiHigh, measure)}),
          p {fmtP(pooledP)} · I² = {random.i2.toFixed(0)}% ({interpretI2(random.i2)}) ·
          τ² = {random.tau2.toFixed(3)} · Q = {random.Q.toFixed(2)} (df {random.df}, p {fmtP(random.pQ)})
        </p>
        <GlassButton variant="soft" size="sm" onClick={() => exportSvg(svgRef.current, "scholea-forest-plot.svg")}>
          <Download className="h-4 w-4" aria-hidden="true" /> SVG
        </GlassButton>
      </div>
    </div>
  );
}
