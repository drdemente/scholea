import { describe, expect, it } from "vitest";
import { ACCENT_STYLE_ID } from "@/lib/instance/apply-accent";
import { INSTANCE_KEY, useInstance } from "@/lib/instance/instance-store";
import { useAuthUi } from "./auth-ui";
import { initAccount } from "./boot";
import { useSession } from "./session-store";

describe("initAccount", () => {
  it("clears what the old server client left behind, keeps everything else, and can be called again", () => {
    const legacy = ["scholea.token", "scholea.user", "scholea.apiBase", "scholea.sync.p1", "scholea.shared.p1"];
    for (const key of legacy) localStorage.setItem(key, "x");
    localStorage.setItem("scholea.identity", JSON.stringify({ name: "Ada", role: "researcher" }));
    localStorage.setItem("scholea.link.p1", JSON.stringify({ kind: "device", asked: true }));
    const before = useSession.getState().phase;

    expect(() => initAccount()).not.toThrow();
    expect(() => initAccount()).not.toThrow();

    for (const key of legacy) expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem("scholea.identity")).not.toBeNull();
    expect(localStorage.getItem("scholea.link.p1")).not.toBeNull();
    // Starting the account layer signs nobody in and opens nothing.
    expect(useSession.getState().phase).toBe(before);
    expect(useAuthUi.getState().open).toBe(false);
  });

  it("leaves a guest with stock Scholea: no organisation settings, no record of any, no accent on the page", () => {
    initAccount();
    expect(useInstance.getState().instance).toBeNull();
    expect(localStorage.getItem(INSTANCE_KEY)).toBeNull();
    expect(document.getElementById(ACCENT_STYLE_ID)).toBeNull();
  });
});
