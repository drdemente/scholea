/**
 * The "admin" function without a backend: its request handling, the order of
 * the steps inside each action, and its error mapping.
 *
 * The database and the Auth admin API are replaced by hand-written stand-ins
 * that record what they were asked. The one property that matters most is
 * checked for every action: when the database refuses, the Auth admin API is
 * not touched at all.
 *
 * The same actions run against the real stack in admin.e2e.test.ts.
 */
import { assert, assertEquals } from "@std/assert";
import { type AuthAdmin, type Deps, findAction } from "../admin/actions.ts";
import { AuthStepError, fromAuth, fromRpc, HttpError, INVALID_ADDRESS } from "../admin/errors.ts";
import { CORS_HEADERS, createHandler } from "../admin/handler.ts";
import { platformKeys } from "../admin/keys.ts";

// The function logs every failed Auth step and every crash. Here they are expected.
const realConsoleError = console.error;
Deno.test.beforeAll(() => {
  console.error = () => {};
});
Deno.test.afterAll(() => {
  console.error = realConsoleError;
});

const USER_ID = "0b4c5e0e-1111-4222-8333-444444444444";
const INVITED_ID = "9f1b7c2a-5555-4666-8777-888888888888";

type Call = [string, ...unknown[]];

/** Stand-ins for the two connections, with a log of every call in order. */
function fakes(answers: Record<string, unknown | (() => unknown)> = {}, authFails: Record<string, AuthStepError> = {}) {
  const calls: Call[] = [];
  const rpc: Deps["rpc"] = (name, args) => {
    calls.push([`rpc ${name}`, args]);
    const answer = answers[name];
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(typeof answer === "function" ? (answer as () => unknown)() : answer);
  };
  const step = (name: string, args: unknown[], result?: unknown) => {
    calls.push([`auth ${name}`, ...args]);
    return authFails[name] ? Promise.reject(authFails[name]) : Promise.resolve(result);
  };
  const auth: AuthAdmin = {
    invite: (email, data) => step("invite", [email, data], { id: INVITED_ID }) as Promise<{ id: string }>,
    setEmail: (id, email) => step("setEmail", [id, email]) as Promise<void>,
    setBanned: (id, banned) => step("setBanned", [id, banned]) as Promise<void>,
    softDelete: (id) => step("softDelete", [id]) as Promise<void>,
  };
  return { deps: { rpc, auth }, calls, names: () => calls.map((c) => c[0]) };
}

async function run(action: string, body: Record<string, unknown>, f: ReturnType<typeof fakes>) {
  try {
    return await findAction(action)!(f.deps, { action, ...body });
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { error: e.code } };
    throw e;
  }
}

const pendingUser = { id: INVITED_ID, email: "new@example.test", role: "supervisor", mustResetPassword: true };

// --- The actions ----------------------------------------------------------------

const BODIES: Record<string, Record<string, unknown>> = {
  invite_user: { email: "new@example.test", role: "researcher" },
  resend_invite: { userId: USER_ID },
  update_email: { userId: USER_ID, email: "moved@example.test" },
  suspend_user: { userId: USER_ID },
  activate_user: { userId: USER_ID },
  delete_user: { userId: USER_ID },
};

Deno.test("there are exactly six actions", () => {
  for (const name of Object.keys(BODIES)) assert(findAction(name), name);
  for (const name of ["revoke_sessions", "constructor", "__proto__", "toString", "", 7, null, undefined, {}]) {
    assertEquals(findAction(name), undefined);
  }
});

Deno.test("when the database refuses, the Auth admin API is never called", async () => {
  const refusal = new HttpError(403, "forbidden");
  const everyFunction = {
    admin_begin_invite: refusal,
    admin_check_user_action: refusal,
    admin_begin_email_change: refusal,
    admin_set_user_status: refusal,
    admin_soft_delete_user: refusal,
  };
  for (const [action, body] of Object.entries(BODIES)) {
    const f = fakes(everyFunction);
    const reply = await run(action, body, f);
    assertEquals(reply, { status: 403, body: { error: "forbidden" } }, action);
    assertEquals(f.calls.length, 1, `${action}: one database call and nothing else`);
    assert(f.calls[0][0].startsWith("rpc "), action);
  }
});

Deno.test("the body cannot say who is calling: only the documented values reach the database", async () => {
  const f = fakes({ admin_set_user_status: { ok: true, revokedSessions: 2 } });
  await run("suspend_user", {
    userId: USER_ID,
    surface: "master",
    actorId: USER_ID,
    role: "master_admin",
    p_surface: "admin",
    p_status: "active",
  }, f);
  assertEquals(f.calls[0], ["rpc admin_set_user_status", {
    p_user_id: USER_ID,
    p_status: "suspended",
    p_surface: "master",
  }]);
});

