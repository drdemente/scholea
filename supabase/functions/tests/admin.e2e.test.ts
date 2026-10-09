/**
 * The Edge Function "admin" end to end on the local stack: real Auth, real
 * database, real emails, called the way a client calls it.
 *
 * One story, told in steps that build on each other: a new instance has no
 * administrator; the owner promotes the first master admin from SQL; the
 * master admin invites an admin; the admin manages researchers; two master
 * admins act on each other. Along the way every action is tried by somebody
 * who may not do it, and every change is looked up in the audit log under the
 * action name the legacy server used.
 *
 * One action is not the admin's although the account is: the email of an
 * account that is in use can only be changed by a master admin, because
 * whoever reads the new mailbox can take the account over. The steps that
 * change such an address are therefore the master admin's.
 *
 * Run with `pnpm test:supabase`. See helpers.ts.
 *
 * A fresh database (CI, or after `supabase db reset`) has no master admin, and
 * then every step runs. On a database that already has one, the owner's
 * promotion is done with the documented second argument and the steps about
 * the LAST master admin are skipped, because this run's master admin is not
 * the last one. The run removes its own accounts either way.
 */
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  type Account,
  adminFn,
  adminFnRaw,
  API_URL,
  auditOf,
  codeHash,
  auth,
  bootstrapMasterAdmin,
  functionAnswers,
  functionReady,
  newAccount,
  newAddress,
  newPassword,
  newProject,
  nextCode,
  nextMail,
  proveAddress,
  PUBLISHABLE_KEY,
  removeEverything,
  type Reply,
  request,
  rpc,
  SECRET_KEY,
  signIn,
  signInAs,
  signUp,
  sleep,
  sql,
  SUBJECT,
  table,
  track,
  unreadMail,
  usableMasterAdmins,
  verifyCode,
  verifyCodeHash,
} from "./helpers.ts";

Deno.test.afterAll(removeEverything);

const USER_KEYS = [
  "createdAt",
  "email",
  "emailConfirmed",
  "id",
  "institution",
  "lastLoginAt",
  "mustResetPassword",
  "name",
  "role",
  "status",
];

/** The function refused: `{ error: code }` with that status, and the CORS header so a browser can read it. */
function assertRefused(reply: Reply, status: number, code: string, about = "") {
  assertEquals([reply.status, reply.body?.error], [status, code], `${about} ${reply.text}`);
  assertEquals(reply.headers.get("access-control-allow-origin"), "*");
}

/** A database function refused: PostgREST's `{ code }` with that status. */
function assertRpcRefused(reply: Reply, status: number, code: string, about = "") {
  assertEquals([reply.status, reply.body?.code], [status, code], `${about} ${reply.text}`);
}

/** The six actions, each with a body that would work for a caller who may do it. */
function sixActions(target: { id: string }, unusedAddress: string): Record<string, unknown>[] {
  return [
    { action: "invite_user", email: unusedAddress, role: "researcher" },
    { action: "resend_invite", userId: target.id },
    { action: "update_email", userId: target.id, email: unusedAddress },
    { action: "suspend_user", userId: target.id },
    { action: "activate_user", userId: target.id },
    { action: "delete_user", userId: target.id },
  ];
}

/** What Auth and the database hold about an account, read as the owner. */
async function stored(userId: string) {
  const [row] = await sql<{
    email: string | null;
    role: string;
    status: string;
    banned: boolean;
    auth_deleted: boolean;
    sessions: number;
  }>(
    `select p.email, p.role, p.status,
            coalesce(u.banned_until > now(), false) as banned,
            u.deleted_at is not null as auth_deleted,
            (select count(*)::int from auth.sessions s where s.user_id = p.id) as sessions
       from public.profiles p join auth.users u on u.id = p.id
      where p.id = $1`,
    [userId],
  );
  return row;
}

/**
 * What Auth itself holds about an account's address, read as the owner. Any
 * update through the Auth admin API moves `updated_at`, so two equal records
 * mean Auth was not asked to change anything.
 */
async function authRecord(userId: string) {
  const [row] = await sql<{
    email: string;
    email_change: string;
    confirmed: boolean;
    updated_at: string;
    identity_emails: string[];
    pending_changes: number;
  }>(
    `select u.email, coalesce(u.email_change, '') as email_change,
            u.email_confirmed_at is not null as confirmed,
            u.updated_at::text as updated_at,
            (select coalesce(array_agg(i.email order by i.email), '{}') from auth.identities i where i.user_id = u.id)
              as identity_emails,
            (select count(*)::int from private.admin_intents n where n.target_id = u.id) as pending_changes
       from auth.users u where u.id = $1`,
    [userId],
  );
  return row;
}

async function addressHasAccount(email: string): Promise<boolean> {
  const [row] = await sql<{ n: number }>(
    `select (select count(*) from auth.users where lower(email) = lower($1))::int
          + (select count(*) from public.profiles where lower(email) = lower($1))::int as n`,
    [email],
  );
  return row.n > 0;
}

/** The audit rows about an account with this action name. */
async function audited(userId: string, action: string) {
  return (await auditOf(userId)).filter((row) => row.action === action);
}

/** The invited person's side: type the emailed code, then choose a password. */
async function acceptInvitation(email: string, id: string): Promise<Account> {
  const code = await nextCode(email, SUBJECT.invite);
  const verified = await verifyCode("invite", email, code);
  assertEquals(verified.status, 200, verified.text);
  assertEquals(verified.body.user.id, id);
  const password = newPassword();
  const set = await auth("PUT", "/user", { token: verified.body.access_token, body: { password } });
  assertEquals(set.status, 200, set.text);
  // Auth tells the address that a password was set.
  await nextMail(email, SUBJECT.passwordChanged);
  return { id, email, password, token: verified.body.access_token, refreshToken: verified.body.refresh_token };
}

