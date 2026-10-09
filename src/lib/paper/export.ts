/**
 * Manuscript exporters — Markdown, LaTeX, and Word-openable HTML, plus the
 * integrity note. Pure string builders (offline, testable). The HTML export is
 * styled to read like a published journal article (title page, byline, abstract
 * block, justified serif body, figure/table styling, hanging-indent references).
 */
import type { Manuscript, ManuscriptSection } from "./compile";
import { INTEGRITY_NOTE } from "./compile";

/** A figure/table captured from the compiled report (raw SVG or HTML table). */
export interface ReportAsset {
  caption: string;
  /** The pathway step this figure came from — used to place it in that section. */
  stepId?: string;
  /** Serialised <svg> markup, when the figure is a chart/diagram. */
  svg?: string;
  /** Raw <table> HTML, when the figure is a data table. */
  tableHtml?: string;
}

type NumberedAsset = ReportAsset & { n: number };

/**
 * Assign each asset to its section (by stepId) and number them in document order
 * — sections first (in order), then any asset whose step has no section. Lets
 * every exporter place a figure with the step it was pulled from.
 */
function planFigures(m: Manuscript, assets: ReportAsset[]): { byStep: Map<string, NumberedAsset[]>; leftovers: NumberedAsset[] } {
  const grouped = new Map<string, ReportAsset[]>();
  for (const a of assets) {
    const k = a.stepId ?? "";
    const arr = grouped.get(k) ?? [];
    arr.push(a);
    grouped.set(k, arr);
  }
  const sectionSteps = new Set(m.sections.map((s) => s.stepId));
  const byStep = new Map<string, NumberedAsset[]>();
  const leftovers: NumberedAsset[] = [];
  let n = 0;
  for (const sec of m.sections) {
    const arr = (grouped.get(sec.stepId) ?? []).map((a) => ({ ...a, n: ++n }));
    if (arr.length) byStep.set(sec.stepId, arr);
  }
  for (const a of assets) {
    if (!sectionSteps.has(a.stepId ?? "")) leftovers.push({ ...a, n: ++n });
  }
  return { byStep, leftovers };
}