Deno.test("values of the wrong kind go to the database as null, for it to refuse in its own order", async () => {
  const f = fakes({ admin_begin_invite: new HttpError(400, "invalid_input") });
  await run("invite_user", { email: ["a@example.test"], role: 3, name: {}, institution: null, surface: 5 }, f);
  assertEquals(f.calls[0][1], { p_email: null, p_role: null, p_name: null, p_institution: null, p_surface: null });

  const g = fakes({ admin_set_user_status: new HttpError(404, "not_found") });
  await run("suspend_user", { userId: "not-a-uuid" }, g);
  assertEquals(g.calls[0][1], { p_user_id: null, p_status: "suspended", p_surface: "admin" });
});

Deno.test("invite_user: database, then Auth with the address the database returned, then the account", async () => {
  const f = fakes({
    admin_begin_invite: { ok: true, email: "new@example.test", role: "supervisor" },
    admin_get_user: { user: pendingUser },
  });
  const reply = await run("invite_user", {
    email: "  NEW@Example.test ",
    role: "supervisor",
    name: "  Sam  ",
    institution: " ",
    data: { role: "master_admin" },
  }, f);

  assertEquals(reply, { status: 201, body: { user: pendingUser } });
  assertEquals(f.calls, [
    ["rpc admin_begin_invite", {
      p_email: "  NEW@Example.test ",
      p_role: "supervisor",
      p_name: "  Sam  ",
      p_institution: " ",
      p_surface: "admin",
    }],
    ["auth invite", "new@example.test", { name: "Sam" }],
    ["rpc admin_get_user", { p_user_id: INVITED_ID }],
  ]);
});

Deno.test("invite_user: an account that is not the one this invitation made is email_taken", async () => {
  const begin = { ok: true, email: "new@example.test", role: "supervisor" };
  for (
    const got of [
      { user: { ...pendingUser, role: "researcher" } },
      { user: { ...pendingUser, mustResetPassword: false } },
      new HttpError(404, "not_found"),
    ]
  ) {
    const f = fakes({ admin_begin_invite: begin, admin_get_user: got });
    assertEquals(await run("invite_user", BODIES.invite_user, f), { status: 409, body: { error: "email_taken" } });
  }
});

Deno.test("invite_user and resend_invite: what Auth's refusals become", async () => {
  const begin = { ok: true, email: "new@example.test", role: "researcher" };
  const cases: [AuthStepError, number, string][] = [
    [new AuthStepError(422, "email_exists"), 409, "email_taken"],
    [new AuthStepError(429, "over_email_send_rate_limit"), 429, "rate_limited"],
    [new AuthStepError(400, "email_address_invalid"), 400, "invalid_input"],
    [new AuthStepError(500, "unexpected_failure"), 502, "auth_sync_failed"],
  ];
  for (const [failure, status, error] of cases) {
    const f = fakes({ admin_begin_invite: begin }, { invite: failure });
    assertEquals(await run("invite_user", BODIES.invite_user, f), { status, body: { error } });
    assertEquals(f.names(), ["rpc admin_begin_invite", "auth invite"]);
  }

  const check = { ok: true, user: { ...pendingUser, id: USER_ID } };
  const f = fakes({ admin_check_user_action: check });
  assertEquals(await run("resend_invite", BODIES.resend_invite, f), { status: 200, body: { ok: true } });
  assertEquals(f.calls, [
    ["rpc admin_check_user_action", { p_user_id: USER_ID, p_action: "resend_invite", p_surface: "admin" }],
    ["auth invite", "new@example.test", undefined],
  ]);
  const used = fakes({ admin_check_user_action: check }, { invite: new AuthStepError(422, "email_exists") });
  assertEquals(await run("resend_invite", BODIES.resend_invite, used), { status: 409, body: { error: "not_pending" } });
});

