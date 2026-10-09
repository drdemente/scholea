import { describe, expect, it } from "vitest";
import { checklistFor, checklistTotal, CHECKLISTS } from "./checklists";

describe("checklist library", () => {
  it("resolves a known standard", () => {
    const prisma = checklistFor("PRISMA-2020");
    expect(prisma.length).toBeGreaterThan(0);
    expect(checklistTotal(prisma)).toBeGreaterThan(10);
  });

  it("falls back to GENERIC for an unknown standard", () => {
    expect(checklistFor("SOMETHING-ELSE")).toBe(CHECKLISTS.NONE);
  });

  it("every item has a unique id within a standard", () => {
    for (const [standard, sections] of Object.entries(CHECKLISTS)) {
      const ids = sections.flatMap((s) => s.items.map((i) => i.id));
      expect(new Set(ids).size, standard).toBe(ids.length);
    }
  });
});
