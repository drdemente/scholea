import { describe, expect, it } from "vitest";
import { dedupeRecords } from "./dedup";
import type { WorkRecord } from "./types";

const rec = (over: Partial<WorkRecord>): WorkRecord => ({
  id: "x",
  source: "europepmc",
  title: "Untitled",
  authors: [],
  ...over,
});

describe("dedupeRecords", () => {
  it("treats matching DOIs as duplicates regardless of source/case", () => {
    const r = dedupeRecords([
      rec({ id: "europepmc:1", doi: "10.1/ABC" }),
      rec({ id: "crossref:2", doi: "10.1/abc" }),
    ]);
    expect(r.unique).toHaveLength(1);
    expect(r.duplicatesRemoved).toBe(1);
  });

  it("falls back to normalised title + year when DOI is absent", () => {
    const r = dedupeRecords([
      rec({ id: "a", title: "Mindfulness and Exam Anxiety", year: 2024 }),
      rec({ id: "b", title: "mindfulness  and exam anxiety!", year: 2024 }),
      rec({ id: "c", title: "Mindfulness and Exam Anxiety", year: 2019 }),
    ]);
    // First two collapse; the 2019 one is a different signature.
    expect(r.unique).toHaveLength(2);
    expect(r.duplicatesRemoved).toBe(1);
  });

  it("merges useful fields from the dropped duplicate (DOI, abstract, OA)", () => {
    const r = dedupeRecords([
      rec({ id: "a", title: "Same study", year: 2024 }),
      rec({ id: "b", title: "Same study", year: 2024, doi: "10.5/x", abstract: "from dup", oaUrl: "http://oa" }),
    ]);
    expect(r.unique).toHaveLength(1);
    expect(r.unique[0]).toMatchObject({ id: "a", doi: "10.5/x", abstract: "from dup", oaUrl: "http://oa" });
  });

  it("keeps distinct records distinct", () => {
    const r = dedupeRecords([rec({ id: "a", doi: "10/1" }), rec({ id: "b", doi: "10/2" })]);
    expect(r.unique).toHaveLength(2);
    expect(r.duplicatesRemoved).toBe(0);
  });
});
