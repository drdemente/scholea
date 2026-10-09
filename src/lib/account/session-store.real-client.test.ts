import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AUTH_STORAGE_KEY, buildSupabaseClient, revokeStoredSession } from "@/lib/supabase/client";
import { SyncError } from "@/lib/supabase/errors";
import { ACCOUNT_KEY, createSessionStore, sessionClientOf } from "./session-store";

// The store driven through the real Supabase client. Only the network is
// replaced, by a hand-written fetch that answers the way the Auth and data
// services do. This pins the library behaviour the store depends on (request
// shapes, error bodies, events, where the session is kept) without a backend.

const BASE = "https://scholea.example.test";
const KEY = "sb_publishable_example";
const USER = { id: "0b4c5e0e-1111-4222-8333-444444444444", email: "ada@example.test" };

// Nothing here reaches a backend, but no fixed password is kept in the repo
// either: these are made up afresh on every run.
const makePassword = () => `pw-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
const PASSWORD = makePassword();
const NEW_PASSWORD = makePassword();
const WRONG_PASSWORD = makePassword();

function jwt(payload: object): string {
  const part = (v: object) => btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(payload)}.signature`;
}

function tokenResponse(user = USER, sessionId = "session-1", lifetime = 3600) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: jwt({ sub: user.id, role: "authenticated", session_id: sessionId, exp: now + lifetime }),
    token_type: "bearer",
    expires_in: lifetime,
    expires_at: now + lifetime,
    refresh_token: `refresh-token-of-${sessionId}`,
    user: {
      id: user.id,
      aud: "authenticated",
      email: user.email,
      created_at: "2026-01-02T03:04:05Z",
      app_metadata: {},
      user_metadata: { name: "Ada Lovelace" },
    },
  };
}

const profileRow = (over: object = {}) => ({
  id: USER.id,
  email: USER.email,
  name: "Ada Lovelace",
  institution: "",
  role: "researcher",
  status: "active",
  must_set_password: false,
  created_at: "2026-01-02T03:04:05+00:00",
  ...over,
});

interface Reply {
  status: number;
  body: unknown;
}

/** Every client a test built, so it can be shut down afterwards. */
const clients: SupabaseClient[] = [];

function setup(options: { revoke?: (stored: string) => Promise<void> } = {}) {
  const requests: Array<{ method: string; path: string; query: URLSearchParams; body: Record<string, unknown> | null; bearer: string | null }> = [];
  const net = {
    offline: false,
    /** While set, the request to end a session on the server is not answered. When it resolves, the request fails. */
    logoutHold: null as Promise<void> | null,
    token: { status: 200, body: tokenResponse() } as Reply,
    verify: { status: 200, body: tokenResponse() } as Reply,
    user: { status: 200, body: tokenResponse().user } as Reply,
    account: { status: 200, body: profileRow() } as Reply,
    rpc: { status: 200, body: { user: {} } } as Reply,
  };
  const reply = ({ status, body }: Reply) =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
    });

  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = request.method === "GET" ? "" : await request.text();
    requests.push({
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
      bearer: request.headers.get("authorization"),
    });
    if (net.offline) throw new TypeError("Failed to fetch");
    switch (url.pathname) {
      case "/auth/v1/token":
        return reply(net.token);
      case "/auth/v1/verify":
        return reply(net.verify);
      case "/auth/v1/user":
        return reply(net.user);
      case "/auth/v1/logout":
        if (net.logoutHold) {
          await net.logoutHold;
          throw new TypeError("Failed to fetch");
        }
        return reply({ status: 204, body: null });
      case "/rest/v1/rpc/my_account":
        return reply(net.account);
      case "/rest/v1/rpc/update_my_profile":
        return reply(net.rpc);
      default:
        return reply({ status: 404, body: { message: "no such route" } });
    }
  };

  const client = buildSupabaseClient({ url: BASE, key: KEY }, { fetch: fakeFetch })!;
  clients.push(client);
  const store = createSessionStore({
    client: sessionClientOf(client),
    storage: localStorage,
    // As the app wires it: a client of its own ends the forgotten session on the server.
    revoke: options.revoke ?? ((stored) => revokeStoredSession({ url: BASE, key: KEY }, stored, { fetch: fakeFetch })),
  });
  store.getState().init();
  /** Let the client's deferred events and the work they start finish. */
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  /** Wait for something the client does in its own time, without guessing how long. */
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 500 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(done()).toBe(true);
  };
  return {
    store,
    state: () => store.getState(),
    requests,
    net,
    settle,
    until,
    last: (path: string) => requests.filter((r) => r.path === path).at(-1),
  };
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

