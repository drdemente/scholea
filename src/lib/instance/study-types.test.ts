import { describe, expect, it } from "vitest";
import { STUDY_CONFIGS, configsByFamily, type FamilyGroup } from "@/lib/study/registry";
import { effectiveAllowList, filterFamilies, isStudyTypeAllowed } from "./study-types";

const KNOWN = ["systematic-review", "rct", "cohort", "case-control", "qualitative"] as const;

describe("effectiveAllowList", () => {
  it("null means every type", () => {
    expect(effectiveAllowList(null, KNOWN)).toBeNull();
  });

  it("is the listed ids that this version knows", () => {
    const allow = effectiveAllowList(["rct", "cohort"], KNOWN);
    expect(Array.from(allow ?? []).sort()).toEqual(["cohort", "rct"]);
  });

  it("ignores ids this version does not know", () => {
    const allow = effectiveAllowList(["rct", "time-travel-study", "RCT", ""], KNOWN);
    expect(Array.from(allow ?? [])).toEqual(["rct"]);
  });

  it("restricts nothing when no listed id is known, rather than offering no types at all", () => {
    expect(effectiveAllowList(["time-travel-study", "another-unknown"], KNOWN)).toBeNull();
    expect(effectiveAllowList([], KNOWN)).toBeNull();
  });

  it("restricts nothing when every known id is listed", () => {
    expect(effectiveAllowList([...KNOWN], KNOWN)).toBeNull();
    expect(effectiveAllowList([...KNOWN, "time-travel-study", "rct"], KNOWN)).toBeNull();
    // One short of all of them is a restriction.
    expect(effectiveAllowList(KNOWN.slice(1), KNOWN)?.size).toBe(KNOWN.length - 1);
  });

  it("counts a repeated id once", () => {
    expect(effectiveAllowList(["rct", "rct", "rct"], KNOWN)?.size).toBe(1);
  });

  it("treats a list that is not a list as no list", () => {
    expect(effectiveAllowList("rct" as unknown as string[], KNOWN)).toBeNull();
    expect(effectiveAllowList(undefined as unknown as string[], KNOWN)).toBeNull();
    expect(effectiveAllowList([7, null, { id: "rct" }] as unknown as string[], KNOWN)).toBeNull();
  });

  it("restricts nothing when the app knows no types at all", () => {
    expect(effectiveAllowList(["rct"], [])).toBeNull();
  });
});

describe("isStudyTypeAllowed", () => {
  it("allows everything when there is no restriction", () => {
    expect(isStudyTypeAllowed("rct", null)).toBe(true);
    expect(isStudyTypeAllowed("anything-at-all", null)).toBe(true);
  });

  it("allows only the listed ids otherwise", () => {
    const allow = effectiveAllowList(["rct", "cohort"], KNOWN);
    expect(isStudyTypeAllowed("rct", allow)).toBe(true);
    expect(isStudyTypeAllowed("cohort", allow)).toBe(true);
    expect(isStudyTypeAllowed("qualitative", allow)).toBe(false);
    expect(isStudyTypeAllowed("time-travel-study", allow)).toBe(false);
  });
});

describe("filterFamilies", () => {
  const groups = configsByFamily();
  const idsOf = (list: FamilyGroup[]) => list.flatMap((g) => g.configs.map((c) => c.id));

  it("returns the groups as they are when there is no restriction", () => {
    expect(filterFamilies(groups, null)).toBe(groups);
  });

  it("keeps only the allowed types, in the chooser's order", () => {
    const allow = effectiveAllowList(["cohort", "systematic-review", "rct"], idsOf(groups));
    const filtered = filterFamilies(groups, allow);
    expect(idsOf(filtered)).toEqual(idsOf(groups).filter((id) => ["cohort", "systematic-review", "rct"].includes(id)));
    expect(idsOf(filtered)).toHaveLength(3);
  });

  it("drops a family left with no types", () => {
    const allow = effectiveAllowList(["rct"], idsOf(groups));
    const filtered = filterFamilies(groups, allow);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].family).toBe("experimental");
    expect(filtered[0].label).toBe(groups.find((g) => g.family === "experimental")?.label);
    expect(filtered[0].configs.map((c) => c.id)).toEqual(["rct"]);
  });

  it("does not change the groups it was given", () => {
    const before = groups.map((g) => g.configs.length);
    filterFamilies(groups, effectiveAllowList(["rct"], idsOf(groups)));
    expect(groups.map((g) => g.configs.length)).toEqual(before);
    expect(idsOf(groups)).toHaveLength(STUDY_CONFIGS.length);
  });

  it("gives no groups for an allow-list that matches nothing shown", () => {
    expect(filterFamilies(groups, new Set(["time-travel-study"]))).toEqual([]);
  });
});

describe("the registry and the allow-list", () => {
  const ids = STUDY_CONFIGS.map((c) => c.id);

  it("every study-type id is one the backend's list can carry", () => {
    // The backend and the cleaning gate accept only ids of this form. An id
    // outside it could never be allowed once an organisation limits its types.
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]{1,64}$/);
  });

  it("an organisation's list of real ids offers exactly those", () => {
    const allow = effectiveAllowList(["systematic-review", "meta-analysis", "scoping-review"], ids);
    expect(ids.filter((id) => isStudyTypeAllowed(id, allow))).toEqual(["systematic-review", "meta-analysis", "scoping-review"]);
    expect(filterFamilies(configsByFamily(), allow).flatMap((g) => g.configs)).toHaveLength(3);
  });

  it("listing every type the app has is the same as no list", () => {
    expect(effectiveAllowList(ids, ids)).toBeNull();
  });
});
