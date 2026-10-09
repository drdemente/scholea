/**
 * Proving that the signed-in account's email address is the person's own.
 *
 * An address the person chose themselves is proven when they sign up. One that
 * an administrator set is not: until the person types a code sent to it, the
 * backend shows them no project invitations for that address. This is the
 * small flow that sends such a code and checks it.
 *
 * Every call throws `SyncError`, except `isConfirmed`, which answers `null`
 * when it cannot tell.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { callRpc, type RpcCaller } from "@/lib/collab/sync";
import { supabase } from "@/lib/supabase/client";
import { notConfiguredError, toSyncError } from "@/lib/supabase/errors";

/** A narrow view of the backend client, so tests can pass a plain hand-written object. */
export interface EmailProofClient {
  auth: {
    signInWithOtp(credentials: { email: string; options: { shouldCreateUser: boolean } }): Promise<{ error: unknown }>;
    verifyOtp(params: { email: string; token: string; type: "email" }): Promise<{ error: unknown }>;
  };
}

export interface EmailProofDeps {
  /** The backend client, or `null` in a build with no backend. */
  client: EmailProofClient | null;
  /** Calls a backend function as the signed-in person. */
  call: RpcCaller;
}

/** Reads `emailConfirmed` out of what `my_profile()` returns. `null` when it is not there. */
export function emailConfirmedFrom(data: unknown): boolean | null {
  if (typeof data !== "object" || data === null) return null;
  const user = (data as { user?: unknown }).user;
  if (typeof user !== "object" || user === null) return null;
  const value = (user as { emailConfirmed?: unknown }).emailConfirmed;
  return typeof value === "boolean" ? value : null;
}

export function createEmailProof(deps: EmailProofDeps) {
  const requireClient = (): EmailProofClient => {
    if (!deps.client) throw notConfiguredError();
    return deps.client;
  };

  async function auth(run: () => Promise<{ error: unknown }>): Promise<void> {
    let result: { error: unknown };
    try {
      result = await run();
    } catch (e) {
      throw toSyncError(e);
    }
    if (result.error) throw toSyncError(result.error);
  }

  return {
    /**
     * Whether the signed-in account's address is proven. `null` when that
     * cannot be told right now (offline, signed out, no backend): show nothing then.
     */
    async isConfirmed(): Promise<boolean | null> {
      try {
        return emailConfirmedFrom(await deps.call("my_profile"));
      } catch {
        return null;
      }
    },

    /** Email a code to the account's own address. Never creates an account. */
    async sendCode(email: string): Promise<void> {
      const client = requireClient();
      await auth(() => client.auth.signInWithOtp({ email, options: { shouldCreateUser: false } }));
    },

    /** Check the code. The backend then counts the address as proven. */
    async verify(email: string, code: string): Promise<void> {
      const client = requireClient();
      await auth(() => client.auth.verifyOtp({ email, token: code, type: "email" }));
    },
  };
}

export type EmailProof = ReturnType<typeof createEmailProof>;

/** The real client seen through the narrow view above. */
export function emailProofClientOf(c: SupabaseClient | null): EmailProofClient | null {
  if (!c) return null;
  return {
    auth: {
      signInWithOtp: (credentials) => c.auth.signInWithOtp(credentials),
      verifyOtp: (params) => c.auth.verifyOtp(params),
    },
  };
}

export const emailProof: EmailProof = createEmailProof({ client: emailProofClientOf(supabase), call: callRpc });
