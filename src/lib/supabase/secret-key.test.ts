import { describe, expect, it } from "vitest";
import { isSecretKey, secretKeyRefusal, secretKeySettings } from "./secret-key";

/** A JWT-shaped legacy key carrying the given role (unsigned: only the shape matters here). */
function legacyKey(role: string): string {
  const part = (v: object) => btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part({ iss: "supabase", role })}.signature`;
}

describe("isSecretKey", () => {
  it("knows a secret key by its prefix, with or without space around it", () => {
    expect(isSecretKey("sb_secret_example")).toBe(true);
    expect(isSecretKey("  sb_secret_example\n")).toBe(true);
  });

  it("knows a legacy service_role key by the role inside it", () => {
    expect(isSecretKey(legacyKey("service_role"))).toBe(true);
  });

  it("lets the keys that are meant for clients through", () => {
    expect(isSecretKey("sb_publishable_example")).toBe(false);
    expect(isSecretKey(legacyKey("anon"))).toBe(false);
  });

  it("is false for anything that is not a key at all", () => {
    for (const value of ["", "   ", "https://abcdefgh.supabase.co", "a.b.c", "not.a-jwt.at-all", undefined, null, 42, true, {}]) {
      expect(isSecretKey(value)).toBe(false);
    }
  });
});

describe("secretKeySettings", () => {
  it("is empty for a guest build and for a build with the two public values", () => {
    expect(secretKeySettings({})).toEqual([]);
    expect(secretKeySettings({ VITE_SUPABASE_URL: "", VITE_SUPABASE_PUBLISHABLE_KEY: "" })).toEqual([]);
    expect(
      secretKeySettings({ VITE_SUPABASE_URL: "https://abcdefgh.supabase.co", VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example", MODE: "production" }),
    ).toEqual([]);
  });

  it("names the setting that holds a secret key of either kind", () => {
    expect(secretKeySettings({ VITE_SUPABASE_PUBLISHABLE_KEY: "sb_secret_example" })).toEqual(["VITE_SUPABASE_PUBLISHABLE_KEY"]);
    expect(secretKeySettings({ VITE_SUPABASE_ANON_KEY: legacyKey("service_role") })).toEqual(["VITE_SUPABASE_ANON_KEY"]);
  });

  it("finds one behind a good publishable key, which the app itself would not look at", () => {
    // The app uses the publishable key and ignores the legacy name, but the
    // bundler still writes both values into the build.
    expect(
      secretKeySettings({ VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example", VITE_SUPABASE_ANON_KEY: legacyKey("service_role") }),
    ).toEqual(["VITE_SUPABASE_ANON_KEY"]);
  });

  it("looks at every VITE_ setting, whatever its name, and at no other", () => {
    expect(
      secretKeySettings({
        VITE_SUPABASE_PUBLISHABLE_KEY: "sb_secret_one",
        VITE_ANYTHING_ELSE: " sb_secret_two ",
        // Not a VITE_ setting, so the bundler never writes it into a build.
        SUPABASE_SECRET_KEY: "sb_secret_three",
      }),
    ).toEqual(["VITE_ANYTHING_ELSE", "VITE_SUPABASE_PUBLISHABLE_KEY"]);
  });
});

describe("secretKeyRefusal", () => {
  it("names each setting that holds one", () => {
    const one = secretKeyRefusal(["VITE_SUPABASE_PUBLISHABLE_KEY"]);
    expect(one).toContain("VITE_SUPABASE_PUBLISHABLE_KEY holds a Supabase secret key");
    expect(one).toContain("nothing was built");

    const two = secretKeyRefusal(["VITE_SUPABASE_ANON_KEY", "VITE_SUPABASE_PUBLISHABLE_KEY"]);
    expect(two).toContain("VITE_SUPABASE_ANON_KEY and VITE_SUPABASE_PUBLISHABLE_KEY each hold a Supabase secret key");
  });
});
