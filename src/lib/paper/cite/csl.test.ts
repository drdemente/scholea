import { describe, expect, it } from "vitest";
import { toCslJson } from "./csl";
import type { WorkRecord } from "@/lib/sources/types";

const rec: WorkRecord = {
  id: "openalex:W1",
  source: "openalex",
  title: "Mindfulness apps for test anxiety",
  authors: ["Okafor R", "Rae Nakamura"],
  year: 2024,
  journal: "Higher Ed Wellbeing",
  doi: "10.1/abc",
  url: "https://doi.org/10.1/abc",
};

describe("toCslJson", () => {
  it("maps a record to CSL-JSON with authors, issued year, journal, DOI", () => {
    const item = toCslJson(rec);
    expect(item).toMatchObject({
      id: "openalex:W1",
      type: "article-journal",
      title: "Mindfulness apps for test anxiety",
      "container-title": "Higher Ed Wellbeing",
      DOI: "10.1/abc",
      URL: "https://doi.org/10.1/abc",
    });
    expect(item.issued).toEqual({ "date-parts": [[2024]] });
    // "Okafor R" → family Okafor; "Rae Nakamura" → family Nakamura
    expect(item.author.map((a) => a.family)).toEqual(["Okafor", "Nakamura"]);
  });

  it("falls back to a synthetic id and omits missing fields", () => {
    const item = toCslJson({ id: "", source: "crossref", title: "Untitled", authors: [] }, 3);
    expect(item.id).toBe("item-3");
    expect(item.issued).toBeUndefined();
    expect(item["container-title"]).toBeUndefined();
    expect(item.author).toEqual([]);
  });
});
