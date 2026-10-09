import { describe, expect, it } from "vitest";
import { AuthApiError, AuthRetryableFetchError, PostgrestError } from "@supabase/supabase-js";
import { AUTH_STORAGE_KEY } from "@/lib/supabase/client";
import { SyncError } from "@/lib/supabase/errors";
import type { AuthSessionLike } from "./session-logic";
import {
  ACCOUNT_KEY,
  ACCOUNT_RPC,
  CODE_INTENT_KEY,
  PROFILE_RECHECK_MS,
  createSessionStore,
  type IdentityPort,
  type SessionClient,
  type StorageLike,
} from "./session-store";

// A hand-written stand-in for the backend client: plain objects and closures,
// with every call recorded. No module mocking.

const ADA = { id: "user-ada", email: "ada@example.test" };

// Nothing here reaches a backend, but no fixed password is kept in the repo
// either: these are made up afresh on every run.
const makePassword = () => `pw-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
const PASSWORD = makePassword();
const OLD_PASSWORD = makePassword();
const NEW_PASSWORD = makePassword();
const WRONG_PASSWORD = makePassword();
const TOKEN = "access-token-that-must-never-be-stored";

function sessionFor(user: { id: string; email: string }, name = "Ada Lovelace"): AuthSessionLike & { access_token: string } {
  return { access_token: TOKEN, user: { id: user.id, email: user.email, created_at: "2026-01-02T03:04:05Z", user_metadata: { name } } };
}

function profileRow(over: Record<string, unknown> = {}) {
  return {
    id: ADA.id,
    email: ADA.email,
    name: "Ada Lovelace",
    institution: "",
    role: "researcher",
    status: "active",
    must_set_password: false,
    created_at: "2026-01-02T03:04:05+00:00",
    ...over,
  };
}

function memoryStorage(seed: Record<string, string> = {}): StorageLike & { dump(): Record<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

type Listener = (event: string, session: AuthSessionLike | null) => void;

function setup(options: { storage?: Record<string, string>; configured?: boolean } = {}) {
  const storage = memoryStorage(options.storage);
  const calls: Array<{ name: string; args?: unknown }> = [];
  const queue: Array<() => void> = [];
  let listener: Listener | null = null;

  // What the pretend backend will answer. Tests change these.
  const backend = {
    session: (storage.getItem(AUTH_STORAGE_KEY) ? sessionFor(ADA) : null) as AuthSessionLike | null,
    signInError: null as unknown,
    signUpSession: null as AuthSessionLike | null,
    verifyError: null as unknown,
    updateUserError: null as unknown,
    signOutThrows: false,
    profile: { data: profileRow() as unknown, error: null as unknown, status: 200 },
    rpcError: null as unknown,
    /** Why the client could not say whether there is a session (it could not refresh it). */
    sessionError: null as unknown,
    /** While set, the account record is not answered. */
    profileHold: null as Promise<void> | null,
    /** While set, a code that was accepted is not answered: the session is stored, the call has not returned. */
    verifyHold: null as Promise<void> | null,
    /** While set, the client has not finished signing out. */
    signOutHold: null as Promise<void> | null,
  };
  /** Stored sessions that were handed over to be ended on the server. */
  const revoked: string[] = [];

  /** Become signed in, the way the real client does: store the session, then tell listeners. */
  const adopt = (session: AuthSessionLike, event = "SIGNED_IN") => {
    backend.session = session;
    storage.setItem(AUTH_STORAGE_KEY, "opaque-session-blob");
    listener?.(event, session);
  };

  const client: SessionClient = {
    auth: {
      onAuthStateChange(callback) {
        calls.push({ name: "onAuthStateChange" });
        listener = callback;
        return { data: { subscription: { unsubscribe() {} } } };
      },
      async getSession() {
        calls.push({ name: "getSession" });
        return { data: { session: backend.session }, error: backend.sessionError };
      },
      async signInWithPassword(credentials) {
        calls.push({ name: "signInWithPassword", args: credentials });
        if (backend.signInError) return { data: { session: null }, error: backend.signInError };
        const session = sessionFor(ADA);
        adopt(session);
        return { data: { session }, error: null };
      },
      async signUp(credentials) {
        calls.push({ name: "signUp", args: credentials });
        if (backend.signUpSession) adopt(backend.signUpSession);
        return { data: { session: backend.signUpSession }, error: null };
      },
      async verifyOtp(params) {
        calls.push({ name: "verifyOtp", args: params });
        if (backend.verifyError) return { data: { session: null }, error: backend.verifyError };
        const session = sessionFor(ADA);
        adopt(session, params.type === "recovery" ? "PASSWORD_RECOVERY" : "SIGNED_IN");
        await backend.verifyHold;
        return { data: { session }, error: null };
      },
      async resend(params) {
        calls.push({ name: "resend", args: params });
        return { data: {}, error: null };
      },
      async resetPasswordForEmail(...args: unknown[]) {
        calls.push({ name: "resetPasswordForEmail", args });
        return { data: {}, error: null };
      },
      async updateUser(attributes) {
        calls.push({ name: "updateUser", args: attributes });
        if (backend.updateUserError) return { data: null, error: backend.updateUserError };
        if (backend.session) listener?.("USER_UPDATED", backend.session);
        return { data: {}, error: null };
      },
      async signOut(signOutOptions) {
        calls.push({ name: "signOut", args: signOutOptions });
        await backend.signOutHold;
        if (backend.signOutThrows) throw new AuthRetryableFetchError("Failed to fetch", 0);
        backend.session = null;
        storage.removeItem(AUTH_STORAGE_KEY);
        listener?.("SIGNED_OUT", null);
        return { error: null };
      },
    },
    async rpc(fn, args) {
      calls.push({ name: `rpc:${fn}`, args });
      // The caller's own account record. It takes no arguments: the backend
      // answers for whoever the token belongs to.
      if (fn === ACCOUNT_RPC) {
        await backend.profileHold;
        return backend.profile;
      }
      return backend.rpcError ? { data: null, error: backend.rpcError, status: 403 } : { data: { user: {} }, error: null, status: 200 };
    },
  };

  const identityState = { name: "", resets: 0 };
  const identity: IdentityPort = {
    getName: () => identityState.name,
    setName: (name) => void (identityState.name = name),
    reset: () => {
      identityState.name = "";
      identityState.resets += 1;
    },
  };

  const clock = { now: 1_800_000_000_000 };
  const store = createSessionStore({
    client: options.configured === false ? null : client,
    storage,
    identity,
    defer: (run) => void queue.push(run),
    now: () => clock.now,
    revoke: async (stored) => void revoked.push(stored),
  });

  /** Let pending promises finish. */
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  /** Run what the auth callback put off, then let the resulting work finish. */
  const flush = async () => {
    await settle();
    while (queue.length > 0) {
      queue.shift()!();
      await settle();
    }
  };

  return {
    store,
    state: () => store.getState(),
    storage,
    calls,
    names: () => calls.map((c) => c.name),
    count: (name: string) => calls.filter((c) => c.name === name).length,
    queue,
    backend,
    revoked,
    clock,
    identityState,
    flush,
    emit: (event: string, session: AuthSessionLike | null) => (listener as Listener | null)?.(event, session),
  };
}

/** A device that is already signed in: stored session plus the cached record. */
function signedInDevice() {
  const record = {
    v: 1,
    profile: {
      id: ADA.id,
      email: ADA.email,
      name: "Ada Lovelace",
      institution: "",
      role: "researcher",
      status: "active",
      mustSetPassword: false,
      createdAt: 1,
    },
    deviceAccount: { id: ADA.id, email: ADA.email, name: "Ada Lovelace" },
    notice: null,
    passwordPending: false,
  };
  return setup({ storage: { [AUTH_STORAGE_KEY]: "opaque-session-blob", [ACCOUNT_KEY]: JSON.stringify(record) } });
}

async function rejection(promise: Promise<unknown>): Promise<SyncError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(SyncError);
    return e as SyncError;
  }
  throw new Error("expected the action to throw");
}

describe("session store: a build with no backend", () => {
  it("reports unconfigured and refuses every action without throwing at creation", async () => {
    const t = setup({ configured: false });
    expect(t.state().phase).toBe("unconfigured");
    t.state().init();
    expect((await rejection(t.state().signIn(ADA.email, PASSWORD))).code).toBe("not_configured");
    expect((await rejection(t.state().signUp({ name: "A", email: ADA.email, password: PASSWORD }))).code).toBe("not_configured");
    await expect(t.state().signOut()).resolves.toBeUndefined();
    expect(t.calls).toEqual([]);
  });
});

describe("session store: start-up", () => {
  it("starts anon on a fresh device and makes no request", () => {
    const t = setup();
    expect(t.state().phase).toBe("anon");
    expect(t.calls).toEqual([]);
  });

  it("starts ready from the cached record with no request (an offline launch is instant)", () => {
    const t = signedInDevice();
    expect(t.state().phase).toBe("ready");
    expect(t.state().profileSource).toBe("cache");
    expect(t.state().profile?.email).toBe(ADA.email);
    expect(t.calls).toEqual([]);
  });

  it("stays ready when the client reports no session at start-up (offline, expired token)", async () => {
    const t = signedInDevice();
    t.state().init();
    t.emit("INITIAL_SESSION", null);
    await t.flush();
    expect(t.state().phase).toBe("ready");
    expect(t.state().profileSource).toBe("cache");
  });

  it("confirms the cached profile with the backend once the client reports the session", async () => {
    const t = signedInDevice();
    t.backend.profile.data = profileRow({ role: "admin" });
    t.state().init();
    t.emit("INITIAL_SESSION", sessionFor(ADA));
    await t.flush();
    expect(t.state().profileSource).toBe("server");
    expect(t.state().profile?.role).toBe("admin");
  });

  it("init is safe to call twice", () => {
    const t = setup();
    t.state().init();
    t.state().init();
    expect(t.count("onAuthStateChange")).toBe(1);
  });

  it("fills a blank identity from the cached account, but leaves a chosen name alone", () => {
    const blank = signedInDevice();
    blank.state().init();
    expect(blank.identityState.name).toBe("Ada Lovelace");

    const named = signedInDevice();
    named.identityState.name = "A. Lovelace (lab)";
    named.state().init();
    expect(named.identityState.name).toBe("A. Lovelace (lab)");
  });
});

describe("session store: the auth callback", () => {
  it("defers its work and never calls or awaits the client inside the callback", async () => {
    const t = setup();
    t.state().init();
    const before = t.calls.length;

    t.backend.session = sessionFor(ADA);
    t.storage.setItem(AUTH_STORAGE_KEY, "opaque-session-blob");
    const returned = t.emit("SIGNED_IN", sessionFor(ADA));

    // Synchronously after the callback: nothing returned to await, no client
    // call made, no state change yet. The work is only queued.
    expect(returned).toBeUndefined();
    expect(t.calls.length).toBe(before);
    expect(t.state().phase).toBe("anon");
    expect(t.queue.length).toBe(1);

    await t.flush();
    expect(t.state().phase).toBe("ready");
    expect(t.state().profileSource).toBe("server");
    expect(t.names()).toContain("rpc:my_account");
  });

  it("treats PASSWORD_RECOVERY and TOKEN_REFRESHED as signed in", async () => {
    for (const event of ["PASSWORD_RECOVERY", "TOKEN_REFRESHED"]) {
      const t = setup();
      t.state().init();
      t.backend.session = sessionFor(ADA);
      t.storage.setItem(AUTH_STORAGE_KEY, "opaque-session-blob");
      t.emit(event, sessionFor(ADA));
      await t.flush();
      expect(t.state().phase).toBe("ready");
    }
  });

  it("re-checks the profile on a token refresh, which is how a suspension is noticed", async () => {
    const t = signedInDevice();
    t.state().init();
    t.backend.profile.data = profileRow({ status: "suspended" });
    t.emit("TOKEN_REFRESHED", sessionFor(ADA));
    await t.flush();
    expect(t.state().phase).toBe("anon");
    expect(t.state().notice).toBe("suspended");
  });

  it("does not re-read a profile confirmed moments ago when the event repeats (window focus)", async () => {
    const t = setup();
    t.state().init();
    await t.state().signIn(ADA.email, PASSWORD);
    await t.flush();
    expect(t.count("rpc:my_account")).toBe(1);

    t.emit("SIGNED_IN", sessionFor(ADA));
    t.emit("SIGNED_IN", sessionFor(ADA));
    await t.flush();
    expect(t.count("rpc:my_account")).toBe(1);

    // A minute later the same event checks again.
    t.clock.now += PROFILE_RECHECK_MS;
    t.emit("TOKEN_REFRESHED", sessionFor(ADA));
    await t.flush();
    expect(t.count("rpc:my_account")).toBe(2);
  });

  it("an involuntary sign-out keeps the device account and explains", async () => {
    const t = signedInDevice();
    t.state().init();
    t.storage.removeItem(AUTH_STORAGE_KEY);
    t.emit("SIGNED_OUT", null);
    await t.flush();
    expect(t.state().phase).toBe("anon");
    expect(t.state().notice).toBe("expired");
    expect(t.state().deviceAccount?.id).toBe(ADA.id);
    expect(JSON.parse(t.storage.getItem(ACCOUNT_KEY)!)).toMatchObject({ profile: null, deviceAccount: { id: ADA.id }, notice: "expired" });
  });

  it("a sign-out seen after the device record vanished is voluntary (another window signed out)", async () => {
    const t = signedInDevice();
    t.state().init();
    t.storage.removeItem(ACCOUNT_KEY);
    t.storage.removeItem(AUTH_STORAGE_KEY);
    t.emit("SIGNED_OUT", null);
    await t.flush();
    expect(t.state().phase).toBe("anon");
    expect(t.state().deviceAccount).toBeNull();
    expect(t.state().notice).toBeNull();
  });

  it("ignores a late signed-in event for a session that is already gone", async () => {
    const t = signedInDevice();
    t.state().init();
    t.emit("TOKEN_REFRESHED", sessionFor(ADA)); // queued, not yet handled
    await t.state().signOut();
    await t.flush();
    expect(t.state().phase).toBe("anon");
    expect(t.state().profile).toBeNull();
  });
});

describe("session store: sign in", () => {
  it("maps wrong credentials to invalid_credentials and stays signed out", async () => {
    const t = setup();
    t.state().init();
    t.backend.signInError = new AuthApiError("Invalid login credentials", 400, "invalid_credentials");
    const e = await rejection(t.state().signIn(ADA.email, WRONG_PASSWORD));
    expect([e.code, e.status]).toEqual(["invalid_credentials", 400]);
    expect(t.state().phase).toBe("anon");
    expect(t.storage.getItem(ACCOUNT_KEY)).toBeNull();
  });

  it("maps an unreachable backend to network", async () => {
    const t = setup();
    t.backend.signInError = new AuthRetryableFetchError("Failed to fetch", 0);
    expect((await rejection(t.state().signIn(ADA.email, PASSWORD))).code).toMatch(/^(network|offline)$/);
  });

  it("is ready with the server profile by the time it resolves, having asked for the caller's own account record", async () => {
    const t = setup();
    t.state().init();
    await t.state().signIn(ADA.email, PASSWORD);
    expect(t.state().phase).toBe("ready");
    expect(t.state().profileSource).toBe("server");
    expect(t.state().deviceAccount).toEqual({ id: ADA.id, email: ADA.email, name: "Ada Lovelace" });
    // No argument names an account: there is nobody else to ask about.
    const read = t.calls.find((c) => c.name === "rpc:my_account")!;
    expect(read.args).toBeUndefined();
    await t.flush();
    expect(t.state().phase).toBe("ready");
  });

  it("shares one profile read between the action and the event it causes", async () => {
    const t = setup();
    t.state().init();
    await t.state().signIn(ADA.email, PASSWORD);
    expect(t.count("rpc:my_account")).toBe(1);
  });

  it("seeds the local identity with the account name", async () => {
    const t = setup();
    t.identityState.name = "Somebody Else";
    await t.state().signIn(ADA.email, PASSWORD);
    expect(t.identityState.name).toBe("Ada Lovelace");
    expect(t.identityState.resets).toBe(1); // a different account than before: start clean
  });

  it("keeps the device record free of the access token", async () => {
    const t = setup();
    await t.state().signIn(ADA.email, PASSWORD);
    const record = t.storage.getItem(ACCOUNT_KEY)!;
    expect(JSON.parse(record)).toMatchObject({ v: 1, profile: { id: ADA.id } });
    expect(record).not.toContain(TOKEN);
    expect(Object.values(t.storage.dump()).join("\n")).not.toContain(TOKEN);
  });

  it("a suspended profile signs out locally with the notice", async () => {
    const t = setup();
    t.state().init();
    t.backend.profile.data = profileRow({ status: "suspended" });
    const e = await rejection(t.state().signIn(ADA.email, PASSWORD));
    expect([e.code, e.status]).toEqual(["account_suspended", 403]);
    await t.flush();
    expect(t.state().phase).toBe("anon");
    expect(t.state().profile).toBeNull();
    expect(t.state().notice).toBe("suspended");
    expect(t.state().deviceAccount?.id).toBe(ADA.id);
    expect(t.calls.find((c) => c.name === "signOut")?.args).toEqual({ scope: "local" });
    expect(t.storage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it("a missing profile row signs out locally as removed", async () => {
    const t = setup();
    t.backend.profile.data = null;
    expect((await rejection(t.state().signIn(ADA.email, PASSWORD))).code).toBe("unauthenticated");
    expect(t.state().notice).toBe("removed");
    expect(t.state().phase).toBe("anon");
  });

  it("does not conclude 'removed' from a read made without a live session", async () => {
    const t = signedInDevice();
    t.state().init();
    t.backend.session = null; // offline with an expired token
    t.backend.profile.data = null;
    t.emit("TOKEN_REFRESHED", sessionFor(ADA));
    await t.flush();
    expect(t.state().phase).toBe("ready");
    expect(t.count("rpc:my_account")).toBe(0);
  });

  it("stays signed in on the provisional profile when the profile read fails", async () => {
    const t = setup();
    t.backend.profile = { data: null, error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" }, status: 0 };
    await t.state().signIn(ADA.email, PASSWORD);
    expect(t.state().phase).toBe("ready");
    expect(t.state().profileSource).toBe("cache");
    expect(t.state().profile?.role).toBe("researcher");
  });
});

describe("session store: sign out", () => {
  it("always uses scope local and clears everything local", async () => {
    const t = signedInDevice();
    t.state().init();
    t.identityState.name = "Ada Lovelace";
    await t.state().signOut();
    await t.flush();
    expect(t.calls.filter((c) => c.name === "signOut").map((c) => c.args)).toEqual([{ scope: "local" }]);
    expect(t.state()).toMatchObject({ phase: "anon", profile: null, profileSource: null, deviceAccount: null, notice: null });
    expect(t.storage.getItem(ACCOUNT_KEY)).toBeNull();
    expect(t.storage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(t.identityState.name).toBe("");
  });

  it("clears local state even when the client rejects (backend unreachable)", async () => {
    const t = signedInDevice();
    t.state().init();
    t.backend.signOutThrows = true;
    await expect(t.state().signOut()).resolves.toBeUndefined();
    expect(t.state()).toMatchObject({ phase: "anon", profile: null, deviceAccount: null, notice: null });
    expect(t.storage.getItem(ACCOUNT_KEY)).toBeNull();
    expect(t.storage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(t.calls.find((c) => c.name === "signOut")?.args).toEqual({ scope: "local" });
  });

  it("the sign-out event it causes is not mistaken for an expired session", async () => {
    const t = signedInDevice();
    t.state().init();
    await t.state().signOut();
    await t.flush();
    expect(t.state().notice).toBeNull();
    expect(t.state().deviceAccount).toBeNull();
  });

  it("forgetDeviceAccount and dismissNotice act on an involuntary sign-out", async () => {
    const t = signedInDevice();
    t.state().init();
    t.storage.removeItem(AUTH_STORAGE_KEY);
    t.emit("SIGNED_OUT", null);
    await t.flush();

    t.state().dismissNotice();
    expect(t.state().notice).toBeNull();
    expect(t.state().deviceAccount?.id).toBe(ADA.id);

    t.state().forgetDeviceAccount();
    expect(t.state().deviceAccount).toBeNull();
    expect(t.storage.getItem(ACCOUNT_KEY)).toBeNull();
  });
});

describe("session store: sign up and codes", () => {
  it("signUp asks for a code, sends the name as metadata and no redirect", async () => {
    const t = setup();
    const result = await t.state().signUp({ name: "Ada Lovelace", email: ADA.email, password: PASSWORD });
    expect(result).toBe("confirm");
    expect(t.state().phase).toBe("anon");
    expect(t.calls[0]).toEqual({
      name: "signUp",
      args: { email: ADA.email, password: PASSWORD, options: { data: { name: "Ada Lovelace" } } },
    });
  });

  it("signUp is signed in at once when the server needs no confirmation", async () => {
    const t = setup();
    t.backend.signUpSession = sessionFor(ADA);
    expect(await t.state().signUp({ name: "Ada Lovelace", email: ADA.email, password: PASSWORD })).toBe("signedIn");
    expect(t.state().phase).toBe("ready");
  });

  it("confirmSignUp verifies an email code and flags the password as not yet confirmed", async () => {
    const t = setup();
    await t.state().confirmSignUp(ADA.email, "12345678");
    expect(t.calls[0]).toEqual({ name: "verifyOtp", args: { email: ADA.email, token: "12345678", type: "email" } });
    expect(t.state().phase).toBe("ready");
    expect(t.state().passwordPending).toBe(true);
    expect(JSON.parse(t.storage.getItem(ACCOUNT_KEY)!).passwordPending).toBe(true);
  });

  it("a wrong or expired code maps to code_invalid", async () => {
    const t = setup();
    t.backend.verifyError = new AuthApiError("Token has expired or is invalid", 403, "otp_expired");
    const e = await rejection(t.state().confirmSignUp(ADA.email, "00000000"));
    expect([e.code, e.status]).toEqual(["code_invalid", 403]);
    expect(t.state().phase).toBe("anon");
  });

  it("resend and password reset send only what they must", async () => {
    const t = setup();
    await t.state().resendSignUpCode(ADA.email);
    await t.state().requestPasswordReset(ADA.email);
    expect(t.calls).toEqual([
      { name: "resend", args: { type: "signup", email: ADA.email } },
      { name: "resetPasswordForEmail", args: [ADA.email] }, // no redirect address
    ]);
  });

  it("verifyEmailCode uses the given kind and signs in", async () => {
    for (const kind of ["recovery", "invite"] as const) {
      const t = setup();
      t.state().init();
      await t.state().verifyEmailCode(ADA.email, "12345678", kind);
      expect(t.calls.find((c) => c.name === "verifyOtp")?.args).toEqual({ email: ADA.email, token: "12345678", type: kind });
      expect(t.state().phase).toBe("ready");
    }
  });
});

describe("session store: passwords", () => {
  async function confirmed() {
    const t = setup();
    t.state().init();
    await t.state().confirmSignUp(ADA.email, "12345678");
    return t;
  }

  it("securePassword writes the typed password as both new and current", async () => {
    const t = await confirmed();
    await t.state().securePassword(PASSWORD);
    expect(t.calls.find((c) => c.name === "updateUser")?.args).toEqual({
      password: PASSWORD,
      current_password: PASSWORD,
    });
    expect(t.state().passwordPending).toBe(false);
  });

  it("securePassword treats same_password as success", async () => {
    const t = await confirmed();
    t.backend.updateUserError = new AuthApiError("New password should be different", 422, "same_password");
    await expect(t.state().securePassword(PASSWORD)).resolves.toBeUndefined();
    expect(t.state().passwordPending).toBe(false);
  });

  it("securePassword reports a current-password mismatch and leaves the flag set", async () => {
    const t = await confirmed();
    t.backend.updateUserError = new AuthApiError("Current password is wrong", 400, "current_password_mismatch");
    const e = await rejection(t.state().securePassword(PASSWORD));
    expect(e.code).toBe("invalid_credentials");
    expect(t.state().passwordPending).toBe(true);
  });

  it("the flag survives a restart until a password is settled", async () => {
    const first = await confirmed();
    const second = setup({ storage: first.storage.dump() });
    expect(second.state().phase).toBe("ready");
    expect(second.state().passwordPending).toBe(true);
  });

  it("setPassword sends only the new password, clears the flag and reloads the profile", async () => {
    const t = setup();
    t.state().init();
    t.backend.profile.data = profileRow({ must_set_password: true });
    await t.state().verifyEmailCode(ADA.email, "12345678", "invite");
    expect(t.state().profile?.mustSetPassword).toBe(true);

    t.backend.profile.data = profileRow({ must_set_password: false });
    await t.state().setPassword(PASSWORD);
    expect(t.calls.find((c) => c.name === "updateUser")?.args).toEqual({ password: PASSWORD });
    expect(t.state().profile?.mustSetPassword).toBe(false);
  });

  it("setPassword surfaces same_password (a reset must choose a different one)", async () => {
    const t = setup();
    await t.state().verifyEmailCode(ADA.email, "12345678", "recovery");
    t.backend.updateUserError = new AuthApiError("New password should be different", 422, "same_password");
    expect((await rejection(t.state().setPassword(PASSWORD))).code).toBe("same_password");
  });

  it("changePassword proves the current password by signing in before it changes anything", async () => {
    const t = signedInDevice();
    t.state().init();
    await t.state().changePassword(OLD_PASSWORD, NEW_PASSWORD);
    const names = t.names().filter((n) => n === "signInWithPassword" || n === "updateUser");
    expect(names).toEqual(["signInWithPassword", "updateUser"]);
    expect(t.calls.find((c) => c.name === "signInWithPassword")?.args).toEqual({ email: ADA.email, password: OLD_PASSWORD });
    expect(t.calls.find((c) => c.name === "updateUser")?.args).toEqual({
      password: NEW_PASSWORD,
      current_password: OLD_PASSWORD,
    });
  });

  it("changePassword stops at a wrong current password", async () => {
    const t = signedInDevice();
    t.state().init();
    t.backend.signInError = new AuthApiError("Invalid login credentials", 400, "invalid_credentials");
    expect((await rejection(t.state().changePassword(WRONG_PASSWORD, NEW_PASSWORD))).code).toBe("invalid_credentials");
    expect(t.count("updateUser")).toBe(0);
    expect(t.state().phase).toBe("ready");
  });

  it("changePassword needs a signed-in session", async () => {
    const t = setup();
    expect((await rejection(t.state().changePassword(OLD_PASSWORD, NEW_PASSWORD))).code).toBe("unauthenticated");
    expect(t.calls).toEqual([]);
  });
});

describe("session store: the password a code leaves owed", () => {
  it("says the password is owed in the same write that adopts a sign-up code's session, before the profile is read", async () => {
    const t = setup();
    t.state().init();
    let release = () => {};
    t.backend.profileHold = new Promise<void>((resolve) => (release = resolve));

    const confirming = t.state().confirmSignUp(ADA.email, "12345678");
    await t.flush();
    // The code was accepted and the account record is slow to arrive. The person reloads, or quits.
    expect(t.storage.getItem(AUTH_STORAGE_KEY)).not.toBeNull();
    expect(JSON.parse(t.storage.getItem(ACCOUNT_KEY)!).passwordPending).toBe(true);
    const relaunched = setup({ storage: t.storage.dump() });
    expect(relaunched.state()).toMatchObject({ phase: "ready", passwordPending: true });

    release();
    await confirming;
    expect(t.state().passwordPending).toBe(true);
  });

  it("still knows the password is owed when the app closed the moment the code was accepted", async () => {
    const t = setup();
    t.state().init();
    // The client has stored the session. Its answer has not come back, and
    // nothing the store does after it has run yet.
    t.backend.verifyHold = new Promise<void>(() => {});
    void t.state().confirmSignUp(ADA.email, "12345678");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.storage.getItem(AUTH_STORAGE_KEY)).not.toBeNull();
    expect(t.storage.getItem(ACCOUNT_KEY)).toBeNull();

    const relaunched = setup({ storage: t.storage.dump() });
    relaunched.state().init();
    relaunched.emit("INITIAL_SESSION", sessionFor(ADA));
    await relaunched.flush();
    expect(relaunched.state()).toMatchObject({ phase: "ready", passwordPending: true });
    expect(JSON.parse(relaunched.storage.getItem(ACCOUNT_KEY)!).passwordPending).toBe(true);
    // Said once, in the record that lasts. The note that a code was being checked is gone.
    expect(relaunched.storage.getItem(CODE_INTENT_KEY)).toBeNull();
  });

  it("a note about a code for another address says nothing about this session", async () => {
    const t = setup({ storage: { [AUTH_STORAGE_KEY]: "opaque-session-blob", [CODE_INTENT_KEY]: JSON.stringify({ v: 1, email: "someone-else@example.test" }) } });
    t.state().init();
    t.emit("INITIAL_SESSION", sessionFor(ADA));
    await t.flush();
    expect(t.state()).toMatchObject({ phase: "ready", passwordPending: false });
  });

  it("a recovery or an invitation code leaves the password owed until one is saved", async () => {
    for (const kind of ["recovery", "invite"] as const) {
      const t = setup();
      t.state().init();
      await t.state().verifyEmailCode(ADA.email, "12345678", kind);
      expect(t.state().passwordPending).toBe(true);
      expect(JSON.parse(t.storage.getItem(ACCOUNT_KEY)!).passwordPending).toBe(true);

      // The save fails, and the app is closed: the next launch still knows.
      t.backend.updateUserError = new AuthRetryableFetchError("Failed to fetch", 0);
      await rejection(t.state().setPassword(PASSWORD));
      expect(setup({ storage: t.storage.dump() }).state().passwordPending).toBe(true);

      t.backend.updateUserError = null;
      await t.state().setPassword(PASSWORD);
      expect(t.state().passwordPending).toBe(false);
      expect(JSON.parse(t.storage.getItem(ACCOUNT_KEY)!).passwordPending).toBe(false);
    }
  });

  it("a password the account already has is settled, though another one is still asked for", async () => {
    const t = setup();
    await t.state().verifyEmailCode(ADA.email, "12345678", "recovery");
    t.backend.updateUserError = new AuthApiError("New password should be different", 422, "same_password");
    expect((await rejection(t.state().setPassword(PASSWORD))).code).toBe("same_password");
    // It is the one this person typed, so nobody else's password is on the account.
    expect(t.state().passwordPending).toBe(false);
  });

  it("a code that is refused leaves nothing behind", async () => {
    const t = setup();
    t.backend.verifyError = new AuthApiError("Token has expired or is invalid", 403, "otp_expired");
    await rejection(t.state().confirmSignUp(ADA.email, "00000000"));
    await rejection(t.state().verifyEmailCode(ADA.email, "00000000", "recovery"));
    expect(t.storage.dump()).toEqual({});
  });

  it("signing in with the password settles it, and drops a note left by a code that never finished", async () => {
    const t = setup({ storage: { [CODE_INTENT_KEY]: JSON.stringify({ v: 1, email: ADA.email }) } });
    t.state().init();
    await t.state().signIn(ADA.email, PASSWORD);
    await t.flush();
    expect(t.state()).toMatchObject({ phase: "ready", passwordPending: false });
    expect(t.storage.getItem(CODE_INTENT_KEY)).toBeNull();
  });
});

describe("session store: signing out at once", () => {
  it("takes the session off the device before the client has answered, and does not wait for it", async () => {
    const t = signedInDevice();
    t.state().init();
    let release = () => {};
    t.backend.signOutHold = new Promise<void>((resolve) => (release = resolve));

    const done = t.state().signOut();
    // Synchronously: closing the app now cannot sign the person back in.
    expect(t.storage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(t.storage.getItem(ACCOUNT_KEY)).toBeNull();
    expect(t.state().phase).toBe("anon");
    await done;

    release();
    await t.flush();
    expect(t.storage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(t.state()).toMatchObject({ phase: "anon", deviceAccount: null, notice: null });
  });

  it("hands the stored session over, unopened, to be ended on the server", async () => {
    const t = signedInDevice();
    t.state().init();
    await t.state().signOut();
    expect(t.revoked).toEqual(["opaque-session-blob"]);

    // Nothing stored: nothing to end.
    const guest = setup();
    await guest.state().signOut();
    expect(guest.revoked).toEqual([]);
  });

  it("a sign-in started while the client is still finishing a sign-out waits for it, and is not undone by it", async () => {
    const t = signedInDevice();
    t.state().init();
    let release = () => {};
    t.backend.signOutHold = new Promise<void>((resolve) => (release = resolve));
    await t.state().signOut();

    const signingIn = t.state().signIn(ADA.email, PASSWORD);
    await t.flush();
    // Not sent yet: the client's sign-out removes whatever session it finds when it gets to it.
    expect(t.count("signInWithPassword")).toBe(0);

    release();
    await signingIn;
    await t.flush();
    expect(t.state()).toMatchObject({ phase: "ready", notice: null });
    expect(t.storage.getItem(AUTH_STORAGE_KEY)).not.toBeNull();
  });

  it("removes a session that a refresh in flight writes back during the sign-out", async () => {
    const t = signedInDevice();
    t.state().init();
    let release = () => {};
    t.backend.signOutHold = new Promise<void>((resolve) => (release = resolve));
    await t.state().signOut();

    // The client finishes a token refresh that was already on its way.
    t.storage.setItem(AUTH_STORAGE_KEY, "refreshed-session-blob");
    t.emit("TOKEN_REFRESHED", sessionFor(ADA));
    await t.flush();
    expect(t.storage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(t.state().phase).toBe("anon");

    release();
    await t.flush();
    expect(t.state().phase).toBe("anon");
  });
});

describe("session store: the profile", () => {
  it("updateMyProfile calls update_my_profile with only the given fields, then reloads", async () => {
    const t = signedInDevice();
    t.state().init();
    t.backend.profile.data = profileRow({ name: "Ada King" });
    await t.state().updateMyProfile({ name: "Ada King" });
    expect(t.calls.find((c) => c.name === "rpc:update_my_profile")?.args).toEqual({ p_name: "Ada King" });
    expect(t.state().profile?.name).toBe("Ada King");
    expect(t.state().profileSource).toBe("server");
    expect(t.identityState.name).toBe("Ada King");
  });

  it("updateMyProfile maps the backend's custom error by code and status", async () => {
    const t = signedInDevice();
    // A code with no built-in status, so the 403 can only come from the reply itself.
    t.backend.rpcError = new PostgrestError({ code: "forbidden_role", message: "forbidden_role", details: "", hint: "" });
    const e = await rejection(t.state().updateMyProfile({ name: "Ada King" }));
    expect([e.code, e.status]).toEqual(["forbidden_role", 403]);
  });

  it("refreshProfile returns the fresh profile", async () => {
    const t = signedInDevice();
    t.backend.profile.data = profileRow({ role: "master_admin" });
    const profile = await t.state().refreshProfile();
    expect(profile?.role).toBe("master_admin");
    expect(t.state().profileSource).toBe("server");
  });

  it("refreshProfile throws when the backend cannot be reached, and keeps the cached profile", async () => {
    const t = signedInDevice();
    t.backend.profile = { data: null, error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" }, status: 0 };
    const e = await rejection(t.state().refreshProfile());
    expect(e.code).toMatch(/^(network|offline)$/);
    expect(t.state().phase).toBe("ready");
    expect(t.state().profileSource).toBe("cache");
  });

  it("refreshProfile reports a connection problem, not an ended session, when the session could not be refreshed for lack of one", async () => {
    const t = signedInDevice();
    // Offline with an expired token: the client could not refresh it, and says why.
    t.backend.session = null;
    t.backend.sessionError = new AuthRetryableFetchError("Failed to fetch", 0);
    const e = await rejection(t.state().refreshProfile());
    expect(e.code).toMatch(/^(network|offline)$/);
    expect(t.state().phase).toBe("ready");
    expect(t.count("rpc:my_account")).toBe(0);

    // No session and no such reason: that really is an ended session.
    t.backend.sessionError = null;
    expect((await rejection(t.state().refreshProfile())).code).toBe("unauthenticated");
  });

  it("refreshProfile resolves null when nobody is signed in or the account turned out to be blocked", async () => {
    const guest = setup();
    expect(await guest.state().refreshProfile()).toBeNull();

    const t = signedInDevice();
    t.backend.profile.data = profileRow({ status: "suspended" });
    expect(await t.state().refreshProfile()).toBeNull();
    expect(t.state().notice).toBe("suspended");
  });
});
