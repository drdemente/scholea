import { describe, expect, it } from "vitest";
import { isSupabaseConfigured, readSupabaseConfig } from "./config";

const URL_OK = "https://abcdefgh.supabase.co";
const KEY_OK = "sb_publishable_example";

/** A JWT-shaped legacy key carrying the given role (unsigned: only the shape matters here). */
function legacyKey(role: string): string {
  const part = (v: object) => btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part({ iss: "supabase", role })}.signature`;
}

describe("readSupabaseConfig", () => {
  it("is null when nothing is set (the guest-only build)", () => {
    expect(readSupabaseConfig({})).toBeNull();
    expect(readSupabaseConfig(null)).toBeNull();
    expect(readSupabaseConfig(undefined)).toBeNull();
  });

  it("is null when only one of the two values is set", () => {
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: URL_OK })).toBeNull();
    expect(readSupabaseConfig({ VITE_SUPABASE_PUBLISHABLE_KEY: KEY_OK })).toBeNull();
  });

  it("treats an empty string as unset (a missing CI variable expands to '')", () => {
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: "", VITE_SUPABASE_PUBLISHABLE_KEY: "" })).toBeNull();
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: "" })).toBeNull();
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: "", VITE_SUPABASE_PUBLISHABLE_KEY: KEY_OK })).toBeNull();
  });

  it("treats whitespace as unset and trims real values", () => {
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: "   ", VITE_SUPABASE_PUBLISHABLE_KEY: " \n" })).toBeNull();
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: `  ${URL_OK}  `, VITE_SUPABASE_PUBLISHABLE_KEY: ` ${KEY_OK}\n` })).toEqual({
      url: URL_OK,
      key: KEY_OK,
    });
  });

  it("rejects a URL that is not http or https", () => {
    for (const bad of ["not a url", "abcdefgh.supabase.co", "ftp://example.org", "javascript:alert(1)", "file:///etc/hosts"]) {
      expect(readSupabaseConfig({ VITE_SUPABASE_URL: bad, VITE_SUPABASE_PUBLISHABLE_KEY: KEY_OK })).toBeNull();
    }
  });

  it("accepts the local stack over plain http", () => {
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: "http://127.0.0.1:56321", VITE_SUPABASE_PUBLISHABLE_KEY: KEY_OK })).toEqual({
      url: "http://127.0.0.1:56321",
      key: KEY_OK,
    });
  });

  it("drops a trailing slash from the URL", () => {
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: `${URL_OK}//`, VITE_SUPABASE_PUBLISHABLE_KEY: KEY_OK })?.url).toBe(URL_OK);
  });

  it("prefers the publishable key over the legacy anon key", () => {
    const anon = legacyKey("anon");
    expect(
      readSupabaseConfig({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: KEY_OK, VITE_SUPABASE_ANON_KEY: anon })?.key,
    ).toBe(KEY_OK);
  });

  it("falls back to the legacy anon key when the publishable key is unset or empty", () => {
    const anon = legacyKey("anon");
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_ANON_KEY: anon })?.key).toBe(anon);
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: "", VITE_SUPABASE_ANON_KEY: anon })?.key).toBe(
      anon,
    );
  });

  it("refuses a secret key", () => {
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: "sb_secret_example" })).toBeNull();
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_ANON_KEY: "sb_secret_example" })).toBeNull();
    // A secret key in the preferred slot is not rescued by a good legacy key.
    expect(
      readSupabaseConfig({
        VITE_SUPABASE_URL: URL_OK,
        VITE_SUPABASE_PUBLISHABLE_KEY: "sb_secret_example",
        VITE_SUPABASE_ANON_KEY: legacyKey("anon"),
      }),
    ).toBeNull();
  });

  it("refuses a legacy service_role key", () => {
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_ANON_KEY: legacyKey("service_role") })).toBeNull();
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: legacyKey("service_role") })).toBeNull();
  });

  it("refuses a key with whitespace inside it", () => {
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_a b" })).toBeNull();
  });

  it("ignores values that are not strings", () => {
    const env = { VITE_SUPABASE_URL: 42, VITE_SUPABASE_PUBLISHABLE_KEY: true } as unknown as Parameters<typeof readSupabaseConfig>[0];
    expect(readSupabaseConfig(env)).toBeNull();
  });
});

describe("this suite", () => {
  // `pnpm test` reads no env file and blanks the three settings (vite.config.ts),
  // so a developer's .env.local, which may name a real project, never reaches a
  // test. A run that asks for a mode (`vitest run --mode <name>`) is deliberate
  // and is left alone. Only yes or no is compared: a failure prints no value.
  it.skipIf(import.meta.env.MODE !== "test")("has no backend, whatever the env files or the shell hold", () => {
    expect(isSupabaseConfigured).toBe(false);
    expect(Boolean(import.meta.env.VITE_SUPABASE_URL)).toBe(false);
    expect(Boolean(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY)).toBe(false);
    expect(Boolean(import.meta.env.VITE_SUPABASE_ANON_KEY)).toBe(false);
  });
});