Deno.test("admin function", async (t) => {
  await functionReady();
  const fresh = (await usableMasterAdmins()) === 0;
  if (!fresh) console.log("  note: this database already has a master admin; the last-master steps are skipped");

  // Everybody starts as an ordinary account.
  const master = await newAccount("master", "Mona Master");
  const researcher = await newAccount("researcher", "Rae Researcher");
  const bystander = await newAccount("bystander", "Ben Bystander");
  // Filled in as the story goes.
  let admin!: Account;
  let admin2!: Account;
  let master2!: Account;
  let managed!: Account;
  let managedProject!: string;

  await t.step("a browser preflight is answered, with the headers the app needs", async () => {
    // Without the preflight request headers the local gateway passes OPTIONS to the function itself.
    const own = await adminFnRaw("OPTIONS", { key: null, token: null });
    assert(own.status >= 200 && own.status < 300, `status ${own.status}`);
    assertEquals(own.headers.get("access-control-allow-origin"), "*");
    assertEquals(own.headers.get("access-control-allow-headers"), "authorization, x-client-info, apikey, content-type");
    assertEquals(own.headers.get("access-control-allow-credentials"), null);

    // A real preflight, as a browser sends it from the app's origin.
    const preflight = await adminFnRaw("OPTIONS", {
      key: null,
      token: null,
      headers: {
        Origin: "http://localhost:5193",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
    assert(preflight.status >= 200 && preflight.status < 300, `status ${preflight.status}`);
    assertEquals(preflight.headers.get("access-control-allow-origin"), "*");
    const allowed = (preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    for (const header of ["authorization", "x-client-info", "apikey", "content-type"]) {
      assert(allowed.includes(header), `preflight allows ${header}: ${allowed}`);
    }
  });

  await t.step("without a signed-in user's token the function does nothing", async () => {
    const victim = newAddress("never-invited");
    const body = { action: "invite_user", email: victim, role: "researcher", surface: "master" };

    assertEquals((await adminFnRaw("POST", { key: null, token: null, body })).status, 401, "no credentials at all");
    assertEquals((await adminFnRaw("POST", { token: null, body })).status, 401, "an API key but no token");
    assertEquals((await adminFn(body, "not.a.token")).status, 401);

    // The app's own key, which every visitor has, in place of a user's token.
    assertRefused(await adminFn(body, PUBLISHABLE_KEY), 401, "unauthenticated");
    // The secret key is not a caller either: the function acts for people, not for keys.
    assertRefused(await adminFn(body, SECRET_KEY, { key: SECRET_KEY }), 401, "unauthenticated");

    // A real token with its payload rewritten to name somebody else.
    const [head, payload, signature] = researcher.token.split(".");
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    const forgedPayload = btoa(JSON.stringify({ ...claims, sub: master.id }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    assertEquals((await adminFn(body, `${head}.${forgedPayload}.${signature}`)).status, 401);

    assertEquals(await addressHasAccount(victim), false, "nobody was invited");
  });

  await t.step("only POST with a JSON object that names an action", async () => {
    const get = await adminFnRaw("GET", { token: master.token });
    assertRefused(get, 405, "method_not_allowed");
    assertRefused(await adminFnRaw("POST", { token: master.token, rawBody: "{nope" }), 400, "invalid_input");
    assertRefused(await adminFn([], master.token), 400, "invalid_input");
    assertRefused(await adminFn({}, master.token), 400, "invalid_input");
    assertRefused(await adminFn({ action: "revoke_sessions", userId: researcher.id }, master.token), 400, "invalid_input");
    assertRefused(await adminFn({ action: "constructor" }, master.token), 400, "invalid_input");
  });

  await t.step("a new instance has no administrator: every action is refused, on both surfaces", async () => {
    for (const body of sixActions(bystander, newAddress("unused"))) {
      for (const surface of [undefined, "admin", "master"]) {
        assertRefused(await adminFn({ ...body, surface }, master.token), 403, "forbidden", `${body.action}/${surface}`);
      }
    }
    assertRpcRefused(await rpc("admin_list_users", {}, master.token), 403, "forbidden");
  });

  await t.step("the first master admin cannot be made through the API", async () => {
    const args = { p_email: master.email, p_force: true };
    assertEquals((await rpc("bootstrap_master_admin", args, master.token)).status, 404);
    const viaPrivate = await rpc("bootstrap_master_admin", args, master.token, {
      headers: { "Content-Profile": "private" },
    });
    assertEquals([viaPrivate.status, viaPrivate.body.code], [406, "PGRST106"]);
    const withSecret = await rpc("bootstrap_master_admin", args, SECRET_KEY, {
      key: SECRET_KEY,
      headers: { "Content-Profile": "private" },
    });
    assert(withSecret.status >= 400, `secret key: ${withSecret.status}`);
    assertEquals((await stored(master.id)).role, "researcher");
  });

  await t.step("the owner promotes the first master admin from SQL", async () => {
    if (fresh) {
      const promoted = await bootstrapMasterAdmin(master.email);
      assertEquals(promoted, { created: true, userId: master.id, email: master.email });
      // Once there is one, the plain call promotes nobody else.
      assertEquals(await bootstrapMasterAdmin(researcher.email), { created: false, reason: "master-exists" });
    } else {
      assertEquals(await bootstrapMasterAdmin(master.email), { created: false, reason: "master-exists" });
      const forced = await bootstrapMasterAdmin(master.email, true);
      assertEquals(forced, { created: true, userId: master.id, email: master.email });
    }
    // Even the forcing form only promotes an account that exists.
    assertEquals(await bootstrapMasterAdmin(newAddress("no-such-person"), true), {
      created: false,
      reason: "no-active-user-with-that-email",
    });
    assertEquals((await stored(researcher.id)).role, "researcher");

    const [row] = await audited(master.id, "master.provisioned");
    assertEquals([row.actor_id, row.before_data, row.after_data?.role], [null, { role: "researcher" }, "master_admin"]);

    // The role is read from the database on every request, never from the
    // token: the token issued before the promotion now carries master rights.
    const list = await rpc("admin_list_users", {}, master.token);
    assertEquals(list.status, 200);
    assert(list.body.total >= 3);
    assertEquals((await rpc("master_list_admins", {}, master.token)).status, 200);
  });

  await t.step({
    name: "the last master admin cannot suspend or delete themselves",
    ignore: !fresh,
    fn: async () => {
      for (const surface of ["admin", "master"]) {
        assertRefused(
          await adminFn({ action: "suspend_user", userId: master.id, surface }, master.token),
          409,
          "last_master_admin",
        );
        assertRefused(
          await adminFn({ action: "delete_user", userId: master.id, surface }, master.token),
          409,
          "last_master_admin",
        );
      }
      // The database refused, so Auth was never asked: not banned, not deleted, still signed in.
      const now = await stored(master.id);
      assertEquals([now.status, now.banned, now.auth_deleted], ["active", false, false]);
      assertEquals((await signIn(master.email, master.password)).status, 200);
      assertEquals((await rpc("my_profile", {}, master.token)).body.user.role, "master_admin");
    },
  });

  await t.step("a researcher is refused every action and nothing changes", async () => {
    const unused = newAddress("unused");
    const before = await stored(bystander.id);
    const auditBefore = (await auditOf(bystander.id)).length;

    for (const body of sixActions(bystander, unused)) {
      for (const surface of [undefined, "admin", "master"]) {
        // The body may claim anything about the caller. None of it is read.
        const claims = { actorId: master.id, callerRole: "master_admin", user: { id: master.id, role: "master_admin" } };
        assertRefused(
          await adminFn({ ...body, ...claims, surface }, researcher.token),
          403,
          "forbidden",
          `${body.action}/${surface}`,
        );
      }
    }
    // Whatever the arguments, a researcher learns nothing from the answer.
    assertRefused(await adminFn({ action: "suspend_user", userId: "nonsense" }, researcher.token), 403, "forbidden");
    assertRefused(await adminFn({ action: "invite_user" }, researcher.token), 403, "forbidden");
    assertRpcRefused(await rpc("admin_revoke_sessions", { p_user_id: bystander.id }, researcher.token), 403, "forbidden");

    assertEquals(await stored(bystander.id), before);
    assertEquals((await auditOf(bystander.id)).length, auditBefore);
    assertEquals(await addressHasAccount(unused), false);
    assertEquals((await signIn(bystander.email, bystander.password)).status, 200);
  });

  await t.step("a master admin invites an admin, who must set a password before anything else", async () => {
    const email = newAddress("admin");
    // No role given: on the master surface that means admin.
    const invited = await adminFn(
      { action: "invite_user", surface: "master", email: `  ${email.toUpperCase()} `, name: "  Alex Admin ", institution: "Scholea U" },
      master.token,
    );
    assertEquals(invited.status, 201, invited.text);
    assertEquals(Object.keys(invited.body), ["user"], "the answer is the account and nothing else");
    assertEquals(Object.keys(invited.body.user).sort(), USER_KEYS);
    const id = track(invited.body.user.id);
    assertEquals(
      {
        email: invited.body.user.email,
        name: invited.body.user.name,
        institution: invited.body.user.institution,
        role: invited.body.user.role,
        status: invited.body.user.status,
        mustResetPassword: invited.body.user.mustResetPassword,
        emailConfirmed: invited.body.user.emailConfirmed,
      },
      {
        email,
        name: "Alex Admin",
        institution: "Scholea U",
        role: "admin",
        status: "active",
        mustResetPassword: true,
        emailConfirmed: false,
      },
    );

    const [created] = await audited(id, "master.admin_created");
    assertEquals(
      [created.actor_id, created.actor_email, created.after_data],
      [master.id, master.email, { email, role: "admin", invited: true }],
    );

    // Until the code is typed there is no way in.
    assertEquals((await signIn(email, newPassword())).body.error_code, "invalid_credentials");

    const code = await nextCode(email, SUBJECT.invite);
    assert(!invited.text.includes(code), "the code travels by email only");
    const verified = await verifyCode("invite", email, code);
    assertEquals(verified.status, 200, verified.text);
    const token = verified.body.access_token;

    // Signed in, an admin by role, and still locked out of everything.
    const me = await rpc("my_profile", {}, token);
    assertEquals([me.status, me.body.user.role, me.body.user.mustResetPassword], [200, "admin", true]);
    assertRpcRefused(await rpc("list_my_projects", {}, token), 403, "password_reset_required");
    assertRpcRefused(await rpc("admin_list_users", {}, token), 403, "password_reset_required");
    assertRefused(
      await adminFn({ action: "invite_user", email: newAddress("unused"), role: "researcher" }, token),
      403,
      "password_reset_required",
    );
    // No table is readable, by them or by anybody. Their own record comes from one function.
    assertEquals((await table("profiles?select=id", token)).status, 403);
    assertEquals((await table("audit_log?select=id&limit=1", token)).status, 403);
    const own = await rpc("my_account", {}, token);
    assertEquals([own.status, own.body.id, own.body.role, own.body.must_set_password], [200, id, "admin", true]);

    const password = newPassword();
    assertEquals((await auth("PUT", "/user", { token, body: { password } })).status, 200);
    admin = { id, email, password, token, refreshToken: verified.body.refresh_token };

    assertEquals((await rpc("my_profile", {}, token)).body.user.mustResetPassword, false);
    assertEquals((await rpc("admin_list_users", {}, token)).status, 200);
    assertEquals((await audited(id, "auth.first_login_completed")).length, 1);
    assertEquals((await signIn(email, password)).status, 200);
  });

  await t.step("an admin may invite researchers and supervisors, and nobody else", async () => {
    const unused = newAddress("unused");
    const invite = (extra: Record<string, unknown>) =>
      adminFn({ action: "invite_user", email: unused, role: "researcher", ...extra }, admin.token);

    assertRefused(await invite({ role: "admin" }), 403, "forbidden_role");
    assertRefused(await invite({ role: "master_admin" }), 403, "forbidden_role");
    assertRefused(await invite({ role: "owner" }), 400, "invalid_role");
    assertRefused(await invite({ role: undefined }), 400, "invalid_role");
    assertRefused(await invite({ surface: "master", role: "admin" }), 403, "forbidden");
    assertRefused(await invite({ surface: "everything" }), 400, "invalid_input");
    assertRefused(await invite({ email: "not an address" }), 400, "invalid_input");
    assertRefused(await invite({ email: undefined }), 400, "invalid_input");
    assertRefused(await invite({ name: "x".repeat(201) }), 400, "invalid_input");
    assertRefused(await invite({ email: researcher.email }), 409, "email_taken");
    assertRefused(await invite({ email: researcher.email.toUpperCase() }), 409, "email_taken");
    assertEquals(await addressHasAccount(unused), false, "none of the refused invitations created anything");
    assertEquals(await unreadMail(unused), []);
  });

  await t.step("an admin invites a supervisor; the role comes from the request's role and from nowhere else", async () => {
    const email = newAddress("supervisor");
    const invited = await adminFn({
      action: "invite_user",
      email,
      role: "supervisor",
      name: "Sam Supervisor",
      // None of these is a way to get a role.
      data: { role: "master_admin" },
      user_metadata: { role: "master_admin" },
      app_metadata: { role: "master_admin" },
      status: "suspended",
    }, admin.token);
    assertEquals(invited.status, 201, invited.text);
    const id = track(invited.body.user.id);
    assertEquals([invited.body.user.role, invited.body.user.status], ["supervisor", "active"]);

    const [created] = await audited(id, "admin.user_created");
    assertEquals([created.actor_id, created.after_data], [admin.id, { email, role: "supervisor", invited: true }]);

    // Inviting the same address again is refused; sending the code again is its own action.
    assertRefused(await adminFn({ action: "invite_user", email, role: "supervisor" }, admin.token), 409, "email_taken");

    const first = await nextCode(email, SUBJECT.invite);
    const resent = await adminFn({ action: "resend_invite", userId: id }, admin.token);
    assertEquals([resent.status, resent.body], [200, { ok: true }], resent.text);
    const second = await nextCode(email, SUBJECT.invite);
    assertNotEquals(second, first);
    assert(!resent.text.includes(second));
    assertEquals((await verifyCode("invite", email, first)).status, 403, "the earlier code is superseded");

    const verified = await verifyCode("invite", email, second);
    assertEquals(verified.status, 200, verified.text);

    // The code was used but no password chosen yet: nothing is pending any more.
    assertRefused(await adminFn({ action: "resend_invite", userId: id }, admin.token), 409, "not_pending");
    // The way in from here is "Forgot password".
    assertEquals((await auth("POST", "/recover", { body: { email } })).status, 200);
    const recovered = await verifyCode("recovery", email, await nextCode(email, SUBJECT.recovery));
    assertEquals(recovered.status, 200, recovered.text);
    assertEquals((await auth("PUT", "/user", { token: recovered.body.access_token, body: { password: newPassword() } })).status, 200);
    const me = await rpc("my_profile", {}, recovered.body.access_token);
    assertEquals([me.body.user.role, me.body.user.mustResetPassword], ["supervisor", false]);

    // A supervisor is not an administrator.
    assertRefused(
      await adminFn({ action: "suspend_user", userId: bystander.id }, recovered.body.access_token),
      403,
      "forbidden",
    );
  });

  await t.step("resend_invite is only for an account that is waiting for its code", async () => {
    assertRefused(await adminFn({ action: "resend_invite", userId: researcher.id }, admin.token), 409, "not_pending");
    assertRefused(await adminFn({ action: "resend_invite", userId: crypto.randomUUID() }, admin.token), 404, "not_found");
    assertRefused(await adminFn({ action: "resend_invite", userId: "not-an-id" }, admin.token), 404, "not_found");
    assertRefused(await adminFn({ action: "resend_invite" }, admin.token), 404, "not_found");
    assertEquals(await unreadMail(researcher.email), []);
  });

  await t.step("a master admin invites a second admin and a second master admin", async () => {
    const adminEmail = newAddress("admin2");
    const invitedAdmin = await adminFn(
      { action: "invite_user", surface: "master", email: adminEmail, role: "admin" },
      master.token,
    );
    assertEquals(invitedAdmin.status, 201, invitedAdmin.text);
    const adminId = track(invitedAdmin.body.user.id);

    // The first admin may not touch a fellow admin, pending or not.
    assertRefused(await adminFn({ action: "resend_invite", userId: adminId }, admin.token), 403, "forbidden");
    // The master surface is closed to an admin.
    assertRefused(await adminFn({ action: "resend_invite", userId: adminId, surface: "master" }, admin.token), 403, "forbidden");

    await nextCode(adminEmail, SUBJECT.invite);
    const resent = await adminFn({ action: "resend_invite", userId: adminId, surface: "master" }, master.token);
    assertEquals([resent.status, resent.body], [200, { ok: true }], resent.text);
    admin2 = await acceptInvitation(adminEmail, adminId);
    assertEquals((await rpc("my_profile", {}, admin2.token)).body.user.role, "admin");

    // Only the admin tier can be invited on the master surface.
    assertRefused(
      await adminFn({ action: "invite_user", surface: "master", email: newAddress("unused"), role: "researcher" }, master.token),
      400,
      "invalid_role",
    );

    const masterEmail = newAddress("master2");
    const invitedMaster = await adminFn(
      { action: "invite_user", surface: "master", email: masterEmail, role: "master_admin", name: "Max Master" },
      master.token,
    );
    assertEquals(invitedMaster.status, 201, invitedMaster.text);
    const masterId = track(invitedMaster.body.user.id);
    assertEquals(invitedMaster.body.user.role, "master_admin");
    const [created] = await audited(masterId, "master.admin_created");
    assertEquals([created.actor_id, created.after_data?.role], [master.id, "master_admin"]);
    master2 = await acceptInvitation(masterEmail, masterId);
    assertEquals((await rpc("master_list_admins", {}, master2.token)).status, 200);
  });

  await t.step("an admin may not act on an admin or a master admin", async () => {
    for (const target of [admin2, master, master2]) {
      const before = await stored(target.id);
      for (const body of sixActions(target, newAddress("unused")).slice(1)) {
        assertRefused(await adminFn(body, admin.token), 403, "forbidden", `${body.action} on ${before.role}`);
      }
      assertRpcRefused(await rpc("admin_revoke_sessions", { p_user_id: target.id }, admin.token), 403, "forbidden");
      assertEquals(await stored(target.id), before);
    }
  });

  await t.step("update_email on an account that is in use: an admin is refused, and nothing changes in Auth", async () => {
    managed = await newAccount("managed", "Mia Managed");
    managedProject = await newProject(managed, "Mia's review");
    const wanted = newAddress("managed-taken-over");
    const before = [await stored(managed.id), await authRecord(managed.id), (await auditOf(managed.id)).length];

    // The change would take effect at once, and whoever reads the new mailbox
    // could then get in with "Forgot password". For an account that is in use
    // that is a master admin's action. The database refuses the admin, and the
    // function passes the refusal on without asking Auth for anything.
    const refused = await adminFn({ action: "update_email", userId: managed.id, email: wanted }, admin.token);
    assertRefused(refused, 403, "forbidden");
    assertEquals(refused.body, { error: "forbidden" }, "the code and nothing else");
    // The answer does not depend on the address: one that is taken, or the one the account already has.
    for (const email of [researcher.email, managed.email, managed.email.toUpperCase()]) {
      assertRefused(await adminFn({ action: "update_email", userId: managed.id, email }, admin.token), 403, "forbidden", email);
    }
    // Naming the master surface in the body is not a way around it.
    assertRefused(
      await adminFn({ action: "update_email", userId: managed.id, email: wanted, surface: "master" }, admin.token),
      403,
      "forbidden",
    );
    // The database function says the same to an admin who calls it directly.
    const direct = await rpc("admin_begin_email_change", { p_user_id: managed.id, p_new_email: wanted }, admin.token);
    assertRpcRefused(direct, 403, "forbidden");
    assertEquals(direct.body.details, "master_admin_required");

    // Nothing changed: not in Auth, not in the database, not in the audit log, and no mail went out.
    assertEquals([await stored(managed.id), await authRecord(managed.id), (await auditOf(managed.id)).length], before);
    assertEquals(await addressHasAccount(wanted), false);
    assertEquals(await unreadMail(wanted), []);
    assertEquals(await unreadMail(managed.email), []);
    assertEquals((await signIn(managed.email, managed.password)).status, 200, "the person signs in as before");
    assertEquals((await signIn(wanted, managed.password)).body.error_code, "invalid_credentials");
    // The account is still the admin's to manage in every other way (the later steps suspend and delete it).
    assertEquals((await rpc("admin_get_user", { p_user_id: managed.id }, admin.token)).body.user.email, managed.email);
  });

  await t.step("update_email by a master admin: takes effect at once, keeps the session, is audited with both addresses", async () => {
    const oldEmail = managed.email;
    const newEmail = newAddress("managed-moved");

    const moved = await adminFn(
      { action: "update_email", userId: managed.id, email: `  ${newEmail.toUpperCase()}  ` },
      master.token,
    );
    assertEquals(moved.status, 200, moved.text);
    assertEquals(Object.keys(moved.body), ["user"]);
    // Nobody has shown that they can read the new mailbox, so the address is not a confirmed one.
    assertEquals([moved.body.user.email, moved.body.user.emailConfirmed], [newEmail, false]);

    // The person's existing token keeps working and shows the new address.
    const me = await rpc("my_profile", {}, managed.token);
    assertEquals([me.status, me.body.user.email, me.body.user.emailConfirmed], [200, newEmail, false]);
    assertEquals((await rpc("list_my_projects", {}, managed.token)).body.projects.length, 1, "their project is still theirs");
    assertEquals((await signIn(newEmail, managed.password)).status, 200);
    assertEquals((await signIn(oldEmail, managed.password)).body.error_code, "invalid_credentials");
    managed.email = newEmail;
    // Auth sends nothing to either address for a change an administrator makes:
    // no confirmation is asked of the new one, and the old one is NOT told.
    // That second half is a known limit (the administrator has to tell the
    // person). If a later Auth sends a notice, this fails and the docs change.
    assertEquals(await unreadMail(newEmail), []);
    assertEquals(await unreadMail(oldEmail), []);

    const rows = await audited(managed.id, "admin.user_updated");
    assertEquals(rows.length, 1);
    assertEquals(
      [rows[0].actor_id, rows[0].before_data, rows[0].after_data],
      [master.id, { email: oldEmail }, { email: newEmail }],
    );
    assertEquals((await audited(managed.id, "auth.email_changed")).length, 0, "not recorded as the person's own change");

    // The same address again changes nothing and writes nothing.
    const again = await adminFn({ action: "update_email", userId: managed.id, email: newEmail }, master.token);
    assertEquals([again.status, again.body.user.email], [200, newEmail]);
    assertEquals((await audited(managed.id, "admin.user_updated")).length, 1);

    const change = (email: unknown, userId: unknown = managed.id) =>
      adminFn({ action: "update_email", userId, email }, master.token);
    assertRefused(await change(researcher.email), 409, "email_taken");
    assertRefused(await change("not an address"), 400, "invalid_input");
    assertRefused(await change(undefined), 400, "invalid_input");
    assertRefused(await change(newAddress("unused"), crypto.randomUUID()), 404, "not_found");
    assertEquals((await stored(managed.id)).email, newEmail);
  });

  await t.step("update_email for somebody still waiting for their code: an admin may correct it, and the code goes to the new address", async () => {
    // Nobody can use this account yet, so correcting its address is not a way
    // into anything, and an admin may do it.
    const first = newAddress("pending");
    const second = newAddress("pending-moved");
    const invited = await adminFn({ action: "invite_user", email: first, role: "researcher" }, admin.token);
    assertEquals(invited.status, 201, invited.text);
    const id = track(invited.body.user.id);
    await nextCode(first, SUBJECT.invite);

    const moved = await adminFn({ action: "update_email", userId: id, email: second }, admin.token);
    assertEquals(moved.status, 200, moved.text);
    assertEquals(
      [moved.body.user.email, moved.body.user.emailConfirmed, moved.body.user.mustResetPassword],
      [second, false, true],
      "still unconfirmed and still waiting",
    );

    assertEquals((await adminFn({ action: "resend_invite", userId: id }, admin.token)).status, 200);
    const account = await acceptInvitation(second, id);
    const accepted = (await rpc("my_profile", {}, account.token)).body.user;
    // The code they typed was sent to the corrected address, so that address is confirmed.
    assertEquals([accepted.email, accepted.emailConfirmed], [second, true]);
    assertEquals(await unreadMail(first), [], "nothing more went to the old address");

    // They have a password now: the account is in use, and no longer the admin's to move.
    assertRefused(
      await adminFn({ action: "update_email", userId: id, email: newAddress("unused") }, admin.token),
      403,
      "forbidden",
    );
    assertEquals((await stored(id)).email, second);
  });

  await t.step("update_email for a sign-up that was never confirmed: an admin may correct it, until the account is confirmed", async () => {
    const first = newAddress("unconfirmed");
    const second = newAddress("unconfirmed-moved");
    const password = newPassword();
    const created = await signUp(first, password);
    assertEquals(created.status, 200, created.text);
    const id = track(created.body.id);
    await nextCode(first, SUBJECT.confirmation);

    const moved = await adminFn({ action: "update_email", userId: id, email: second }, admin.token);
    assertEquals(moved.status, 200, moved.text);
    assertEquals(
      [moved.body.user.email, moved.body.user.emailConfirmed, moved.body.user.mustResetPassword],
      [second, false, false],
      "still unconfirmed",
    );
    const [update] = await audited(id, "admin.user_updated");
    assertEquals([update.actor_id, update.before_data, update.after_data], [admin.id, { email: first }, { email: second }]);
    assertEquals((await signIn(second, password)).body.error_code, "email_not_confirmed");
    assertEquals(await unreadMail(second), [], "the change itself sends nothing");

    // The person asks for their code again. It goes to the corrected address, and typing it confirms the account.
    await sleep(1100); // The first code went out a moment ago, and the local stack allows one email a second.
    assertEquals((await auth("POST", "/resend", { body: { type: "signup", email: second } })).status, 200);
    const verified = await verifyCode("email", second, await nextCode(second, SUBJECT.confirmation));
    assertEquals(verified.status, 200, verified.text);
    const me = (await rpc("my_profile", {}, verified.body.access_token)).body.user;
    assertEquals([me.email, me.emailConfirmed], [second, true]);

    // From that moment the account is in use, and no longer the admin's to move.
    assertRefused(
      await adminFn({ action: "update_email", userId: id, email: newAddress("unused") }, admin.token),
      403,
      "forbidden",
    );
    assertEquals((await stored(id)).email, second);
  });

  await t.step("update_email hands nobody the project invitations that wait for the new address", async () => {
    // A project the administrators have nothing to do with, and an invitation
    // for an address nobody has registered yet.
    const invited = newAddress("invited-colleague");
    const project = await newProject(bystander, "Ben's confidential trial");
    const sent = await rpc(
      "invite_project_member",
      { p_project_id: project, p_email: invited, p_role: "editor" },
      bystander.token,
    );
    assertEquals(sent.status, 200, sent.text);
    const invitationId = sent.body.invitation.id;
    for (const administrator of [admin, master]) {
      assertRpcRefused(await rpc("get_project", { p_project_id: project }, administrator.token), 404, "not_found");
    }

    // An administrator has an account they control, and prepares: a reset code
    // is asked for while the account still has an address whose mail they read.
    const puppet = await newAccount("puppet", "Pat Puppet");
    await sleep(1100); // Auth sends one email per address per second on the local stack.
    assertEquals((await auth("POST", "/recover", { body: { email: puppet.email } })).status, 200);
    const oldCode = await nextCode(puppet.email, SUBJECT.recovery);

    // Then the account is moved onto the invited address. An admin cannot do
    // that any more, because the account is in use. A master admin can, and
    // the invitation must not follow.
    assertRefused(
      await adminFn({ action: "update_email", userId: puppet.id, email: invited }, admin.token),
      403,
      "forbidden",
    );
    const moved = await adminFn({ action: "update_email", userId: puppet.id, email: invited }, master.token);
    assertEquals([moved.status, moved.body.user.email, moved.body.user.emailConfirmed], [200, invited, false], moved.text);

    // Auth itself still calls the account confirmed, and its sessions are alive.
    const [held] = await sql<{ confirmed: boolean }>(
      "select email_confirmed_at is not null as confirmed from auth.users where id = $1",
      [puppet.id],
    );
    assertEquals(held.confirmed, true);
    const fresh = await signIn(invited, puppet.password);
    assertEquals(fresh.status, 200, fresh.text);
    for (const token of [puppet.token, fresh.body.access_token]) {
      assertEquals((await rpc("list_my_invitations", {}, token)).body, { invitations: [] }, "the invitation is not shown");
      assertRpcRefused(
        await rpc("accept_project_invitation", { p_invitation_id: invitationId }, token),
        404,
        "not_found",
        "and cannot be accepted by its id",
      );
      assertRpcRefused(await rpc("get_project_content", { p_project_id: project }, token), 404, "not_found");
    }
    // The prepared code is used now. Auth looks a code up by a hash of the
    // address it was sent to and the code, so it still accepts this one and
    // opens a session. The code was never sent to the invited address, and the
    // database knows: nothing is proven.
    const stale = await verifyCodeHash("recovery", codeHash(puppet.email, oldCode));
    assertEquals(stale.status, 200, `Auth accepts a code from before the move: ${stale.text}`);
    assertEquals(stale.body.user.email, invited);
    const afterStale = await rpc("my_profile", {}, stale.body.access_token);
    assertEquals(afterStale.body.user.emailConfirmed, false, "a code that was sent to the old address proves nothing");
    assertEquals((await rpc("list_my_invitations", {}, stale.body.access_token)).body, { invitations: [] });
    assertRpcRefused(
      await rpc("accept_project_invitation", { p_invitation_id: invitationId }, stale.body.access_token),
      404,
      "not_found",
    );
    assertEquals(await unreadMail(invited), [], "nothing was ever sent to the invited address");

    const members = await rpc("list_project_members", { p_project_id: project }, bystander.token);
    assertEquals(members.body.members.map((m: { email: string }) => m.email), [bystander.email]);

    // Whoever really reads that mailbox types a code that was sent to it. From
    // then on the address is theirs, and so is the invitation.
    const proven = await proveAddress(invited);
    assertEquals((await rpc("my_profile", {}, proven.token)).body.user.emailConfirmed, true);
    const waiting = await rpc("list_my_invitations", {}, proven.token);
    assertEquals(waiting.body.invitations.map((i: { id: string }) => i.id), [invitationId]);
    const accepted = await rpc("accept_project_invitation", { p_invitation_id: invitationId }, proven.token);
    assertEquals([accepted.status, accepted.body], [200, { project_id: project, role: "editor" }], accepted.text);
  });

  await t.step("an address an administrator set is confirmed by a typed code and by nothing else", async () => {
    const person = await newAccount("moved-person", "Mo Moved");
    const moved = newAddress("moved-person-new");
    const changed = await adminFn({ action: "update_email", userId: person.id, email: moved }, master.token);
    assertEquals([changed.status, changed.body.user.emailConfirmed], [200, false], changed.text);
    const confirmed = async () => (await rpc("admin_get_user", { p_user_id: person.id }, admin.token)).body.user.emailConfirmed;

    // Signing in with the password says nothing about the mailbox.
    const signedIn = await signIn(moved, person.password);
    assertEquals(signedIn.status, 200, signedIn.text);
    assertEquals(await confirmed(), false, "after a password sign-in");

    // Asking for a reset code and then changing the password while signed in
    // uses the code up without anybody having typed it.
    assertEquals((await auth("POST", "/recover", { body: { email: moved } })).status, 200);
    await nextCode(moved, SUBJECT.recovery);
    const password = newPassword();
    const set = await auth("PUT", "/user", {
      token: signedIn.body.access_token,
      body: { password, current_password: person.password },
    });
    assertEquals(set.status, 200, set.text);
    await nextMail(moved, SUBJECT.passwordChanged);
    assertEquals(await confirmed(), false, "after a password change that used up a waiting code");

    // A sign-in code that Auth emails to the address, typed: that is proof.
    await sleep(1100); // Auth sends one email per address per second on the local stack.
    assertEquals((await auth("POST", "/otp", { body: { email: moved, create_user: false } })).status, 200);
    const typed = await verifyCode("email", moved, await nextCode(moved, SUBJECT.signIn));
    assertEquals(typed.status, 200, typed.text);
    assertEquals(await confirmed(), true, "after a typed sign-in code");
    assertEquals((await rpc("my_profile", {}, typed.body.access_token)).body.user.emailConfirmed, true);
  });

  await t.step("a person's own change of address is recorded as theirs, even while a master admin's request for it waits", async () => {
    const person = await newAccount("self-mover", "Sol Self");
    const target = newAddress("self-moved");

    // A master admin asks for exactly this change, and Auth is never told to make it.
    const asked = await rpc("admin_begin_email_change", { p_user_id: person.id, p_new_email: target }, master.token);
    assertEquals([asked.status, asked.body.changed], [200, true], asked.text);

    // The person makes the change themselves. Auth emails a code to the new
    // address and one to the old, and changes the address once both are typed.
    const change = await auth("PUT", "/user", { token: person.token, body: { email: target } });
    assertEquals(change.status, 200, change.text);
    const newCode = await nextCode(target, SUBJECT.emailChange);
    const oldCode = await nextCode(person.email, SUBJECT.emailChange);
    assertEquals((await verifyCode("email_change", target, newCode)).status, 200);
    const done = await verifyCode("email_change", person.email, oldCode);
    assertEquals(done.status, 200, done.text);

    const me = await rpc("my_profile", {}, done.body.access_token);
    assertEquals(
      [me.body.user.email, me.body.user.emailConfirmed],
      [target, true],
      "their own change needs no further proof: they typed the code sent to the new address",
    );
    const own = await audited(person.id, "auth.email_changed");
    assertEquals(
      own.map((row) => [row.actor_id, row.before_data, row.after_data]),
      [[person.id, { email: person.email }, { email: target }]],
    );
    assertEquals(
      (await audited(person.id, "admin.user_updated")).length,
      0,
      "the master admin who only asked is not recorded as having made the change",
    );
  });

  await t.step("suspend_user: the very next read with the same token is refused, and sign-in is blocked", async () => {
    await signInAs(managed);
    const token = managed.token;
    const refreshToken = managed.refreshToken;
    const before = await rpc("list_my_projects", {}, token);
    assertEquals([before.status, before.body.projects.length], [200, 1], "before: the person reads their project");
    assertEquals((await rpc("get_project_content", { p_project_id: managedProject }, token)).status, 200);
    const sessions = (await stored(managed.id)).sessions;
    assert(sessions >= 1);

    const suspended = await adminFn({ action: "suspend_user", userId: managed.id }, admin.token);
    assertEquals([suspended.status, suspended.body], [200, { ok: true, revokedSessions: sessions }], suspended.text);

    // The same access token, which has not expired, immediately afterwards.
    assertRpcRefused(await rpc("list_my_projects", {}, token), 401, "unauthenticated");
    assertRpcRefused(await rpc("get_project_content", { p_project_id: managedProject }, token), 401, "unauthenticated");
    assertRpcRefused(await rpc("my_profile", {}, token), 401, "unauthenticated");
    // All that is left to the dead token is the reason, so the app can show it.
    const why = await rpc("my_account", {}, token);
    assertEquals([why.status, why.body.status], [200, "suspended"]);
    const refreshed = await auth("POST", "/token?grant_type=refresh_token", { body: { refresh_token: refreshToken } });
    assert(refreshed.status >= 400, `refresh: ${refreshed.status}`);

    const blocked = await signIn(managed.email, managed.password);
    assertEquals([blocked.status, blocked.body.error_code], [400, "user_banned"]);

    const now = await stored(managed.id);
    assertEquals([now.status, now.banned, now.sessions], ["suspended", true, 0]);
    const rows = await audited(managed.id, "admin.user_suspended");
    assertEquals(rows.length, 1);
    assertEquals([rows[0].actor_id, rows[0].after_data], [admin.id, { revokedSessions: sessions }]);

    // Repeating it is harmless and writes nothing.
    const again = await adminFn({ action: "suspend_user", userId: managed.id }, admin.token);
    assertEquals([again.status, again.body], [200, { ok: true, revokedSessions: 0 }]);
    assertEquals((await audited(managed.id, "admin.user_suspended")).length, 1);

    assertRefused(await adminFn({ action: "suspend_user", userId: crypto.randomUUID() }, admin.token), 404, "not_found");
  });

  await t.step("activate_user: sign-in and data come back; the old token stays dead", async () => {
    const oldToken = managed.token;
    const activated = await adminFn({ action: "activate_user", userId: managed.id }, admin.token);
    assertEquals([activated.status, activated.body], [200, { ok: true }], activated.text);

    const now = await stored(managed.id);
    assertEquals([now.status, now.banned], ["active", false]);
    await signInAs(managed);
    const back = await rpc("list_my_projects", {}, managed.token);
    assertEquals([back.status, back.body.projects.length], [200, 1]);
    assertRpcRefused(await rpc("my_profile", {}, oldToken), 401, "unauthenticated");

    const rows = await audited(managed.id, "admin.user_activated");
    assertEquals([rows.length, rows[0].actor_id], [1, admin.id]);

    const again = await adminFn({ action: "activate_user", userId: managed.id }, admin.token);
    assertEquals([again.status, again.body], [200, { ok: true }]);
    assertEquals((await audited(managed.id, "admin.user_activated")).length, 1);
  });

  await t.step("a suspension that stopped half way is finished by running it again", async () => {
    const person = await newAccount("half-suspended");
    // Only the database half, as if the function had failed before reaching Auth.
    const half = await rpc("admin_set_user_status", { p_user_id: person.id, p_status: "suspended" }, admin.token);
    assertEquals(half.status, 200, half.text);
    assertEquals((await stored(person.id)).banned, false);

    // Half applied is already the restrictive state: a brand new sign-in gets nowhere.
    const between = await signIn(person.email, person.password);
    assertEquals(between.status, 200, "Auth has not been told yet");
    assertRpcRefused(await rpc("my_profile", {}, between.body.access_token), 403, "account_suspended");
    assertRpcRefused(await rpc("list_my_projects", {}, between.body.access_token), 403, "account_suspended");
    assertEquals((await rpc("my_account", {}, between.body.access_token)).body.status, "suspended");

    const finished = await adminFn({ action: "suspend_user", userId: person.id }, admin.token);
    assertEquals(finished.status, 200, finished.text);
    assertEquals(finished.body.revokedSessions, 1, "the session opened in between is ended too");
    assertEquals((await signIn(person.email, person.password)).body.error_code, "user_banned");
    assertEquals((await audited(person.id, "admin.user_suspended")).length, 2, "the second run ended a session, so it is recorded");
  });

  await t.step("revoking sessions is a plain database function: signed out everywhere, free to sign in again", async () => {
    const first = managed.token;
    const second = (await signIn(managed.email, managed.password)).body.access_token;
    assertEquals((await rpc("my_profile", {}, second)).status, 200);
    const sessions = (await stored(managed.id)).sessions;
    assert(sessions >= 2);

    const revoked = await rpc("admin_revoke_sessions", { p_user_id: managed.id }, admin.token);
    assertEquals([revoked.status, revoked.body], [200, { ok: true, revoked: sessions }], revoked.text);
    assertRpcRefused(await rpc("my_profile", {}, first), 401, "unauthenticated");
    assertRpcRefused(await rpc("my_profile", {}, second), 401, "unauthenticated");
    assertRpcRefused(await rpc("list_my_projects", {}, second), 401, "unauthenticated");

    const rows = await audited(managed.id, "admin.sessions_revoked");
    assertEquals([rows.length, rows[0].actor_id, rows[0].after_data], [1, admin.id, { revoked: sessions }]);

    await signInAs(managed);
    assertEquals((await rpc("my_profile", {}, managed.token)).status, 200);
  });

  await t.step("a signed-out administrator's token cannot act", async () => {
    const extra = (await signIn(admin.email, admin.password)).body.access_token;
    assertEquals((await rpc("admin_list_users", {}, extra)).status, 200);
    assertEquals((await auth("POST", "/logout?scope=local", { token: extra })).status, 204);

    const victim = newAddress("never-invited");
    // The token itself is still valid for an hour. The session behind it is gone.
    assertRefused(await adminFn({ action: "invite_user", email: victim, role: "researcher" }, extra), 401, "unauthenticated");
    assertRefused(await adminFn({ action: "suspend_user", userId: bystander.id }, extra), 401, "unauthenticated");
    assertEquals(await addressHasAccount(victim), false);
    assertEquals((await stored(bystander.id)).status, "active");
    assertEquals((await rpc("admin_list_users", {}, admin.token)).status, 200, "the admin's other session is untouched");
  });

  await t.step("master surface: suspend, activate, move and delete an admin", async () => {
    // First only the database half, to see what a suspended admin with a new session can do: nothing.
    const half = await rpc(
      "admin_set_user_status",
      { p_user_id: admin2.id, p_status: "suspended", p_surface: "master" },
      master.token,
    );
    assertEquals(half.status, 200, half.text);
    assertRpcRefused(await rpc("admin_list_users", {}, admin2.token), 401, "unauthenticated");
    const between = (await signIn(admin2.email, admin2.password)).body.access_token;
    assert(between, "Auth has not been told yet");
    assertRefused(
      await adminFn({ action: "invite_user", email: newAddress("unused"), role: "researcher" }, between),
      403,
      "account_suspended",
    );
    assertRpcRefused(await rpc("admin_list_users", {}, between), 403, "account_suspended");

    const suspended = await adminFn({ action: "suspend_user", surface: "master", userId: admin2.id }, master.token);
    assertEquals(suspended.status, 200, suspended.text);
    assertEquals((await signIn(admin2.email, admin2.password)).body.error_code, "user_banned");
    const suspendedRows = await audited(admin2.id, "master.admin_suspended");
    assert(suspendedRows.length >= 1);
    assertEquals(suspendedRows[0].actor_id, master.id);
    assertEquals((await audited(admin2.id, "admin.user_suspended")).length, 0, "recorded under the master surface's name");

    const activated = await adminFn({ action: "activate_user", surface: "master", userId: admin2.id }, master.token);
    assertEquals([activated.status, activated.body], [200, { ok: true }], activated.text);
    assertEquals((await audited(admin2.id, "master.admin_activated")).length, 1);
    await signInAs(admin2);
    assertEquals((await rpc("admin_list_users", {}, admin2.token)).status, 200);

    const newEmail = newAddress("admin2-moved");
    const moved = await adminFn({ action: "update_email", userId: admin2.id, email: newEmail }, master.token);
    assertEquals([moved.status, moved.body.user.email], [200, newEmail], moved.text);
    const [update] = await audited(admin2.id, "admin.user_updated");
    assertEquals([update.actor_id, update.after_data], [master.id, { email: newEmail }]);
    const oldEmail = admin2.email;
    admin2.email = newEmail;

    const deleted = await adminFn({ action: "delete_user", surface: "master", userId: admin2.id }, master.token);
    assertEquals([deleted.status, deleted.body], [200, { ok: true }], deleted.text);
    const [row] = await audited(admin2.id, "master.admin_deleted");
    assertEquals([row.actor_id, row.before_data], [master.id, { email: newEmail, role: "admin" }]);
    assertRefused(
      await adminFn({ action: "suspend_user", userId: bystander.id }, admin2.token),
      401,
      "unauthenticated",
      "the deleted admin's token",
    );
    assertEquals((await stored(bystander.id)).status, "active");
    assertEquals(await unreadMail(oldEmail), []);
  });

  await t.step("delete_user: gone for good, kept for the record, and the address is free again", async () => {
    const email = managed.email;
    const deleted = await adminFn({ action: "delete_user", userId: managed.id }, admin.token);
    assertEquals([deleted.status, deleted.body], [200, { ok: true }], deleted.text);

    assertRpcRefused(await rpc("my_profile", {}, managed.token), 401, "unauthenticated");
    assertRpcRefused(await rpc("list_my_projects", {}, managed.token), 401, "unauthenticated");
    // The token that outlived the account learns that it is gone, and no address.
    const gone = await rpc("my_account", {}, managed.token);
    assertEquals([gone.status, gone.body.status, gone.body.email], [200, "deleted", null]);
    assertEquals((await signIn(email, managed.password)).body.error_code, "invalid_credentials");

    const now = await stored(managed.id);
    assertEquals([now.status, now.email, now.auth_deleted, now.sessions], ["deleted", null, true, 0]);
    assertRpcRefused(await rpc("admin_get_user", { p_user_id: managed.id }, admin.token), 404, "not_found");
    const listed = await rpc("admin_list_users", { p_status: "deleted" }, admin.token);
    const entry = listed.body.users.find((u: { id: string }) => u.id === managed.id);
    assertEquals([entry.status, entry.email], ["deleted", ""]);

    const rows = await audited(managed.id, "admin.user_deleted");
    assertEquals(rows.length, 1);
    assertEquals([rows[0].actor_id, rows[0].before_data], [admin.id, { email, role: "researcher" }]);

    // Again, and every other action on it: nothing more happens.
    const again = await adminFn({ action: "delete_user", userId: managed.id }, admin.token);
    assertEquals([again.status, again.body], [200, { ok: true }]);
    assertEquals((await audited(managed.id, "admin.user_deleted")).length, 1);
    assertRefused(await adminFn({ action: "activate_user", userId: managed.id }, admin.token), 404, "not_found");
    assertRefused(await adminFn({ action: "suspend_user", userId: managed.id }, admin.token), 404, "not_found");

    // The address can register again, as a new account that inherits nothing.
    const password = newPassword();
    const reborn = await signUp(email, password);
    assertEquals(reborn.status, 200, reborn.text);
    const verified = await verifyCode("email", email, await nextCode(email, SUBJECT.confirmation));
    assertEquals(verified.status, 200, verified.text);
    track(verified.body.user.id);
    assertNotEquals(verified.body.user.id, managed.id);
    assertEquals((await rpc("list_my_projects", {}, verified.body.access_token)).body.projects, []);
  });

  await t.step("a delete that stopped half way is finished by running it again", async () => {
    const person = await newAccount("half-deleted");
    const half = await rpc("admin_soft_delete_user", { p_user_id: person.id }, admin.token);
    assertEquals(half.status, 200, half.text);
    assertRpcRefused(await rpc("my_profile", {}, person.token), 401, "unauthenticated");
    assertEquals((await stored(person.id)).auth_deleted, false);

    // Until Auth lets go of the address it cannot be given to anybody else.
    const early = await adminFn({ action: "invite_user", email: person.email, role: "researcher" }, admin.token);
    assertRefused(early, 409, "email_taken");

    const finished = await adminFn({ action: "delete_user", userId: person.id }, admin.token);
    assertEquals([finished.status, finished.body], [200, { ok: true }], finished.text);
    assertEquals((await stored(person.id)).auth_deleted, true);
    assertEquals((await audited(person.id, "admin.user_deleted")).length, 1);

    const invited = await adminFn({ action: "invite_user", email: person.email, role: "researcher" }, admin.token);
    assertEquals(invited.status, 201, invited.text);
    assertNotEquals(track(invited.body.user.id), person.id);
  });

  await t.step("two master admins suspending each other at the same moment: exactly one succeeds", async () => {
    const pair = [master, master2];
    for (let round = 0; round < 3; round++) {
      await Promise.all(pair.map((m) => signInAs(m)));
      const [a, b] = await Promise.all([
        adminFn({ action: "suspend_user", surface: "master", userId: master2.id }, master.token),
        adminFn({ action: "suspend_user", surface: "master", userId: master.id }, master2.token),
      ]);
      const outcome = [a, b].map((r) => `${r.status} ${r.body?.error ?? "ok"}`);
      assertEquals([a.status, b.status].filter((s) => s === 200).length, 1, `round ${round}: ${outcome}`);
      const loserReply = a.status === 200 ? b : a;
      assert(
        ["401 unauthenticated", "403 forbidden", "403 account_suspended"].includes(
          `${loserReply.status} ${loserReply.body?.error}`,
        ),
        `round ${round}: ${outcome}`,
      );

      const [winner, loser] = a.status === 200 ? [master, master2] : [master2, master];
      const states = [await stored(winner.id), await stored(loser.id)];
      assertEquals(states.map((s) => [s.status, s.banned]), [["active", false], ["suspended", true]], `round ${round}`);

      const restored = await adminFn({ action: "activate_user", surface: "master", userId: loser.id }, winner.token);
      assertEquals(restored.status, 200, restored.text);
    }
    await Promise.all(pair.map((m) => signInAs(m)));
  });

  await t.step("two master admins demoting each other at the same moment: exactly one succeeds", async () => {
    for (let round = 0; round < 3; round++) {
      const [a, b] = await Promise.all([
        rpc("master_set_role", { p_user_id: master2.id, p_role: "admin" }, master.token),
        rpc("master_set_role", { p_user_id: master.id, p_role: "admin" }, master2.token),
      ]);
      const outcome = [a, b].map((r) => `${r.status} ${r.body?.code ?? "ok"}`);
      assertEquals([a.status, b.status].filter((s) => s === 200).length, 1, `round ${round}: ${outcome}`);
      const loserReply = a.status === 200 ? b : a;
      // Refused because the caller is no longer a master admin, not because of the last-master guard.
      assertEquals(`${loserReply.status} ${loserReply.body?.code}`, "403 forbidden", `round ${round}: ${outcome}`);
      const [winner, loser] = a.status === 200 ? [master, master2] : [master2, master];
      assertEquals([(await stored(winner.id)).role, (await stored(loser.id)).role], ["master_admin", "admin"]);
      const restored = await rpc("master_set_role", { p_user_id: loser.id, p_role: "master_admin" }, winner.token);
      assertEquals(restored.status, 200, restored.text);
    }
  });

  await t.step("every change is in the audit log under the legacy action names", async () => {
    const log = await rpc("admin_list_audit", { p_limit: 1000 }, master.token);
    assertEquals(log.status, 200);
    const seen = new Set<string>(log.body.entries.map((e: { action: string }) => e.action));
    for (
      const action of [
        "auth.login",
        "auth.first_login_completed",
        "admin.user_created",
        "admin.user_updated",
        "admin.user_suspended",
        "admin.user_activated",
        "admin.sessions_revoked",
        "admin.user_deleted",
        "master.provisioned",
        "master.admin_created",
        "master.role_changed",
        "master.admin_suspended",
        "master.admin_activated",
        "master.admin_deleted",
      ]
    ) {
      assert(seen.has(action), `audit log has ${action}`);
    }
    // Readable by administrators only, through the function. The table itself is closed to everybody.
    assertRpcRefused(await rpc("admin_list_audit", {}, researcher.token), 403, "forbidden");
    assertEquals((await table("audit_log?select=id&limit=1", researcher.token)).status, 403);
    assertEquals((await table("audit_log?select=id&limit=1", master.token)).status, 403);

    // The log is read page by page, and what administrators did can be read on
    // its own, so no amount of sign-ins and profile edits can bury it.
    const first = await rpc("admin_list_audit", { p_limit: 5, p_kind: "admin" }, master.token);
    assertEquals([first.status, first.body.entries.length], [200, 5], first.text);
    assertEquals(typeof first.body.nextCursor, "string");
    const second = await rpc(
      "admin_list_audit",
      { p_limit: 5, p_kind: "admin", p_before: first.body.nextCursor },
      master.token,
    );
    assertEquals([second.status, second.body.entries.length], [200, 5], second.text);
    const pages = [...first.body.entries, ...second.body.entries] as { id: string; action: string; createdAt: number }[];
    assertEquals(new Set(pages.map((e) => e.id)).size, 10, "no entry is on both pages");
    assert(pages.every((e) => !e.action.startsWith("auth.")), "none of them is an account's own sign-in or edit");
    assert(pages.every((e, i) => i === 0 || e.createdAt <= pages[i - 1].createdAt), "newest first, across the pages");
    assertRpcRefused(await rpc("admin_list_audit", { p_before: "nonsense" }, master.token), 400, "invalid_input");
    // Nobody can write to it, not even the secret key.
    const forged = await request("POST", `${API_URL}/rest/v1/audit_log`, {
      token: master.token,
      body: { action: "admin.user_deleted", target_type: "user", target_id: bystander.id },
    });
    assert(forged.status >= 400, `insert as master admin: ${forged.status}`);
    const forgedWithSecret = await request("POST", `${API_URL}/rest/v1/audit_log`, {
      key: SECRET_KEY,
      body: { action: "admin.user_deleted", target_type: "user", target_id: bystander.id },
    });
    assert(forgedWithSecret.status >= 400, `insert with the secret key: ${forgedWithSecret.status}`);
  });

  await t.step("no answer of the function ever carried a token, a link, a password or a key", () => {
    assert(functionAnswers.length > 100, `${functionAnswers.length} answers were recorded`);
    for (const answer of functionAnswers) {
      assert(!answer.includes(SECRET_KEY), "the secret key");
      assert(!/sb_secret_|eyJ[A-Za-z0-9_-]{10,}\./.test(answer), `a key or token: ${answer.slice(0, 200)}`);
      assert(!/https?:\/\//i.test(answer), `a link: ${answer.slice(0, 200)}`);
      assert(
        !/"(access_token|refresh_token|token|action_link|hashed_token|email_otp|otp|password|temp_?password|confirmation_token|recovery_token)"/i
          .test(answer),
        `a credential field: ${answer.slice(0, 200)}`,
      );
    }
  });
});