function latexEscape(s: string): string {
  return s.replace(/([&%$#_{}])/g, "\\$1").replace(/~/g, "\\textasciitilde{}").replace(/\^/g, "\\textasciicircum{}");
}
function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const subtitle = (m: Manuscript) => `${m.studyTypeLabel}: structured draft (${m.reportingStandard})`;
const byline = (m: Manuscript) => (m.front.authors.length ? m.front.authors.join(", ") : "");

export function toMarkdown(m: Manuscript, references: string[], assets: ReportAsset[] = []): string {
  const { byStep, leftovers } = planFigures(m, assets);
  // Raw SVG/HTML — renders in HTML-capable Markdown viewers (and Word/PDF).
  const figMd = (a: NumberedAsset): string[] =>
    [`**Figure ${a.n}.** ${a.caption}`, ...(a.svg || a.tableHtml ? [a.svg ?? a.tableHtml ?? ""] : [])];

  const parts: string[] = [`# ${m.title}`, `*${subtitle(m)}*`];
  if (byline(m)) parts.push(`**${byline(m)}**`);
  if (m.front.affiliation) parts.push(`*${m.front.affiliation}*`);
  if (m.front.correspondence) parts.push(`Correspondence: ${m.front.correspondence}`);
  if (m.front.date) parts.push(`${m.front.date}`);
  parts.push(`> ${INTEGRITY_NOTE}`);
  if (m.abstract.length) parts.push("## Abstract", ...m.abstract);
  for (const sec of m.sections) {
    parts.push(`## ${sec.heading}`, ...sec.paragraphs);
    for (const a of byStep.get(sec.stepId) ?? []) parts.push(...figMd(a));
  }
  if (leftovers.length) {
    parts.push("## Figures & tables");
    for (const a of leftovers) parts.push(...figMd(a));
  }
  if (references.length) {
    parts.push("## References", ...references.map((r, i) => `${i + 1}. ${r}`));
  }
  if (m.methodsCitations.length) {
    parts.push("## Statistical methods references", ...m.methodsCitations.map((r) => `- ${r}`));
  }
  return parts.join("\n\n") + "\n";
}

export function toLaTeX(m: Manuscript, references: string[], assets: ReportAsset[] = []): string {
  const { byStep, leftovers } = planFigures(m, assets);
  // Vector SVGs can't inline in LaTeX offline; reference each figure by number
  // where it belongs (full figures are in the HTML/Word/PDF export).
  const figTex = (a: NumberedAsset) =>
    `\\par\\smallskip\\noindent\\textit{[Figure ${a.n}. ${latexEscape(a.caption)} (see the Word/PDF export)]}`;

  const abstract = m.abstract.length
    ? `\\begin{abstract}\n${m.abstract.map(latexEscape).join("\\\\\n")}\n\\end{abstract}`
    : `\\begin{abstract}\\textit{${latexEscape(subtitle(m))}.} ${latexEscape(INTEGRITY_NOTE)}\\end{abstract}`;
  const body = m.sections
    .map((sec: ManuscriptSection) => {
      const figs = (byStep.get(sec.stepId) ?? []).map(figTex).join("\n");
      return `\\section{${latexEscape(sec.heading)}}\n${sec.paragraphs.map(latexEscape).join("\n\n")}${figs ? `\n${figs}` : ""}`;
    })
    .join("\n\n");
  const figs = leftovers.length
    ? `\n\n\\section{Figures \\& tables}\n${leftovers.map(figTex).join("\n")}`
    : "";
  const bib = references.length
    ? `\n\n\\begin{thebibliography}{99}\n${references.map((r) => `\\bibitem{} ${latexEscape(r)}`).join("\n")}\n\\end{thebibliography}`
    : "";
  const methodBib = m.methodsCitations.length
    ? `\n\n\\section*{Statistical methods references}\n\\begin{itemize}\n${m.methodsCitations
        .map((r) => `\\item ${latexEscape(r)}`)
        .join("\n")}\n\\end{itemize}`
    : "";
  return [
    "\\documentclass[11pt]{article}",
    "\\usepackage[utf8]{inputenc}",
    "\\usepackage[margin=1in]{geometry}",
    `\\title{${latexEscape(m.title)}}`,
    byline(m) ? `\\author{${latexEscape(byline(m))}${m.front.affiliation ? `\\\\ \\small ${latexEscape(m.front.affiliation)}` : ""}}` : "\\author{}",
    m.front.date ? `\\date{${latexEscape(m.front.date)}}` : "\\date{}",
    "\\begin{document}",
    "\\maketitle",
    abstract,
    body,
    figs,
    bib,
    methodBib,
    "\\end{document}",
    "",
  ].join("\n");
}

/**
 * Journal-style HTML that Word and browsers both render. Uses a title page,
 * serif body (Georgia/Times), justified text, styled figures/tables, and a
 * hanging-indent reference list. `@page` margins make the print-to-PDF path from
 * Word look like a manuscript.
 */
export function toHTML(m: Manuscript, references: string[], assets: ReportAsset[] = []): string {
  const authors = byline(m);
  const front = [
    authors ? `<p class="authors">${htmlEscape(authors)}</p>` : "",
    m.front.affiliation ? `<p class="affil">${htmlEscape(m.front.affiliation)}</p>` : "",
    m.front.correspondence ? `<p class="corr">Correspondence: ${htmlEscape(m.front.correspondence)}</p>` : "",
    m.front.date ? `<p class="date">${htmlEscape(m.front.date)}</p>` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const abstract = m.abstract.length
    ? `<section class="abstract"><h2>Abstract</h2>${m.abstract
        .map((p) => `<p>${abstractLine(p)}</p>`)
        .join("\n")}</section>`
    : "";

  const { byStep, leftovers } = planFigures(m, assets);
  const figHtml = (a: NumberedAsset) =>
    `<figure>${a.svg ?? a.tableHtml ?? ""}<figcaption><b>Figure ${a.n}.</b> ${htmlEscape(a.caption)}</figcaption></figure>`;

  const secs = m.sections
    .map((sec) => {
      const figs = (byStep.get(sec.stepId) ?? []).map(figHtml).join("\n");
      return `<section><h2>${htmlEscape(sec.heading)}</h2>\n${sec.paragraphs.map((p) => `<p>${htmlEscape(p)}</p>`).join("\n")}\n${figs}</section>`;
    })
    .join("\n");

  const figs = leftovers.length
    ? `<section class="figures"><h2>Figures &amp; tables</h2>\n${leftovers.map(figHtml).join("\n")}</section>`
    : "";

  const refs = references.length
    ? `<section class="refs"><h2>References</h2>\n<ol>${references.map((r) => `<li>${htmlEscape(r)}</li>`).join("")}</ol></section>`
    : "";
  const methodRefs = m.methodsCitations.length
    ? `<section class="refs"><h2>Statistical methods references</h2>\n<ol>${m.methodsCitations.map((r) => `<li>${htmlEscape(r)}</li>`).join("")}</ol></section>`
    : "";

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${htmlEscape(m.title)}</title>
<style>
  @page { size: A4; margin: 2.2cm; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #111; line-height: 1.55; font-size: 11.5pt;
         max-width: 46rem; margin: 0 auto; padding: 2rem 1.5rem; text-align: justify; }
  .titlepage { text-align: center; border-bottom: 2px solid #222; padding-bottom: 1rem; margin-bottom: 1.5rem; }
  h1 { font-size: 1.7rem; line-height: 1.25; margin: 0 0 .35rem; font-weight: 700; text-align: center; }
  .subtitle { font-style: italic; color: #555; margin: 0 0 .75rem; font-size: .95rem; }
  .authors { font-size: 1.05rem; font-weight: 600; margin: .5rem 0 .1rem; }
  .affil { font-style: italic; color: #444; margin: .1rem 0; font-size: .9rem; }
  .corr, .date { color: #666; font-size: .82rem; margin: .1rem 0; }
  h2 { font-size: 1.12rem; font-weight: 700; margin: 1.4rem 0 .4rem; padding-bottom: .15rem;
       border-bottom: 1px solid #ddd; text-align: left; }
  p { margin: 0 0 .6rem; }
  .abstract { background: #f6f6f8; border-left: 3px solid #444; padding: .75rem 1rem; margin: 1.2rem 0; text-align: left; }
  .abstract h2 { border: 0; margin-top: 0; font-size: 1rem; text-transform: uppercase; letter-spacing: .04em; }
  .abstract p { margin: .3rem 0; }
  .note { font-style: italic; color: #666; font-size: .82rem; border-left: 3px solid #6C5CE7; padding: .4rem .75rem; margin: 1rem 0; text-align: left; }
  figure { margin: 1.1rem 0; page-break-inside: avoid; text-align: center; }
  figure svg { max-width: 100%; height: auto; }
  figcaption { font-size: .85rem; color: #555; margin-top: .3rem; text-align: left; }
  table { border-collapse: collapse; width: 100%; margin: 0 auto; font-size: .85rem; }
  td, th { border: 1px solid #bbb; padding: 4px 7px; text-align: left; }
  th { background: #f0f0f3; }
  .refs ol { padding-left: 1.4rem; text-align: left; }
  .refs li { margin-bottom: .35rem; }
</style>
</head><body>
<div class="titlepage">
  <h1>${htmlEscape(m.title)}</h1>
  <p class="subtitle">${htmlEscape(subtitle(m))}</p>
  ${front}
</div>
<p class="note">${htmlEscape(INTEGRITY_NOTE)}</p>
${abstract}
${secs}
${figs}
${refs}
${methodRefs}
</body></html>
`;
}

/** Bold the "Background:/Methods:/Results:" label in an abstract line. */
function abstractLine(p: string): string {
  const m = p.match(/^(Background|Methods|Results|Conclusions?):\s*(.*)$/);
  return m ? `<b>${m[1]}:</b> ${htmlEscape(m[2])}` : htmlEscape(p);
}
