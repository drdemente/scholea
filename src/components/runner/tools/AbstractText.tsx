import { useMemo, type ReactNode } from "react";

/** Structured-abstract section labels — bolded when they lead a plain-text run. */
const LABELS =
  /^(background|objectives?|aims?|introduction|methods?|materials and methods|design|setting|participants|patients|interventions?|main outcome measures?|measurements?|results?|findings?|conclusions?|interpretation|importance|significance|purpose|rationale|context)\b\s*[:.]?/i;

/** Strip tags + decode the common entities to readable plain text. */
function toPlain(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

export interface AbstractSegment {
  kind: "heading" | "para";
  text: string;
  /** For a para, a leading structured label to bold ("Background", …). */
  label?: string;
}

/**
 * Parse a possibly-HTML/JATS abstract into readable segments. Heading tags
 * (`<h1>`–`<h6>`, `<title>`, JATS `<jats:title>` — Europe PMC structured
 * abstracts use `<h4>`) become headings; all other tags are stripped so the
 * reader sees clean text, not raw `<h4>` markers. A leading structured label
 * ("Background:", …) in an otherwise plain run is flagged for bolding. Pure, so
 * it's unit-testable.
 */
export function abstractSegments(text: string): AbstractSegment[] {
  // Normalise JATS namespaced tags and treat section <title> as a heading.
  let s = text.replace(/<(\/?)jats:/gi, "<$1");
  s = s.replace(/<title\b[^>]*>/gi, "<h4>").replace(/<\/title>/gi, "</h4>");

  const out: AbstractSegment[] = [];
  for (const part of s.split(/(<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>)/gi)) {
    const heading = part.match(/^<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>$/i);
    if (heading) {
      const h = toPlain(heading[1]).replace(/[:.]\s*$/, "");
      if (h) out.push({ kind: "heading", text: h });
      continue;
    }
    const t = toPlain(part);
    if (!t) continue;
    const lm = t.match(LABELS);
    if (lm) {
      out.push({ kind: "para", text: t.slice(lm[0].length).trim(), label: t.slice(0, lm[0].length).replace(/[:.]\s*$/, "") });
    } else {
      out.push({ kind: "para", text: t });
    }
  }
  return out.length ? out : [{ kind: "para", text: toPlain(text) }];
}

/** Render a possibly-HTML/JATS abstract for reading (headings bold, tags stripped). */
export function AbstractText({ text }: { text: string }) {
  const nodes = useMemo<ReactNode[]>(
    () =>
      abstractSegments(text).map((seg, i) =>
        seg.kind === "heading" ? (
          <p key={i} className="mt-2 font-semibold text-ink first:mt-0">{seg.text}</p>
        ) : (
          <p key={i} className="mt-1.5 first:mt-0">
            {seg.label && <strong className="text-ink">{seg.label}. </strong>}
            {seg.text}
          </p>
        ),
      ),
    [text],
  );

  return <div className="text-sm leading-relaxed text-ink-soft">{nodes}</div>;
}
