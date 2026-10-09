import { afterEach, describe, expect, it } from "vitest";
import { actorName, resetIdentity, useIdentity } from "./identity-store";

describe("resetIdentity", () => {
  afterEach(() => {
    resetIdentity();
    localStorage.clear();
  });

  it("blanks the name and returns the role to researcher, in memory and on the device", () => {
    useIdentity.getState().setName("Ada Lovelace");
    useIdentity.getState().setRole("supervisor");
    expect(JSON.parse(localStorage.getItem("scholea.identity")!)).toEqual({ name: "Ada Lovelace", role: "supervisor" });

    resetIdentity();

    expect(useIdentity.getState().name).toBe("");
    expect(useIdentity.getState().role).toBe("researcher");
    expect(useIdentity.getState().isSet()).toBe(false);
    expect(localStorage.getItem("scholea.identity")).toBeNull();
    expect(actorName()).toBe("local");
  });

  it("leaves the identity usable afterwards", () => {
    resetIdentity();
    useIdentity.getState().setName("Grace Hopper");
    expect(useIdentity.getState().name).toBe("Grace Hopper");
    expect(JSON.parse(localStorage.getItem("scholea.identity")!)).toEqual({ name: "Grace Hopper", role: "researcher" });
  });
});
