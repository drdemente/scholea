import { describe, expect, it } from "vitest";
import { hasRealStudies, includedStudies, recordLabelMap, screeningIncludes, studyLabel } from "./included";
import type { Project } from "@/lib/db/schema";
import type { WorkRecord } from "@/lib/sources/types";

const rec = (id: string, author: string, year: number): WorkRecord => ({
  id,
  source: "europepmc",
  title: `Study ${id}`,
  authors: [author],
  year,
});

function project(stepData: Project["stepData"]): Project {
  return { id: "p1", title: "T", studyType: "systematic-review", stepData, stepStatus: {}, createdAt: 0, updatedAt: 0 };
}

describe("studyLabel", () => {
  it("uses first-author surname + year for both author formats", () => {
    expect(studyLabel(rec("a", "Okafor R", 2024))).toBe("Okafor 2024");
    expect(studyLabel(rec("a", "Rae Nakamura", 2025))).toBe("Nakamura 2025");
  });
});

describe("recordLabelMap", () => {
  it("resolves any known record id to its Author-Year label across pools", () => {
    const map = recordLabelMap(
      project({
        search: { records: [rec("s:1", "Okafor R", 2024)] },
        dedup: { records: [rec("s:2", "Lund E", 2023)] },
        fulltext: { includedRecords: [rec("s:3", "Rae Nakamura", 2025)] },
      }),
    );
    expect(map.get("s:1")).toBe("Okafor 2024");
    expect(map.get("s:2")).toBe("Lund 2023");
    expect(map.get("s:3")).toBe("Nakamura 2025");
    // Demo records are always included as a last-resort pool.
    expect(map.size).toBeGreaterThan(3);
  });
});

describe("includedStudies fallback chain", () => {
  const a = rec("s:1", "Okafor R", 2024);
  const b = rec("s:2", "Lund E", 2023);
  const c = rec("s:3", "Rae Nakamura", 2025);

  it("prefers the full-text step's final inclusions", () => {
    const p = project({
      fulltext: { includedRecords: [a] },
      search: { records: [a, b, c] },
      screening: { decisions: { "s:1": { r1: "include" }, "s:2": { r1: "include" } } },
    });
    expect(includedStudies(p).map((s) => s.id)).toEqual(["s:1"]);
    expect(hasRealStudies(p)).toBe(true);
  });

  it("falls back to Reviewer 1's screening inclusions over the dedup/search pool", () => {
    const p = project({
      search: { records: [a, b, c] },
      dedup: { records: [a, c] },
      screening: { decisions: { "s:1": { r1: "include" }, "s:3": { r1: "exclude" } } },
    });
    expect(screeningIncludes(p).map((r) => r.id)).toEqual(["s:1"]);
    expect(includedStudies(p).map((s) => s.label)).toEqual(["Okafor 2024"]);
  });

  it("uses a small demo set when nothing real has been captured", () => {
    const p = project({});
    const studies = includedStudies(p);
    expect(studies.length).toBe(4);
    expect(hasRealStudies(p)).toBe(false);
  });

  it("lists studies alphabetically by label in every downstream step", () => {
    const z = rec("r:z", "Zimmer T", 2024);
    const aa = rec("r:a", "Anders K", 2023);
    const m = rec("r:m", "Miller J", 2025);
    const p = project({
      search: { records: [z, aa, m] },
      screening: { decisions: { "r:z": { r1: "include" }, "r:a": { r1: "include" }, "r:m": { r1: "include" } } },
    });
    // Screening pool inclusions (drives the full-text list) are A→Z.
    expect(screeningIncludes(p).map((r) => r.id)).toEqual(["r:a", "r:m", "r:z"]);
    // Included studies (appraisal + synthesis) are A→Z by label.
    expect(includedStudies(p).map((s) => s.label)).toEqual(["Anders 2023", "Miller 2025", "Zimmer 2024"]);
  });
});