Deno.test("update_email: Auth is asked only when the address really changes", async () => {
  const user = { id: USER_ID, email: "moved@example.test" };
  const same = fakes({
    admin_begin_email_change: { ok: true, changed: false, email: "moved@example.test", emailConfirmed: true },
    admin_get_user: { user },
  });
  assertEquals(await run("update_email", BODIES.update_email, same), { status: 200, body: { user } });
  assertEquals(same.names(), ["rpc admin_begin_email_change", "rpc admin_get_user"]);

  const changed = fakes({
    admin_begin_email_change: { ok: true, changed: true, email: "moved@example.test", emailConfirmed: true },
    admin_get_user: { user },
  });
  await run("update_email", { userId: USER_ID, email: " MOVED@example.test" }, changed);
  assertEquals(changed.calls, [
    ["rpc admin_begin_email_change", { p_user_id: USER_ID, p_new_email: " MOVED@example.test" }],
    ["auth setEmail", USER_ID, "moved@example.test"],
    ["rpc admin_get_user", { p_user_id: USER_ID }],
  ]);

  for (const failure of [new AuthStepError(500, "23505"), new AuthStepError(422, "email_exists")]) {
    const taken = fakes(
      { admin_begin_email_change: { ok: true, changed: true, email: "moved@example.test" } },
      { setEmail: failure },
    );
    assertEquals(await run("update_email", BODIES.update_email, taken), { status: 409, body: { error: "email_taken" } });
  }
});

Deno.test("suspend_user: locked out in the database first, banned second", async () => {
  const f = fakes({ admin_set_user_status: { ok: true, revokedSessions: 3 } });
  assertEquals(await run("suspend_user", BODIES.suspend_user, f), {
    status: 200,
    body: { ok: true, revokedSessions: 3 },
  });
  assertEquals(f.calls, [
    ["rpc admin_set_user_status", { p_user_id: USER_ID, p_status: "suspended", p_surface: "admin" }],
    ["auth setBanned", USER_ID, true],
  ]);

  const half = fakes({ admin_set_user_status: { ok: true, revokedSessions: 0 } }, {
    setBanned: new AuthStepError(0, ""),
  });
  assertEquals(await run("suspend_user", BODIES.suspend_user, half), { status: 502, body: { error: "auth_sync_failed" } });
});

Deno.test("activate_user: checked, unbanned, and only then active again", async () => {
  const f = fakes({ admin_check_user_action: { ok: true, user: {} }, admin_set_user_status: { ok: true } });
  assertEquals(await run("activate_user", { ...BODIES.activate_user, surface: "master" }, f), {
    status: 200,
    body: { ok: true },
  });
  assertEquals(f.calls, [
    ["rpc admin_check_user_action", { p_user_id: USER_ID, p_action: "activate", p_surface: "master" }],
    ["auth setBanned", USER_ID, false],
    ["rpc admin_set_user_status", { p_user_id: USER_ID, p_status: "active", p_surface: "master" }],
  ]);

  // The ban could not be lifted: the account must stay suspended in the database.
  const half = fakes({ admin_check_user_action: { ok: true, user: {} } }, { setBanned: new AuthStepError(500, "") });
  assertEquals(await run("activate_user", BODIES.activate_user, half), { status: 502, body: { error: "auth_sync_failed" } });
  assertEquals(half.names(), ["rpc admin_check_user_action", "auth setBanned"]);
});

Deno.test("delete_user: database first; an account Auth no longer has counts as done", async () => {
  const f = fakes({ admin_soft_delete_user: { ok: true } });
  assertEquals(await run("delete_user", BODIES.delete_user, f), { status: 200, body: { ok: true } });
  assertEquals(f.calls, [
    ["rpc admin_soft_delete_user", { p_user_id: USER_ID, p_surface: "admin" }],
    ["auth softDelete", USER_ID],
  ]);

  const gone = fakes({ admin_soft_delete_user: { ok: true } }, { softDelete: new AuthStepError(404, "user_not_found") });
  assertEquals(await run("delete_user", BODIES.delete_user, gone), { status: 200, body: { ok: true } });

  const half = fakes({ admin_soft_delete_user: { ok: true } }, { softDelete: new AuthStepError(500, "unexpected_failure") });
  assertEquals(await run("delete_user", BODIES.delete_user, half), { status: 502, body: { error: "auth_sync_failed" } });
});

Deno.test("an unexpected answer from the database is a server error, not a success", async () => {
  const f = fakes({ admin_begin_invite: "ok" });
  assertEquals(await run("invite_user", BODIES.invite_user, f), { status: 500, body: { error: "server_error" } });
  assertEquals(f.names(), ["rpc admin_begin_invite"]);
});

// --- The request handler ----------------------------------------------------------

