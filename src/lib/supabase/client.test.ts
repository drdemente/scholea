import { describe, expect, it } from "vitest";
import { AUTH_STORAGE_KEY, buildSupabaseClient } from "./client";

describe("buildSupabaseClient", () => {
  it("is null when the build has no backend settings", () => {
    expect(buildSupabaseClient(null)).toBeNull();
  });

  it("is null, not an exception, when the settings are unusable", () => {
    expect(() => buildSupabaseClient({ url: "not a url", key: "sb_publishable_example" })).not.toThrow();
    expect(buildSupabaseClient({ url: "not a url", key: "sb_publishable_example" })).toBeNull();
    expect(buildSupabaseClient({ url: "https://scholea.example.test", key: "" })).toBeNull();
  });

  it("builds a client that keeps its session under scholea.auth and ignores the URL", () => {
    const client = buildSupabaseClient({ url: "https://scholea.example.test", key: "sb_publishable_example" });
    expect(client).not.toBeNull();
    expect(AUTH_STORAGE_KEY).toBe("scholea.auth");
    // Read back the options the auth client was given.
    const auth = client!.auth as unknown as { storageKey: string; detectSessionInUrl: boolean; persistSession: boolean };
    expect(auth.storageKey).toBe("scholea.auth");
    expect(auth.detectSessionInUrl).toBe(false);
    expect(auth.persistSession).toBe(true);
  });
});
