import { useMemo } from "react";
import { Download } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { useProject } from "@/lib/study/project-store";
import { useTheme } from "@/lib/theme/theme-store";
import { derivePrismaCounts, type PrismaCounts } from "@/lib/study/prisma";
import { platform } from "@/lib/platform";

interface Palette {
  box: string;
  boxStroke: string;
  text: string;
  sub: string;
  excl: string;
  exclStroke: string;
  line: string;
}

const light: Palette = {
  box: "#FFFEFB",
  boxStroke: "#6C5CE7",
  text: "#0E1424",
  sub: "#4A5168",
  excl: "#F2F0E8",
  exclStroke: "#B82A2A",
  line: "#4A5168",
};
const dark: Palette = {
  box: "#1A2138",
  boxStroke: "#8473ED",
  text: "#FAF9F5",
  sub: "#B9BCC9",
  excl: "#2E3447",
  exclStroke: "#FF7878",
  line: "#8A90A2",
};

/** Builds a self-contained PRISMA 2020 flow SVG (literal colours so the export
 *  renders correctly outside the app). */
export function buildPrismaSvg(c: PrismaCounts, p: Palette): string {
  const W = 540;
  const H = 440;
  const mainX = 30;
  const mainW = 250;
  const cx = mainX + mainW / 2;
  const rX = 320;
  const rW = 190;

  const mainBox = (y: number, h: number, title: string, n: number) => `
    <rect x="${mainX}" y="${y}" width="${mainW}" height="${h}" rx="14"
      fill="${p.box}" stroke="${p.boxStroke}" stroke-width="2"/>
    <text x="${cx}" y="${y + h / 2 - 6}" text-anchor="middle" font-family="Inter, sans-serif"
      font-size="13" font-weight="600" fill="${p.text}">${title}</text>
    <text x="${cx}" y="${y + h / 2 + 14}" text-anchor="middle" font-family="ui-monospace, monospace"
      font-size="13" fill="${p.sub}">n = ${n}</text>`;

  const exclBox = (y: number, title: string, n: number) => `
    <rect x="${rX}" y="${y}" width="${rW}" height="44" rx="10"
      fill="${p.excl}" stroke="${p.exclStroke}" stroke-width="1.5"/>
    <text x="${rX + rW / 2}" y="${y + 19}" text-anchor="middle" font-family="Inter, sans-serif"
      font-size="11" font-weight="600" fill="${p.text}">${title}</text>
    <text x="${rX + rW / 2}" y="${y + 34}" text-anchor="middle" font-family="ui-monospace, monospace"
      font-size="11" fill="${p.sub}">n = ${n}</text>`;

  const vline = (y1: number, y2: number) =>
    `<line x1="${cx}" y1="${y1}" x2="${cx}" y2="${y2}" stroke="${p.line}" stroke-width="1.5" marker-end="url(#arrow)"/>`;
  const branch = (y: number) =>
    `<line x1="${cx}" y1="${y}" x2="${rX}" y2="${y}" stroke="${p.line}" stroke-width="1.5" marker-end="url(#arrow)"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="PRISMA 2020 flow diagram">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="${p.line}"/>
    </marker>
  </defs>
  ${mainBox(20, 64, "Records identified", c.identified)}
  ${vline(84, 128)}
  ${branch(106)}
  ${exclBox(84, "Duplicates removed", c.duplicatesRemoved)}
  ${mainBox(128, 64, "Records screened", c.screened)}
  ${vline(192, 236)}
  ${branch(214)}
  ${exclBox(192, "Excluded at screening", c.excludedScreening)}
  ${mainBox(236, 64, "Reports assessed for eligibility", c.soughtFullText)}
  ${vline(300, 344)}
  ${branch(322)}
  ${exclBox(300, "Reports excluded (full text)", c.fullTextExcluded)}
  ${mainBox(344, 72, "Studies included in review", c.included)}
</svg>`;
}

/** Renders the live PRISMA flow and offers an SVG export via the platform adapter. */
export function PrismaFlow() {
  const project = useProject((s) => s.project);
  const mode = useTheme((s) => s.mode);

  const counts = useMemo(
    () => (project ? derivePrismaCounts(project) : null),
    [project],
  );

  if (!counts) return null;
  const svg = buildPrismaSvg(counts, mode === "dark" ? dark : light);

  const exportSvg = () => {
    void platform.saveFile("scholea-prisma-flow.svg", svg);
  };

  return (
    <div className="flex flex-col gap-3">
      <div
        className="overflow-x-auto rounded-card bg-elevated/40 p-3"
        // Counts are numbers and the palette is literal — safe to inject.
        dangerouslySetInnerHTML={{ __html: svg }}
      />

      {/* Accessible text equivalent of the diagram. */}
      <table className="sr-only">
        <caption>PRISMA flow counts</caption>
        <tbody>
          <tr><th>Records identified</th><td>{counts.identified}</td></tr>
          <tr><th>Duplicates removed</th><td>{counts.duplicatesRemoved}</td></tr>
          <tr><th>Records screened</th><td>{counts.screened}</td></tr>
          <tr><th>Excluded at screening</th><td>{counts.excludedScreening}</td></tr>
          <tr><th>Reports assessed</th><td>{counts.soughtFullText}</td></tr>
          <tr><th>Reports excluded (full text)</th><td>{counts.fullTextExcluded}</td></tr>
          <tr><th>Studies included</th><td>{counts.included}</td></tr>
        </tbody>
      </table>

      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-ink-muted">
          Counts update live from your search, dedup, screening, and full-text steps.
        </p>
        <GlassButton variant="soft" size="sm" onClick={exportSvg}>
          <Download className="h-4 w-4" aria-hidden="true" />
          Export SVG
        </GlassButton>
      </div>
    </div>
  );
}