function handlerWith(options: { verify?: () => Promise<string>; deps?: Deps } = {}) {
  const seen = { verified: 0, connected: [] as string[] };
  const handle = createHandler({
    verify: () => {
      seen.verified += 1;
      return (options.verify ?? (() => Promise.resolve("caller-token")))();
    },
    connect: (token) => {
      seen.connected.push(token);
      return options.deps ?? fakes().deps;
    },
  });
  const post = (body: string) => handle(new Request("http://local/admin", { method: "POST", body }));
  return { handle, post, seen };
}

function assertCors(res: Response) {
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(res.headers.get("Access-Control-Allow-Headers"), "authorization, x-client-info, apikey, content-type");
  assertEquals(res.headers.get("Access-Control-Allow-Credentials"), null);
}

Deno.test("handler: a preflight is answered without looking at who asks", async () => {
  const h = handlerWith();
  const res = await h.handle(new Request("http://local/admin", { method: "OPTIONS" }));
  assertEquals(res.status, 204);
  assertCors(res);
  assertEquals(h.seen.verified, 0);
  assertEquals(CORS_HEADERS["Access-Control-Allow-Origin"], "*");
});

Deno.test("handler: only POST", async () => {
  const h = handlerWith();
  const res = await h.handle(new Request("http://local/admin", { method: "GET" }));
  assertEquals(res.status, 405);
  assertEquals((await res.json()).error, "method_not_allowed");
  assertCors(res);
  assertEquals(h.seen.verified, 0);
});

Deno.test("handler: without a valid token nothing is read and nothing is connected", async () => {
  const h = handlerWith({ verify: () => Promise.reject(new HttpError(401, "unauthenticated")) });
  const res = await h.post(JSON.stringify({ action: "delete_user", userId: USER_ID }));
  assertEquals(res.status, 401);
  assertEquals(await res.json(), { error: "unauthenticated" });
  assertCors(res);
  assertEquals(h.seen.connected, []);
});

Deno.test("handler: the body must be a JSON object that names a known action", async () => {
  for (const body of ["", "{nope", "[]", '"delete_user"', "null", "{}", '{"action":"constructor"}', '{"action":["delete_user"]}']) {
    const h = handlerWith();
    const res = await h.post(body);
    assertEquals(res.status, 400, body);
    assertEquals((await res.json()).error, "invalid_input", body);
    assertEquals(h.seen.connected, [], body);
  }
});

Deno.test("handler: the action runs with the verified token and its answer is JSON with the CORS headers", async () => {
  const f = fakes({ admin_set_user_status: { ok: true, revokedSessions: 1 } });
  const h = handlerWith({ deps: f.deps });
  const res = await h.post(JSON.stringify({ action: "suspend_user", userId: USER_ID }));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Content-Type"), "application/json");
  assertCors(res);
  assertEquals(await res.json(), { ok: true, revokedSessions: 1 });
  assertEquals(h.seen.connected, ["caller-token"]);
});

Deno.test("handler: a refusal keeps its status and code; a crash says nothing about itself", async () => {
  const refused = handlerWith({ deps: fakes({ admin_soft_delete_user: new HttpError(409, "last_master_admin") }).deps });
  const res = await refused.post(JSON.stringify({ action: "delete_user", userId: USER_ID }));
  assertEquals([res.status, await res.json()], [409, { error: "last_master_admin" }]);

  const crashing: Deps = { ...fakes().deps, rpc: () => Promise.reject(new Error("secret detail at 10.0.0.5")) };
  const crashed = await handlerWith({ deps: crashing }).post(JSON.stringify({ action: "delete_user", userId: USER_ID }));
  assertEquals([crashed.status, await crashed.text()], [500, '{"error":"server_error"}']);
});

Deno.test("handler: update_email refused for an account in use leaves as 403 forbidden, and Auth is not asked", async () => {
  // What the Data API delivers when the database refuses an admin who is not a
  // master admin: private.fail('forbidden', 403, 'master_admin_required').
  const delivered = { code: "forbidden", message: "forbidden", details: "master_admin_required", hint: null };
  const f = fakes({ admin_begin_email_change: fromRpc(delivered, 403) });
  const res = await handlerWith({ deps: f.deps }).post(JSON.stringify({ action: "update_email", ...BODIES.update_email }));

  assertEquals(res.status, 403);
  assertCors(res);
  // The code and nothing else: the database's detail is not passed on.
  assertEquals(await res.json(), { error: "forbidden" });
  assertEquals(f.calls, [["rpc admin_begin_email_change", { p_user_id: USER_ID, p_new_email: "moved@example.test" }]]);
});

// --- Error mapping -----------------------------------------------------------------

