import { describe, expect, it } from "vitest";
import { derivePrismaCounts } from "./prisma";
import type { Project } from "@/lib/db/schema";

function project(stepData: Project["stepData"]): Project {
  return {
    id: "p",
    title: "p",
    studyType: "systematic-review",
    stepData,
    stepStatus: {},
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("derivePrismaCounts", () => {
  it("computes the flow from cross-step inputs", () => {
    const c = derivePrismaCounts(
      project({
        search: { nIdentified: 1200 },
        dedup: { nDuplicates: 300 },
        screening: { nExcludedScreening: 820, nIncludedScreening: 80 },
        fulltext: { nFullTextExcluded: 68 },
      }),
    );
    expect(c.identified).toBe(1200);
    expect(c.duplicatesRemoved).toBe(300);
    expect(c.screened).toBe(900); // identified − duplicates
    expect(c.soughtFullText).toBe(80);
    expect(c.included).toBe(12); // sought − full-text excluded
  });

  it("never goes negative and treats missing/invalid as 0", () => {
    const c = derivePrismaCounts(project({}));
    expect(c).toMatchObject({ identified: 0, screened: 0, included: 0 });

    const c2 = derivePrismaCounts(
      project({ search: { nIdentified: 10 }, dedup: { nDuplicates: 99 } }),
    );
    expect(c2.screened).toBe(0); // clamped, not −89
  });
});
