/**
 * Reference export — BibTeX and RIS, the no-account fallback from §5.
 * Pure string builders so they're trivially testable and run offline.
 */
import type { WorkRecord } from "@/lib/sources/types";

function citeKey(r: WorkRecord, i: number): string {
  const first = r.authors[0]?.split(/\s+/).pop() ?? "anon";
  const surname = first.replace(/[^A-Za-z]/g, "") || "anon";
  return `${surname.toLowerCase()}${r.year ?? ""}${i}`;
}

/** Escape BibTeX special characters in field values. */
function bibEscape(s: string): string {
  return s.replace(/[\\{}#$%&_~^]/g, (c) => `\\${c}`);
}

export function toBibTeX(records: WorkRecord[]): string {
  return records
    .map((r, i) => {
      const fields: Array<[string, string | undefined]> = [
        ["title", r.title && `{${bibEscape(r.title)}}`],
        ["author", r.authors.length ? bibEscape(r.authors.join(" and ")) : undefined],
        ["journal", r.journal && bibEscape(r.journal)],
        ["year", r.year != null ? String(r.year) : undefined],
        ["doi", r.doi],
        ["url", r.oaUrl ?? r.url],
        ["abstract", r.abstract && bibEscape(r.abstract)],
      ];
      const body = fields
        .filter((f): f is [string, string] => Boolean(f[1]))
        .map(([k, v]) => `  ${k} = {${v}}`)
        .join(",\n");
      return `@article{${citeKey(r, i)},\n${body}\n}`;
    })
    .join("\n\n");
}

export function toRIS(records: WorkRecord[]): string {
  return records
    .map((r) => {
      const lines: string[] = ["TY  - JOUR"];
      for (const a of r.authors) lines.push(`AU  - ${a}`);
      if (r.title) lines.push(`TI  - ${r.title}`);
      if (r.journal) lines.push(`JO  - ${r.journal}`);
      if (r.year != null) lines.push(`PY  - ${r.year}`);
      if (r.doi) lines.push(`DO  - ${r.doi}`);
      if (r.oaUrl ?? r.url) lines.push(`UR  - ${r.oaUrl ?? r.url}`);
      if (r.abstract) lines.push(`AB  - ${r.abstract}`);
      lines.push("ER  - ");
      return lines.join("\n");
    })
    .join("\n\n");
}
