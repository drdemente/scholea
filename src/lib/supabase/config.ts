/**
 * Reads the build-time settings for the optional account backend (Supabase).
 *
 * The account is optional: a build with no settings is the guest-only app, with
 * no account UI and no backend requests. CI and forks build exactly that way, and
 * a missing GitHub variable expands to an empty string, so an empty or
 * whitespace-only value counts as unset. Anything unusable also yields `null`,
 * so a bad value can never stop the offline app from starting.
 *
 * Both values are public by design (they ship inside every build). A secret key
 * must never be put in a `VITE_*` variable, and one is refused here. Refusing it
 * here does not take its text out of the built files, so the build itself also
 * stops when it is given one (`vite.config.ts`).
 */
import { isSecretKey } from "./secret-key";

export interface SupabaseConfig {
  /** Project URL, with no trailing slash. */
  url: string;
  /** Publishable key (or a legacy anon key). */
  key: string;
}

/** The slice of `import.meta.env` this module reads. */
export interface SupabaseEnv {
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  VITE_SUPABASE_ANON_KEY?: string;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The backend address and public key, or `null` when the build is not configured
 * (absent, empty, not an http(s) URL, or a secret key).
 */
export function readSupabaseConfig(env: SupabaseEnv | null | undefined): SupabaseConfig | null {
  const rawUrl = clean(env?.VITE_SUPABASE_URL);
  // The publishable key wins; the legacy anon name is only a fallback.
  const key = clean(env?.VITE_SUPABASE_PUBLISHABLE_KEY) || clean(env?.VITE_SUPABASE_ANON_KEY);
  if (!rawUrl || !key) return null;
  if (/\s/.test(key)) return null;
  // A secret key grants full access and is never for clients.
  if (isSecretKey(key)) return null;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;

  return { url: rawUrl.replace(/\/+$/, ""), key };
}

/**
 * This build's settings. Each variable is named in full so the bundler inlines
 * just these three values and nothing else from the environment.
 */
export const supabaseConfig: SupabaseConfig | null = readSupabaseConfig({
  VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
  VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
});

/** True when this build was given a usable backend address and public key. */
export const isSupabaseConfigured: boolean = supabaseConfig !== null;
