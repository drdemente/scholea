import { describe, expect, it } from "vitest";
import { SyncError } from "@/lib/supabase/errors";
import { createEmailProof, emailConfirmedFrom, type EmailProofClient } from "./email-proof";

const EMAIL = "ada@example.test";

function setup(over: { profile?: unknown; profileError?: unknown; otpError?: unknown; verifyError?: unknown; throwing?: boolean } = {}) {
  const calls: Array<[string, unknown]> = [];
  const client: EmailProofClient = {
    auth: {
      async signInWithOtp(credentials) {
        calls.push(["signInWithOtp", credentials]);
        if (over.throwing) throw new TypeError("Failed to fetch");
        return { error: over.otpError ?? null };
      },
      async verifyOtp(params) {
        calls.push(["verifyOtp", params]);
        return { error: over.verifyError ?? null };
      },
    },
  };
  const proof = createEmailProof({
    client,
    call: async <T>(fn: string) => {
      calls.push(["rpc", fn]);
      if (over.profileError) throw over.profileError;
      return over.profile as T;
    },
  });
  return { proof, calls };
}

async function rejection(promise: Promise<unknown>): Promise<SyncError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(SyncError);
    return e as SyncError;
  }
  throw new Error("expected a rejection");
}

describe("emailConfirmedFrom", () => {
  it("reads the flag from the caller's profile", () => {
    expect(emailConfirmedFrom({ user: { emailConfirmed: true } })).toBe(true);
    expect(emailConfirmedFrom({ user: { emailConfirmed: false } })).toBe(false);
  });

  it("answers null for anything else", () => {
    for (const data of [null, undefined, "x", {}, { user: null }, { user: {} }, { user: { emailConfirmed: "yes" } }]) {
      expect(emailConfirmedFrom(data)).toBeNull();
    }
  });
});

describe("email proof", () => {
  it("asks the backend whether the address is proven", async () => {
    const proven = setup({ profile: { user: { emailConfirmed: true } } });
    expect(await proven.proof.isConfirmed()).toBe(true);
    expect(proven.calls).toEqual([["rpc", "my_profile"]]);
    expect(await setup({ profile: { user: { emailConfirmed: false } } }).proof.isConfirmed()).toBe(false);
  });

  it("cannot tell when the backend cannot be asked", async () => {
    expect(await setup({ profileError: new SyncError(0, "offline") }).proof.isConfirmed()).toBeNull();
    expect(await setup({ profileError: new SyncError(401, "unauthenticated") }).proof.isConfirmed()).toBeNull();
  });

  it("sends a code to the address without ever creating an account", async () => {
    const t = setup();
    await t.proof.sendCode(EMAIL);
    expect(t.calls).toEqual([["signInWithOtp", { email: EMAIL, options: { shouldCreateUser: false } }]]);
  });

  it("checks the code as an email code", async () => {
    const t = setup();
    await t.proof.verify(EMAIL, "12345678");
    expect(t.calls).toEqual([["verifyOtp", { email: EMAIL, token: "12345678", type: "email" }]]);
  });

  it("maps what the backend refuses", async () => {
    const limited = { name: "AuthApiError", __isAuthError: true, status: 429, code: "over_email_send_rate_limit" };
    expect((await rejection(setup({ otpError: limited }).proof.sendCode(EMAIL))).code).toBe("email_rate_limited");
    const wrong = { name: "AuthApiError", __isAuthError: true, status: 403, code: "otp_expired" };
    expect((await rejection(setup({ verifyError: wrong }).proof.verify(EMAIL, "00000000"))).code).toBe("code_invalid");
    expect((await rejection(setup({ throwing: true }).proof.sendCode(EMAIL))).status).toBe(0);
  });

  it("refuses everything in a build with no backend, and says it cannot tell", async () => {
    const proof = createEmailProof({
      client: null,
      call: async () => {
        throw new SyncError(0, "not_configured");
      },
    });
    expect(await proof.isConfirmed()).toBeNull();
    expect((await rejection(proof.sendCode(EMAIL))).code).toBe("not_configured");
    expect((await rejection(proof.verify(EMAIL, "12345678"))).code).toBe("not_configured");
  });
});
