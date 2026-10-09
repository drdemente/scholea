/**
 * Reference formatting (offline). A focused, tested formatter for APA 7,
 * Vancouver, and Harvard. The spec's full citeproc-js + CSL styles repository
 * is the documented upgrade path (thousands of styles); this covers the common
 * cases without the bundle cost and is unit-tested.
 */
import type { WorkRecord } from "@/lib/sources/types";

export type CitationStyle = "apa" | "vancouver" | "harvard";

export const CITATION_STYLES: { id: CitationStyle; label: string }[] = [
  { id: "apa", label: "APA 7" },
  { id: "vancouver", label: "Vancouver" },
  { id: "harvard", label: "Harvard" },
];

interface Name {
  family: string;
  /** Given names reduced to initials, e.g. "R. J." */
  initials: string;
}

/** Best-effort split of a free-text author into family + initials. Handles both
 *  "Okafor R" (Europe PMC/PubMed) and "Rae Okafor" (Crossref/OpenAlex). */
export function parseAuthor(name: string): Name {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { family: "", initials: "" };
  if (tokens.length === 1) return { family: tokens[0], initials: "" };

  const isInitials = (t: string) => /^[A-Z]{1,3}\.?$/.test(t);
  const last = tokens[tokens.length - 1];

  let family: string;
  let givenTokens: string[];
  if (isInitials(last)) {
    // "Okafor R" / "Okafor RJ" → family first, initials last.
    family = tokens.slice(0, -1).join(" ");
    givenTokens = last.replace(/\./g, "").split("");
  } else {
    // "Rae Okafor" / "Mary Jane Watson" → family last, given before.
    family = last;
    givenTokens = tokens.slice(0, -1);
  }
  const initials = givenTokens
    .map((g) => g[0]?.toUpperCase())
    .filter(Boolean)
    .map((i) => `${i}.`)
    .join(" ");
  return { family, initials };
}

function apaAuthors(authors: string[]): string {
  const names = authors.map(parseAuthor).map((n) => (n.initials ? `${n.family}, ${n.initials}` : n.family));
  if (names.length === 0) return "Anon.";
  if (names.length === 1) return names[0];
  if (names.length <= 20) return `${names.slice(0, -1).join(", ")}, & ${names[names.length - 1]}`;
  return `${names.slice(0, 19).join(", ")}, … ${names[names.length - 1]}`;
}

function vancouverAuthors(authors: string[]): string {
  const names = authors.map(parseAuthor).map((n) => `${n.family} ${n.initials.replace(/[.\s]/g, "")}`.trim());
  if (names.length === 0) return "Anon";
  if (names.length <= 6) return names.join(", ");
  return `${names.slice(0, 6).join(", ")}, et al`;
}

/** Format one reference in the chosen style. `index` is 1-based (Vancouver). */
export function formatReference(r: WorkRecord, style: CitationStyle, index = 1): string {
  const year = r.year ?? "n.d.";
  const journal = r.journal ?? "";
  const doi = r.doi ? `https://doi.org/${r.doi.replace(/^https?:\/\/doi\.org\//, "")}` : "";

  switch (style) {
    case "apa":
      return [
        `${apaAuthors(r.authors)} (${year}).`,
        `${r.title}.`,
        journal ? `${journal}.` : "",
        doi,
      ].filter(Boolean).join(" ");
    case "harvard":
      return [
        `${apaAuthors(r.authors)} (${year})`,
        `'${r.title}',`,
        journal ? `${journal}.` : "",
        doi,
      ].filter(Boolean).join(" ");
    case "vancouver":
      return [
        `${index}.`,
        `${vancouverAuthors(r.authors)}.`,
        `${r.title}.`,
        journal ? `${journal}.` : "",
        `${year}.`,
        doi,
      ].filter(Boolean).join(" ");
  }
}

export function formatReferenceList(records: WorkRecord[], style: CitationStyle): string[] {
  const list = records.map((r, i) => formatReference(r, style, i + 1));
  // APA/Harvard are alphabetical by family name; Vancouver stays in order.
  if (style === "vancouver") return list;
  return [...records]
    .map((r, i) => ({ key: parseAuthor(r.authors[0] ?? "").family.toLowerCase(), text: list[i] }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((x) => x.text);
}
