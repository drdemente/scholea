import { describe, expect, it } from "vitest";
import { toBibTeX, toRIS } from "./export";
import type { WorkRecord } from "@/lib/sources/types";

const r: WorkRecord = {
  id: "europepmc:1",
  source: "europepmc",
  title: "Mindfulness & exam anxiety",
  authors: ["Rae Okafor", "M Lindqvist"],
  year: 2024,
  journal: "J College Mental Health",
  doi: "10.1/abc",
  abstract: "A trial.",
};

describe("reference export", () => {
  it("emits a valid-looking BibTeX entry with an author-year key", () => {
    const out = toBibTeX([r]);
    expect(out).toMatch(/^@article\{okafor20240,/);
    expect(out).toContain("author = {Rae Okafor and M Lindqvist}");
    expect(out).toContain("doi = {10.1/abc}");
    // The ampersand in the title is escaped.
    expect(out).toContain("\\&");
  });

  it("emits RIS with one AU line per author and an ER terminator", () => {
    const out = toRIS([r]);
    expect(out).toContain("TY  - JOUR");
    expect((out.match(/AU  - /g) ?? []).length).toBe(2);
    expect(out).toContain("DO  - 10.1/abc");
    expect(out.trimEnd().endsWith("ER  -")).toBe(true);
  });

  it("handles records with missing optional fields", () => {
    const bare: WorkRecord = { id: "x", source: "demo", title: "T", authors: [] };
    expect(() => toBibTeX([bare])).not.toThrow();
    expect(() => toRIS([bare])).not.toThrow();
  });
});
