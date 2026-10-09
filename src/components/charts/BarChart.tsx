import { useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Download } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { useTheme } from "@/lib/theme/theme-store";
import { chartPalette } from "./palette";
import { exportSvg } from "./export";

export interface Bar {
  label: string;
  value: number;
}

const W = 580;

/**
 * Simple, themed, accessible vertical bar chart with SVG export. Used for the
 * feasibility scoping view (publications per year). Mode-aware literal colours
 * so a downloaded SVG renders correctly outside the app.
 */
export function BarChart({
  bars,
  title,
  yLabel = "Publications",
}: {
  bars: Bar[];
  title: string;
  yLabel?: string;
}) {
  const mode = useTheme((s) => s.mode);
  const p = chartPalette(mode);
  const prefersReduced = useReducedMotion() ?? false;
  const svgRef = useRef<SVGSVGElement>(null);

  // Crowded axes (many years): draw every nth label, angled, with extra room.
  const labelStep = Math.max(1, Math.ceil(bars.length / 12));
  const rotateLabels = bars.length > 14;

  const padL = 48;
  const padR = 16;
  const padTop = 16;
  const axisH = rotateLabels ? 52 : 34;
  const plotH = 180;
  const height = padTop + plotH + axisH;
  const plotW = W - padL - padR;

  const max = Math.max(1, ...bars.map((b) => b.value));
  // "Nice" upper tick so the axis isn't an awkward number.
  const niceMax = niceCeil(max);
  const barGap = 6;
  const barW = bars.length > 0 ? Math.max(2, plotW / bars.length - barGap) : 0;
  const y = (v: number) => padTop + plotH - (v / niceMax) * plotH;

  const ticks = [0, niceMax / 2, niceMax];

  if (bars.length === 0) {
    return <p className="rounded-input bg-info-soft p-3 text-sm text-ink">No data to plot yet.</p>;
  }

  return (
    <figure className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <figcaption className="text-sm font-semibold text-ink">{title}</figcaption>
        <GlassButton variant="ghost" size="sm" onClick={() => exportSvg(svgRef.current, "scholea-feasibility.svg")}>
          <Download className="h-4 w-4" aria-hidden="true" /> SVG
        </GlassButton>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full"
        role="img"
        aria-label={`${title}. ${yLabel} by year.`}
        style={{ width: "100%", height: "auto", maxWidth: "100%" }}
      >
        {/* Y gridlines + ticks */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} y1={y(t)} x2={W - padR} y2={y(t)} stroke={p.grid} strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill={p.sub}>
              {Math.round(t)}
            </text>
          </g>
        ))}
        {/* Bars */}
        {bars.map((b, i) => {
          const bx = padL + i * (barW + barGap) + barGap / 2;
          const by = y(b.value);
          const bh = padTop + plotH - by;
          return (
            <g key={b.label}>
              <motion.rect
                x={bx}
                width={barW}
                rx={2}
                fill={p.box}
                initial={prefersReduced ? false : { y: padTop + plotH, height: 0 }}
                animate={{ y: by, height: bh }}
                transition={{ duration: prefersReduced ? 0 : 0.4, delay: prefersReduced ? 0 : i * 0.02 }}
              />
              {/* X label — thinned + angled when crowded so years stay legible */}
              {i % labelStep === 0 &&
                (rotateLabels ? (
                  <text
                    x={bx + barW / 2}
                    y={padTop + plotH + 12}
                    textAnchor="end"
                    fontSize={10}
                    fill={p.sub}
                    transform={`rotate(-45 ${bx + barW / 2} ${padTop + plotH + 12})`}
                  >
                    {b.label}
                  </text>
                ) : (
                  <text x={bx + barW / 2} y={padTop + plotH + 16} textAnchor="middle" fontSize={10} fill={p.sub}>
                    {b.label}
                  </text>
                ))}
            </g>
          );
        })}
        <text x={padL} y={height - 4} fontSize={11} fill={p.sub}>
          {yLabel}
        </text>
      </svg>
    </figure>
  );
}

function niceCeil(n: number): number {
  if (n <= 5) return 5;
  const mag = Math.pow(10, Math.floor(Math.log10(n)));
  const step = mag / 2;
  return Math.ceil(n / step) * step;
}
