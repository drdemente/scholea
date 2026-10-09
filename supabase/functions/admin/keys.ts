/**
 * The project keys the platform hands to every Edge Function. Nothing is set
 * by hand (`supabase secrets set` is never needed) and no key is in the
 * repository.
 *
 * The platform and the local stack provide the current keys as JSON objects of
 * named keys, `SUPABASE_PUBLISHABLE_KEYS` and `SUPABASE_SECRET_KEYS`, for
 * example `{"default":"sb_secret_..."}`. A self-hosted stack may provide the
 * single-key form instead. Projects that predate the current keys provide only
 * the legacy `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`. Each is tried
 * in that order.
 *
 * This module imports nothing, so it can be tested without a backend.
 */

export interface PlatformKeys {
  /** Sent as `apikey` with the caller's own token. Not a credential. */
  publishable: string | null;
  /** Reaches the Auth admin API. Never leaves the function. */
  secret: string | null;
}

/** The `default` key of a JSON object of named keys, else its first key. */
function named(value: string | undefined): string | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const keys = parsed as Record<string, unknown>;
  const preferred = Object.hasOwn(keys, "default") ? keys.default : undefined;
  if (typeof preferred === "string" && preferred !== "") return preferred;
  for (const key of Object.values(keys)) {
    if (typeof key === "string" && key !== "") return key;
  }
  return null;
}

function single(value: string | undefined): string | null {
  return value ? value : null;
}

/** `get` reads one environment variable (`Deno.env.get` in the function). */
export function platformKeys(get: (name: string) => string | undefined): PlatformKeys {
  return {
    publishable: named(get("SUPABASE_PUBLISHABLE_KEYS")) ??
      single(get("SUPABASE_PUBLISHABLE_KEY")) ??
      single(get("SUPABASE_ANON_KEY")),
    secret: named(get("SUPABASE_SECRET_KEYS")) ??
      single(get("SUPABASE_SECRET_KEY")) ??
      single(get("SUPABASE_SERVICE_ROLE_KEY")),
  };
}
