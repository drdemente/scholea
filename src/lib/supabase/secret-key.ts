/**
 * Recognises a Supabase key that must never reach a client: a secret key
 * (`sb_secret_...`) or a legacy JWT key whose role is `service_role`. Either
 * one grants full access to the project.
 *
 * Two places use it. The app refuses such a key when it reads its settings
 * (`config.ts`), and the build stops when it is given one (`vite.config.ts`),
 * because the bundler would otherwise write the key into the built files.
 * This module imports nothing, so both can load it.
 */

/** Secret keys carry this prefix. */
const SECRET_KEY_PREFIX = "sb_secret_";

/** True for a legacy JWT key whose role is `service_role` (the old secret key). */
function isServiceRoleJwt(key: string): boolean {
  const parts = key.split(".");
  if (parts.length !== 3) return false;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="))) as { role?: unknown };
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

/** True for a secret key of either kind. Space around the value is ignored. */
export function isSecretKey(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const key = value.trim();
  return key.startsWith(SECRET_KEY_PREFIX) || isServiceRoleJwt(key);
}

/**
 * The names of the `VITE_*` settings that hold a secret key, in alphabetical
 * order. The bundler copies the value of every `VITE_*` setting the code reads
 * into the JavaScript it writes, so none of them may ever hold one.
 */
export function secretKeySettings(env: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(env)
    .filter((name) => name.startsWith("VITE_") && isSecretKey(env[name]))
    .sort();
}

/** What a build says when it stops. It names the settings and never repeats a value. */
export function secretKeyRefusal(names: readonly string[]): string {
  const subject = names.length === 1 ? `${names[0]} holds` : `${names.join(" and ")} each hold`;
  return (
    `${subject} a Supabase secret key (sb_secret_... or a service_role key). ` +
    "The build would publish it inside the app's files, so nothing was built. " +
    "Use the publishable key (sb_publishable_...) instead. " +
    "If a build made with this key was ever shared or deployed, replace the key in the Supabase dashboard."
  );
}
