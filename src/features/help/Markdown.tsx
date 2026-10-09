import { Fragment, type ReactNode } from "react";

/**
 * A small, dependency-free Markdown renderer tuned to the constructs used in the
 * Scholea User Guide (docs/USER_GUIDE.md): H1–H3 headings, paragraphs, ordered
 * and unordered lists (with wrapped continuation lines), pipe tables,
 * blockquote callouts, horizontal rules, and inline **bold** / *italic* /
 * `code` / [links]. It is intentionally not a full CommonMark parser.
 */

export interface Section {
  id: string;
  title: string;
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60);

/** Inline formatting → React nodes. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(<Fragment key={k++}>{text.slice(last, m.index)}</Fragment>);
    if (m[1]) out.push(<strong key={k++} className="font-semibold text-ink">{m[2]}</strong>);
    else if (m[3]) out.push(<em key={k++}>{m[4]}</em>);
    else if (m[5]) out.push(<code key={k++} className="rounded bg-elevated/70 px-1 py-0.5 font-mono text-[0.85em] text-primary">{m[6]}</code>);
    else if (m[7]) out.push(<span key={k++} className="text-primary">{m[8]}</span>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(<Fragment key={k++}>{text.slice(last)}</Fragment>);
  return out;
}

const isBullet = (l: string) => /^\s*[-*]\s+/.test(l);
const isNumber = (l: string) => /^\s*\d+\.\s+/.test(l);
const isHeading = (l: string) => /^#{1,3}\s/.test(l);
const isRule = (l: string) => /^---+\s*$/.test(l.trim());
const isTableRow = (l: string) => l.trim().startsWith("|");
const isTableSep = (l: string) => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes("-");
const isBlock = (l: string) => isBullet(l) || isNumber(l) || isHeading(l) || isRule(l) || isTableRow(l) || /^\s*>\s?/.test(l);

function splitRow(l: string): string[] {
  const cells = l.trim().split("|");
  if (cells.length && cells[0].trim() === "") cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

/** Parse the guide into React nodes and collect H2 sections for the contents nav. */
export function parseMarkdown(md: string): { nodes: ReactNode[]; sections: Section[] } {
  const lines = md.split(/\r?\n/);
  const nodes: ReactNode[] = [];
  const sections: Section[] = [];
  let i = 0;
  let key = 0;
  let skippedTitle = false;

  const gatherItem = (start: number, first: string): [string, number] => {
    let text = first;
    let j = start + 1;
    while (j < lines.length && lines[j].trim() !== "" && !isBlock(lines[j])) {
      text += " " + lines[j].trim();
      j++;
    }
    return [text, j];
  };

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    if (isRule(line)) { i++; continue; }

    const hm = /^(#{1,3})\s+(.*)$/.exec(line);
    if (hm) {
      const level = hm[1].length;
      const t = hm[2].trim();
      if (level === 1 && !skippedTitle) { skippedTitle = true; i++; continue; }
      if (level === 2 && /^table of contents$/i.test(t)) {
        i++;
        while (i < lines.length && !/^##\s+/.test(lines[i])) i++;
        continue;
      }
      if (level === 2) {
        const id = slug(t);
        sections.push({ id, title: t });
        nodes.push(<h2 key={key++} id={id} className="scroll-mt-4 border-b border-hairline pb-1.5 pt-2 font-display text-xl font-bold text-ink">{inline(t)}</h2>);
      } else if (level === 3) {
        nodes.push(<h3 key={key++} className="scroll-mt-4 pt-1 font-display text-lg font-semibold text-primary">{inline(t)}</h3>);
      } else {
        nodes.push(<h1 key={key++} className="font-display text-2xl font-bold text-ink">{inline(t)}</h1>);
      }
      i++; continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const tbl: string[] = [];
      while (i < lines.length && isTableRow(lines[i])) { tbl.push(lines[i]); i++; }
      const header = splitRow(tbl[0]);
      const rows = tbl.slice(2).map(splitRow);
      nodes.push(
        <div key={key++} className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>{header.map((h, c) => <th key={c} className="border border-hairline bg-primary-soft/60 px-3 py-1.5 text-left font-semibold text-primary">{inline(h)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className={ri % 2 ? "" : "bg-elevated/40"}>
                  {r.map((cell, ci) => <td key={ci} className="border border-hairline px-3 py-1.5 align-top text-ink-soft">{inline(cell)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (isBullet(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && isBullet(lines[i])) {
        const lm = /^(\s*)[-*]\s+(.*)$/.exec(lines[i])!;
        const [text, next] = gatherItem(i, lm[2]);
        items.push(<li key={items.length} className="pl-1">{inline(text)}</li>);
        i = next;
      }
      nodes.push(<ul key={key++} className="list-disc space-y-1.5 pl-6 text-ink-soft marker:text-primary">{items}</ul>);
      continue;
    }

    if (isNumber(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && isNumber(lines[i])) {
        const lm = /^\s*\d+\.\s+(.*)$/.exec(lines[i])!;
        const [text, next] = gatherItem(i, lm[1]);
        items.push(<li key={items.length} className="pl-1">{inline(text)}</li>);
        i = next;
      }
      nodes.push(<ol key={key++} className="list-decimal space-y-1.5 pl-6 text-ink-soft marker:font-semibold marker:text-primary">{items}</ol>);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      nodes.push(
        <blockquote key={key++} className="rounded-input border-l-4 border-primary bg-primary-soft/30 px-4 py-2.5 text-ink-soft">
          {inline(q.join(" ").trim())}
        </blockquote>,
      );
      continue;
    }

    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !isBlock(lines[i])) { para.push(lines[i]); i++; }
    nodes.push(<p key={key++} className="leading-relaxed text-ink-soft">{inline(para.join(" "))}</p>);
  }

  return { nodes, sections };
}
