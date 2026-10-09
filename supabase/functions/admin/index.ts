/**
 * Scholea Edge Function "admin".
 *
 * The account actions that only the Supabase Auth admin API can do: send an
 * invitation, change an email address, ban and unban, soft delete. Called by
 * an administration client as `supabase.functions.invoke('admin', { body })` with
 * `body = { action, surface?: 'admin' | 'master', ... }`. The actions are in
 * actions.ts; revoking sessions is a plain database function and is not here.
 *
 * What this function may and may not do:
 * - It learns who is calling only from the verified sign-in token. No id, role
 *   or email in the body says anything about the caller.
 * - It never decides who may do what. The first step of every action is a
 *   database function called with the CALLER'S token, and the database decides.
 * - The secret key is used for the Auth admin API and for nothing else. It is
 *   never used to read or write the database: its role has no grants there.
 * - It never returns a token, a link, a password or a key.
 *
 * Failures are JSON `{ error: <code>, message? }` with a real HTTP status.
 *
 * The platform checks the request before this code runs (`verify_jwt = true`
 * in supabase/config.toml) and turns away one that carries no credentials. It
 * lets a bare API key through, though, and every visitor has the publishable
 * key. So the token is verified again here, and an API key is not accepted in
 * its place.
 *
 * Nothing is configured by hand. The platform provides SUPABASE_URL, the
 * project keys (see keys.ts) and the signing keys used to verify tokens.
 */
import { verifyAuth } from "@supabase/server/core";
import { createClient } from "@supabase/supabase-js";
import type { AuthAdmin, Deps, Rpc } from "./actions.ts";
import { AuthStepError, fromRpc, HttpError } from "./errors.ts";
import { createHandler } from "./handler.ts";
import { platformKeys } from "./keys.ts";

/** One client per request, nothing remembered between requests. */
const STATELESS = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;

/** Auth takes a duration, not "forever". A hundred years, lifted by "none". */
const BAN_DURATION = "876000h";

/**
 * The caller's sign-in token, verified against the project's signing keys.
 * An API key in place of a user's token is refused here: it identifies the
 * app, not a person.
 */
async function verify(req: Request): Promise<string> {
  const { data, error } = await verifyAuth(req, { auth: "user" });
  if (data?.token) return data.token;
  if (error && error.status >= 500) {
    // The function itself cannot verify tokens (no signing keys). Not the caller's fault.
    console.error(`admin: cannot verify sign-in tokens (${error.code})`);
    throw new HttpError(500, "server_error");
  }
  throw new HttpError(401, "unauthenticated");
}

/** Keep the status and code of an Auth failure and drop its text, which can name an address. */
function authFailure(error: unknown): AuthStepError {
  const e = (typeof error === "object" && error !== null ? error : {}) as { status?: unknown; code?: unknown };
  return new AuthStepError(typeof e.status === "number" ? e.status : 0, typeof e.code === "string" ? e.code : "");
}

/** Run one Auth admin call; any failure leaves as an `AuthStepError`. */
async function authCall<R extends { error: unknown }>(call: () => Promise<R>): Promise<R> {
  let result: R;
  try {
    result = await call();
  } catch (e) {
    throw authFailure(e);
  }
  if (result.error) throw authFailure(result.error);
  return result;
}

function connect(token: string): Deps {
  const url = Deno.env.get("SUPABASE_URL");
  const keys = platformKeys((name) => Deno.env.get(name));
  if (!url || !keys.publishable || !keys.secret) {
    console.error("admin: the platform did not provide SUPABASE_URL and the project keys");
    throw new HttpError(500, "server_error");
  }

  // The caller's own identity: the publishable key plus the caller's token.
  // Every database call goes through this client.
  const caller = createClient(url, keys.publishable, {
    auth: STATELESS,
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  // The secret key. Only its Auth admin API leaves this function's scope.
  const admin = createClient(url, keys.secret, { auth: STATELESS }).auth.admin;

  const rpc: Rpc = async (name, args) => {
    const { data, error, status } = await caller.rpc(name, args);
    if (error) throw fromRpc(error, status);
    return data;
  };

  const auth: AuthAdmin = {
    async invite(email, data) {
      const options = data && Object.keys(data).length > 0 ? { data } : {};
      const { data: out } = await authCall(() => admin.inviteUserByEmail(email, options));
      if (!out.user?.id) throw new AuthStepError(0, "");
      return { id: out.user.id };
    },
    async setEmail(userId, email) {
      // Without email_confirm: an invited account stays unconfirmed, so it can
      // still be sent its code, and nothing here vouches for the new address.
      // The database treats it as unproven until its holder types a code.
      await authCall(() => admin.updateUserById(userId, { email }));
    },
    async setBanned(userId, banned) {
      await authCall(() => admin.updateUserById(userId, { ban_duration: banned ? BAN_DURATION : "none" }));
    },
    async softDelete(userId) {
      await authCall(() => admin.deleteUser(userId, true));
    },
  };

  return { rpc, auth };
}

Deno.serve(createHandler({ verify, connect }));
