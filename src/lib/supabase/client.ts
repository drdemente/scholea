/**
 * The one Supabase client for the app, or `null` when this build has no backend
 * configured. Importing this module never throws: a missing or unusable setting
 * simply leaves the app in its guest-only form.
 *
 * Email flows use typed one-time codes, never links, so the client must not
 * look for a session in the URL. Realtime is not used: never call
 * `supabase.channel()`.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseConfig, type SupabaseConfig } from "./config";
import { withDeadline, type DeadlineOptions } from "./deadline";

export { isSupabaseConfigured } from "./config";

/** localStorage key that holds the Supabase session. App code never reads its value. */
export const AUTH_STORAGE_KEY = "scholea.auth";

export interface ClientOptions {
  /** Replaces the platform's own `fetch` (tests, or a native HTTP layer). */
  fetch?: typeof fetch;
  /** How long a request may wait in silence. Tests pass short times. */
  deadline?: DeadlineOptions;
}

/** The platform's `fetch`, looked up at each call so it is never captured before it exists. */
const platformFetch: typeof fetch = (input, init) => fetch(input, init);

/**
 * Build a client for the given settings; `null` when there are none or they are
 * unusable. Every request the client makes (sign-in, data, Edge Functions)
 * goes through `withDeadline`, so none of them can wait for ever.
 */
export function buildSupabaseClient(config: SupabaseConfig | null, options: ClientOptions = {}): SupabaseClient | null {
  if (!config) return null;
  try {
    return createClient(config.url, config.key, {
      auth: {
        storageKey: AUTH_STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
      global: { fetch: withDeadline(options.fetch ?? platformFetch, options.deadline) },
    });
  } catch {
    return null;
  }
}

/** Storage key of the short-lived client that ends a session on the server. It never touches the device. */
const REVOKE_STORAGE_KEY = "scholea.auth.revoke";

/**
 * Ask the backend to end a session that this device has already forgotten.
 * `stored` is that session exactly as the client kept it under
 * `AUTH_STORAGE_KEY`. It is handed to a client of its own, which holds it in
 * memory only: that client does what signing out normally does (refreshes the
 * token if it has run out, then ends the session on the server), without ever
 * writing to the device and without being able to touch whoever signs in
 * next. Best effort: it rejects when the backend cannot be reached or refuses.
 */
export async function revokeStoredSession(config: SupabaseConfig | null, stored: string, options: ClientOptions = {}): Promise<void> {
  if (!config) return;
  const memory = new Map<string, string>([[REVOKE_STORAGE_KEY, stored]]);
  const client = createClient(config.url, config.key, {
    auth: {
      storageKey: REVOKE_STORAGE_KEY,
      storage: {
        getItem: (key) => memory.get(key) ?? null,
        setItem: (key, value) => void memory.set(key, value),
        removeItem: (key) => void memory.delete(key),
      },
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: withDeadline(options.fetch ?? platformFetch, options.deadline) },
  });
  try {
    const { error } = await client.auth.signOut({ scope: "local" });
    if (error) throw error;
  } finally {
    await client.auth.dispose?.();
  }
}

export const supabase: SupabaseClient | null = buildSupabaseClient(supabaseConfig);