describe("session store with the real client", () => {
  // Each test builds its own client on the one storage key, which the library
  // remarks on. That remark is expected here and only adds noise.
  const realWarn = console.warn;
  beforeAll(() => {
    console.warn = (...args: unknown[]) => {
      if (!String(args[0]).includes("Multiple GoTrueClient instances")) realWarn(...args);
    };
  });
  afterAll(() => {
    console.warn = realWarn;
  });
  afterEach(async () => {
    // Clients on one storage key talk to each other like browser windows do.
    // Shut each one down so a test cannot reach into the next.
    for (const client of clients.splice(0)) await client.auth.dispose();
    localStorage.clear();
  });

  it("signs in with a password and asks for the caller's own account record with the user's token", async () => {
    const t = setup();
    await t.state().signIn(USER.email, PASSWORD);
    await t.settle();

    expect(t.state().phase).toBe("ready");
    expect(t.state().profileSource).toBe("server");
    expect(t.state().profile).toMatchObject({ id: USER.id, role: "researcher", createdAt: Date.parse("2026-01-02T03:04:05+00:00") });

    const grant = t.last("/auth/v1/token")!;
    expect(grant.method).toBe("POST");
    expect(grant.query.get("grant_type")).toBe("password");
    expect(grant.body).toMatchObject({ email: USER.email, password: PASSWORD });

    // A function call, never a table read: the backend lets no client read a table.
    const read = t.last("/rest/v1/rpc/my_account")!;
    expect(read.method).toBe("POST");
    // Nothing in the request names an account. The token alone says whose record it is.
    expect(read.body ?? {}).toEqual({});
    expect([...read.query.keys()]).toEqual([]);
    // The signed-in user's token, not the public key.
    expect(read.bearer).toBe(`Bearer ${(t.net.token.body as { access_token: string }).access_token}`);
    // One read is enough: the event the sign-in causes does not repeat it.
    expect(t.requests.filter((r) => r.path === "/rest/v1/rpc/my_account")).toHaveLength(1);
    expect(t.requests.some((r) => r.path === "/rest/v1/profiles")).toBe(false);
  });

  it("keeps the session under scholea.auth and never copies a token into its own record", async () => {
    const t = setup();
    await t.state().signIn(USER.email, PASSWORD);
    await t.settle();
    expect(Object.keys(localStorage).sort()).toEqual([ACCOUNT_KEY, AUTH_STORAGE_KEY].sort());
    const record = localStorage.getItem(ACCOUNT_KEY)!;
    expect(record).not.toContain("refresh-token-value");
    expect(record).not.toContain((t.net.token.body as { access_token: string }).access_token);
  });

  it("maps the Auth service's error body by its code", async () => {
    const t = setup();
    t.net.token = { status: 400, body: { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" } };
    const wrong = await rejection(t.state().signIn(USER.email, WRONG_PASSWORD));
    expect([wrong.code, wrong.status]).toEqual(["invalid_credentials", 400]);
    expect(t.state().phase).toBe("anon");

    t.net.verify = { status: 403, body: { code: 403, error_code: "otp_expired", msg: "Token has expired or is invalid" } };
    const expired = await rejection(t.state().confirmSignUp(USER.email, "00000000"));
    expect([expired.code, expired.status]).toEqual(["code_invalid", 403]);
  });

  it("maps an unreachable backend to a connectivity error", async () => {
    const t = setup();
    t.net.offline = true;
    const e = await rejection(t.state().signIn(USER.email, PASSWORD));
    expect(e.code).toMatch(/^(network|offline)$/);
    expect(e.status).toBe(0);
  });

  it("confirms a sign-up code, then secures the typed password (same_password counts as done)", async () => {
    const t = setup();
    await t.state().confirmSignUp(USER.email, "12345678");
    expect(t.last("/auth/v1/verify")!.body).toMatchObject({ email: USER.email, token: "12345678", type: "email" });
    expect(t.state().phase).toBe("ready");
    expect(t.state().passwordPending).toBe(true);

    t.net.user = { status: 422, body: { code: 422, error_code: "same_password", msg: "New password should be different from the old password." } };
    await t.state().securePassword(PASSWORD);
    const update = t.last("/auth/v1/user")!;
    expect(update.method).toBe("PUT");
    expect(update.body).toMatchObject({ password: PASSWORD, current_password: PASSWORD });
    expect(t.state().passwordPending).toBe(false);
  });

  it("a recovery code signs in (PASSWORD_RECOVERY) and the new password is then set", async () => {
    const t = setup();
    await t.state().verifyEmailCode(USER.email, "12345678", "recovery");
    await t.settle();
    expect(t.last("/auth/v1/verify")!.body).toMatchObject({ type: "recovery" });
    expect(t.state().phase).toBe("ready");

    await t.state().setPassword(NEW_PASSWORD);
    expect(t.last("/auth/v1/user")!.body).toMatchObject({ password: NEW_PASSWORD });
    expect(t.last("/auth/v1/user")!.body).not.toHaveProperty("current_password");
  });

  it("maps the backend's custom RPC error: code from the body, status from the reply", async () => {
    const t = setup();
    await t.state().signIn(USER.email, PASSWORD);
    // What private.fail('password_reset_required', 403) produces through PostgREST.
    t.net.rpc = { status: 403, body: { code: "password_reset_required", message: "password_reset_required", details: null, hint: null } };
    const e = await rejection(t.state().updateMyProfile({ name: "Ada King" }));
    expect([e.code, e.status]).toEqual(["password_reset_required", 403]);
    expect(t.last("/rest/v1/rpc/update_my_profile")!.body).toEqual({ p_name: "Ada King" });
  });

  it("a suspended profile ends the session on this device with the notice", async () => {
    const t = setup();
    t.net.account = { status: 200, body: profileRow({ status: "suspended" }) };
    const e = await rejection(t.state().signIn(USER.email, PASSWORD));
    expect(e.code).toBe("account_suspended");
    await t.until(() => localStorage.getItem(AUTH_STORAGE_KEY) === null);
    await t.until(() => t.last("/auth/v1/logout") !== undefined);
    await t.settle();
    expect(t.state()).toMatchObject({ phase: "anon", notice: "suspended", deviceAccount: { id: USER.id } });
    expect(t.last("/auth/v1/logout")!.query.get("scope")).toBe("local");
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it("signs out this device only, and still does when the backend is unreachable", async () => {
    const t = setup();
    await t.state().signIn(USER.email, PASSWORD);
    await t.settle();

    t.net.offline = true;
    await t.state().signOut();
    await t.until(() => t.last("/auth/v1/logout") !== undefined);
    await t.settle();

    expect(t.last("/auth/v1/logout")!.query.get("scope")).toBe("local");
    expect(t.state()).toMatchObject({ phase: "anon", profile: null, deviceAccount: null, notice: null });
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY)).toBeNull();
  });

  it("takes the session off the device the moment the person signs out, and ends it on the server afterwards", async () => {
    const t = setup();
    await t.state().signIn(USER.email, PASSWORD);
    await t.settle();
    const token = (t.net.token.body as { access_token: string }).access_token;

    void t.state().signOut();
    // At once, with nothing waited for: closing the app now cannot sign the person back in.
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY)).toBeNull();
    expect(t.state().phase).toBe("anon");

    // The server is told with the token of the session that was signed out, for this device only.
    await t.until(() => t.last("/auth/v1/logout") !== undefined);
    expect(t.last("/auth/v1/logout")).toMatchObject({ method: "POST", bearer: `Bearer ${token}` });
    expect(t.last("/auth/v1/logout")!.query.get("scope")).toBe("local");
    await t.settle();
    // Nothing of it came back to the device.
    expect(Object.keys(localStorage)).toEqual([]);
  });

  it("stays signed out after a relaunch when the app closed while the session had run out and the backend was out of reach", async () => {
    const first = setup();
    await first.state().signIn(USER.email, PASSWORD);
    await first.settle();
    for (const client of clients.splice(0)) await client.auth.dispose();

    // An hour offline later the stored token has run out. Signing out can reach nobody.
    const stored = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY)!) as { expires_at: number };
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ ...stored, expires_at: Math.floor(Date.now() / 1000) - 60 }));
    const second = setup({ revoke: async () => {} });
    second.net.offline = true;
    expect(second.state().phase).toBe("ready");
    void second.state().signOut();
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();

    // The app is closed now, and opened again with the connection back.
    for (const client of clients.splice(0)) await client.auth.dispose();
    const third = setup();
    await third.settle();
    expect(third.state()).toMatchObject({ phase: "anon", profile: null, deviceAccount: null });
    expect(third.requests).toHaveLength(0);
  });

  it("a sign-out that stalls on the server does not end the session of whoever signs in next", async () => {
    const t = setup();
    await t.state().signIn(USER.email, PASSWORD);
    await t.settle();

    // The request that ends the old session on the server gets no answer.
    let fail = () => {};
    t.net.logoutHold = new Promise<void>((resolve) => (fail = resolve));
    await t.state().signOut();
    await t.until(() => t.last("/auth/v1/logout") !== undefined);

    // Somebody else signs in on this device meanwhile.
    const other = { id: "0b4c5e0e-5555-4666-8777-888888888888", email: "bob@example.test" };
    t.net.token = { status: 200, body: tokenResponse(other, "session-2") };
    t.net.account = { status: 200, body: profileRow({ id: other.id, email: other.email, name: "Bob" }) };
    await t.state().signIn(other.email, PASSWORD);
    await t.settle();
    expect(t.state()).toMatchObject({ phase: "ready", profile: { id: other.id } });
    const session = localStorage.getItem(AUTH_STORAGE_KEY);
    expect(session).toContain("refresh-token-of-session-2");

    // The stalled request finally fails.
    fail();
    await t.settle();
    expect(t.state()).toMatchObject({ phase: "ready", profile: { id: other.id }, notice: null });
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBe(session);
    // And the next person's requests still carry their own token.
    await t.state().refreshProfile();
    expect(t.last("/rest/v1/rpc/my_account")!.bearer).toBe(`Bearer ${(t.net.token.body as { access_token: string }).access_token}`);
  });

  it("a relaunch with a stored session starts ready from the cache, then confirms with the backend", async () => {
    const first = setup();
    await first.state().signIn(USER.email, PASSWORD);
    await first.settle();

    // Same device, next launch: a new client and a new store over the same storage.
    const second = setup();
    second.net.account = { status: 200, body: profileRow({ role: "admin" }) };
    expect(second.state().phase).toBe("ready");
    expect(second.state().profileSource).toBe("cache");
    expect(second.requests).toHaveLength(0);

    await second.until(() => second.state().profileSource === "server");
    expect(second.state().profile?.role).toBe("admin");
  });
});