Deno.test("fromRpc: the database's own refusals pass through unchanged", () => {
  const cases: [unknown, number, number, string][] = [
    [{ code: "forbidden" }, 403, 403, "forbidden"],
    [{ code: "last_master_admin" }, 409, 409, "last_master_admin"],
    [{ code: "password_reset_required" }, 403, 403, "password_reset_required"],
    [{ code: "not_found" }, 404, 404, "not_found"],
    [{ code: "unauthenticated" }, 401, 401, "unauthenticated"],
    // Not one of ours:
    [{ code: "42501" }, 401, 401, "unauthenticated"],
    [{ code: "42501" }, 403, 403, "forbidden"],
    [{ code: "PGRST301" }, 401, 401, "unauthenticated"],
    [{ code: "PGRST303" }, 400, 401, "unauthenticated"],
    [{ code: "22P02" }, 400, 400, "invalid_input"],
    [{ code: "PGRST202" }, 404, 500, "server_error"],
    [{ code: "forbidden" }, 500, 500, "server_error"],
    [{ code: "" }, 0, 500, "server_error"],
    [null, 503, 500, "server_error"],
    [{ code: 7 }, 400, 500, "server_error"],
  ];
  for (const [error, http, status, code] of cases) {
    const e = fromRpc(error as { code?: unknown }, http);
    assertEquals([e.status, e.code], [status, code], JSON.stringify([error, http]));
  }
});

Deno.test("fromAuth: known codes, the action's own codes first, everything else is auth_sync_failed", () => {
  const of = (e: unknown, extra = {}) => {
    const out = fromAuth(e, extra);
    return [out.status, out.code];
  };
  assertEquals(of(new AuthStepError(429, "over_email_send_rate_limit")), [429, "rate_limited"]);
  assertEquals(of(new AuthStepError(429, "over_request_rate_limit")), [429, "rate_limited"]);
  assertEquals(of(new AuthStepError(429, "")), [429, "rate_limited"]);
  assertEquals(of(new AuthStepError(400, "email_address_not_authorized")), [502, "smtp_not_configured"]);
  assertEquals(of(new AuthStepError(422, "email_exists")), [502, "auth_sync_failed"]);
  assertEquals(of(new AuthStepError(422, "email_exists"), { email_exists: [409, "email_taken"] }), [409, "email_taken"]);
  assertEquals(of(new AuthStepError(400, "validation_failed"), INVALID_ADDRESS), [400, "invalid_input"]);
  assertEquals(of(new AuthStepError(400, "constructor"), INVALID_ADDRESS), [502, "auth_sync_failed"]);
  assertEquals(of(new Error("anything")), [502, "auth_sync_failed"]);
  assertEquals(of(undefined), [502, "auth_sync_failed"]);
  assert(fromAuth(undefined).note, "auth_sync_failed tells the caller a repeat completes it");
});

// --- Platform keys ------------------------------------------------------------------

Deno.test("platformKeys: named keys first, then the single form, then the legacy keys", () => {
  const from = (env: Record<string, string>) => platformKeys((name) => env[name]);

  assertEquals(
    from({
      SUPABASE_PUBLISHABLE_KEYS: '{"default":"pub-default","web":"pub-web"}',
      SUPABASE_SECRET_KEYS: '{"internal":"sec-internal","default":"sec-default"}',
      SUPABASE_PUBLISHABLE_KEY: "pub-single",
      SUPABASE_SECRET_KEY: "sec-single",
      SUPABASE_ANON_KEY: "anon",
      SUPABASE_SERVICE_ROLE_KEY: "service",
    }),
    { publishable: "pub-default", secret: "sec-default" },
  );
  assertEquals(from({ SUPABASE_SECRET_KEYS: '{"internal":"sec-internal"}' }).secret, "sec-internal");
  assertEquals(
    from({ SUPABASE_PUBLISHABLE_KEY: "pub-single", SUPABASE_SECRET_KEY: "sec-single", SUPABASE_SERVICE_ROLE_KEY: "service" }),
    { publishable: "pub-single", secret: "sec-single" },
  );
  assertEquals(from({ SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service" }), {
    publishable: "anon",
    secret: "service",
  });
  // Unusable values fall through instead of being used as a key.
  for (const bad of ["", "not json", "[]", '"a-bare-string"', "{}", '{"default":""}', '{"default":7}', "null"]) {
    assertEquals(from({ SUPABASE_SECRET_KEYS: bad, SUPABASE_SERVICE_ROLE_KEY: "service" }).secret, "service", bad);
  }
  assertEquals(from({}), { publishable: null, secret: null });
});
