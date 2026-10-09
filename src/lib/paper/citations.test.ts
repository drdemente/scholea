import { describe, expect, it } from "vitest";
import { formatReference, formatReferenceList, parseAuthor } from "./citations";
import type { WorkRecord } from "@/lib/sources/types";

describe("parseAuthor", () => {
  it("handles 'Family Initials' (Europe PMC / PubMed)", () => {
    expect(parseAuthor("Okafor R")).toEqual({ family: "Okafor", initials: "R." });
    expect(parseAuthor("Okafor RJ")).toEqual({ family: "Okafor", initials: "R. J." });
  });
  it("handles 'Given Family' (Crossref / OpenAlex)", () => {
    expect(parseAuthor("Rae Okafor")).toEqual({ family: "Okafor", initials: "R." });
    expect(parseAuthor("Mary Jane Watson")).toEqual({ family: "Watson", initials: "M. J." });
  });
});

const recs: WorkRecord[] = [
  { id: "1", source: "europepmc", title: "Mindfulness and exam anxiety", authors: ["Okafor R", "Lindqvist M"], year: 2024, journal: "J College Mental Health", doi: "10.1/abc" },
  { id: "2", source: "crossref", title: "Brief inductions", authors: ["Vera Romero"], year: 2023, journal: "Cognition" },
];

describe("formatReference", () => {
  it("APA: authors (year). title. journal. doi", () => {
    const out = formatReference(recs[0], "apa");
    expect(out).toContain("Okafor, R., & Lindqvist, M. (2024).");
    expect(out).toContain("Mindfulness and exam anxiety.");
    expect(out).toContain("https://doi.org/10.1/abc");
  });
  it("Vancouver: numbered, family + initials, year", () => {
    const out = formatReference(recs[0], "vancouver", 3);
    expect(out.startsWith("3. Okafor R, Lindqvist M.")).toBe(true);
    expect(out).toContain("2024.");
  });
  it("handles missing year and journal gracefully", () => {
    const bare: WorkRecord = { id: "x", source: "demo", title: "T", authors: [] };
    expect(formatReference(bare, "apa")).toContain("(n.d.)");
  });
});

describe("formatReferenceList", () => {
  it("APA sorts alphabetically by family name", () => {
    const list = formatReferenceList(recs, "apa");
    expect(list[0]).toContain("Okafor"); // O before R(omero)
    expect(list[1]).toContain("Romero");
  });
  it("Vancouver preserves citation order", () => {
    const list = formatReferenceList(recs, "vancouver");
    expect(list[0].startsWith("1.")).toBe(true);
    expect(list[1].startsWith("2.")).toBe(true);
  });
});
