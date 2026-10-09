/**
 * Pure participant-flow SVG builders (STROBE, CONSORT) — self-contained SVG
 * strings with the passed literal palette, so they render identically in the
 * app, in an exported .svg, and embedded in the compiled manuscript. PRISMA has
 * its own builder in the PrismaFlow tool (buildPrismaSvg).
 */
import type { StepData } from "@/lib/study/types";

/** The subset of the chart palette these diagrams need (literal colours). */
export interface FlowPalette {
  box: string;
  boxStroke: string;
  text: string;
  sub: string;
  axis: string;
  grid: string;
}

const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) && x > 0 ? x : 0;
};

function boxFn(p: FlowPalette) {
  return (x: number, y: number, w: number, h: number, lines: string[], muted = false) => `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10"
      fill="${muted ? p.grid : p.box}" fill-opacity="${muted ? "0.5" : "0.12"}"
      stroke="${muted ? p.axis : p.boxStroke}" stroke-width="1.5"/>
    ${lines.map((ln, i) => `<text x="${x + w / 2}" y="${y + 18 + i * 15}" text-anchor="middle" font-family="Inter, sans-serif" font-size="11" fill="${p.text}">${ln}</text>`).join("")}`;
}

/** STROBE single-cohort participant flow from the step's counts. */
export function buildStrobeSvg(d: StepData, p: FlowPalette): string {
  const assessed = n(d.sfAssessed);
  const excluded = n(d.sfExcluded);
  const included = n(d.sfIncluded);
  const lost = n(d.sfLost);
  const analysed = n(d.sfAnalysed);
  const W = 520;
  const cx = W / 2;
  const box = boxFn(p);
  const vline = (x: number, y1: number, y2: number) => `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${p.axis}" stroke-width="1.25" marker-end="url(#sa)"/>`;
  const hline = (x1: number, x2: number, y: number) => `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${p.axis}" stroke-width="1.25" marker-end="url(#sa)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 360" width="100%" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;max-width:100%" role="img" aria-label="STROBE participant flow diagram">
    <defs><marker id="sa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${p.axis}"/></marker></defs>
    ${box(cx - 110, 16, 220, 40, ["Assessed for eligibility", `n = ${assessed}`])}
    ${hline(cx + 110, 380, 36)}
    ${box(360, 16, 150, 40, ["Excluded", `n = ${excluded}`], true)}
    ${vline(cx, 56, 86)}
    ${box(cx - 110, 86, 220, 40, ["Included in study", `n = ${included}`])}
    ${hline(cx + 110, 380, 106)}
    ${box(360, 106, 150, 40, ["Lost / missing", `n = ${lost}`], true)}
    ${vline(cx, 126, 156)}
    ${box(cx - 110, 156, 220, 40, ["Included in analysis", `n = ${analysed}`])}
  </svg>`;
}

/** CONSORT 2010 two-arm participant flow from the RCT flow-step counts. */
export function buildConsortSvg(d: StepData, p: FlowPalette): string {
  const assessed = n(d.nAssessed);
  const excluded = n(d.nExcluded);
  const randomised = n(d.nRandomised);
  const arms = [
    { label: "Intervention", allocated: n(d.intAllocated), lost: n(d.intLost), analysed: n(d.intAnalysed) },
    { label: "Control", allocated: n(d.ctrlAllocated), lost: n(d.ctrlLost), analysed: n(d.ctrlAnalysed) },
  ];
  const W = 560;
  const cx = W / 2;
  const armX = [70, 320];
  const armW = 170;
  const box = boxFn(p);
  const vline = (x: number, y1: number, y2: number) => `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${p.axis}" stroke-width="1.25" marker-end="url(#ca)"/>`;
  const hline = (x1: number, x2: number, y: number) => `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${p.axis}" stroke-width="1.25" marker-end="url(#ca)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 430" width="100%" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;max-width:100%" role="img" aria-label="CONSORT participant flow diagram">
    <defs><marker id="ca" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${p.axis}"/></marker></defs>
    <text x="12" y="14" font-family="Inter, sans-serif" font-size="10" font-weight="700" fill="${p.sub}">ENROLMENT</text>
    ${box(cx - 110, 22, 220, 40, ["Assessed for eligibility", `n = ${assessed}`])}
    ${hline(cx + 110, 400, 42)}
    ${box(400, 22, 150, 40, ["Excluded", `n = ${excluded}`], true)}
    ${vline(cx, 62, 92)}
    ${box(cx - 110, 92, 220, 36, [`Randomised  n = ${randomised}`])}
    <text x="12" y="150" font-family="Inter, sans-serif" font-size="10" font-weight="700" fill="${p.sub}">ALLOCATION</text>
    ${vline(armX[0] + armW / 2, 128, 158)}
    ${vline(armX[1] + armW / 2, 128, 158)}
    <line x1="${armX[0] + armW / 2}" y1="128" x2="${armX[1] + armW / 2}" y2="128" stroke="${p.axis}" stroke-width="1.25"/>
    ${arms.map((a, i) => box(armX[i], 158, armW, 40, [`${a.label}: allocated`, `n = ${a.allocated}`])).join("")}
    <text x="12" y="246" font-family="Inter, sans-serif" font-size="10" font-weight="700" fill="${p.sub}">FOLLOW-UP</text>
    ${arms.map((_, i) => vline(armX[i] + armW / 2, 198, 228)).join("")}
    ${arms.map((a, i) => box(armX[i], 228, armW, 40, ["Lost to follow-up", `n = ${a.lost}`], true)).join("")}
    <text x="12" y="316" font-family="Inter, sans-serif" font-size="10" font-weight="700" fill="${p.sub}">ANALYSIS</text>
    ${arms.map((_, i) => vline(armX[i] + armW / 2, 268, 298)).join("")}
    ${arms.map((a, i) => box(armX[i], 298, armW, 40, ["Analysed (ITT)", `n = ${a.analysed}`])).join("")}
  </svg>`;
}
