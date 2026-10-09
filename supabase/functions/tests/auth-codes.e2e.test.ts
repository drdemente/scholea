/**
 * Email flows with typed one-time codes, end to end on the local stack.
 *
 * The app has no router and the desktop app has no deep links, so every email
 * prints a code for the person to type and none contains a link. These tests
 * read the real emails from the local mail catcher and walk each flow the way
 * the app does: sign-up, password reset, invitation. They also pin the Auth
 * behaviours the app's sign-up screen depends on (see "pre-registration").
 *
 * Run with `pnpm test:supabase`. See helpers.ts.
 */
import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import {
  auditOf,
  auth,
  type Mail,
  mailCount,
  newAccount,
  newAddress,
  newPassword,
  nextCode,
  nextMail,
  removeEverything,
  rpc,
  SECRET_KEY,
  signIn,
  signUp,
  sleep,
  sql,
  SUBJECT,
  track,
  unreadMail,
  verifyCode,
  wrongCode,
} from "./helpers.ts";

Deno.test.afterAll(removeEverything);

/** A code to type, and nothing to click. */
function assertCodeOnly(mail: Mail) {
  assert(mail.code, "the email carries a code");
  assertMatch(mail.code, /^[0-9]{8}$/, "the code has the configured length");
  assert(!/https?:\/\//i.test(mail.text), "the text part contains no link");
  assert(!/href=|https?:\/\//i.test(mail.html), "the HTML part contains no link");
}

/** Auth sends at most one email per address per second on the local stack. */
const nextEmailAllowed = () => sleep(1100);

Deno.test("sign-up: the emailed code confirms the account and signs in", async () => {
  const email = newAddress("signup");
  const password = newPassword();

  const created = await signUp(email, password, { name: "Ada Lovelace", institution: "Analytical Society" });
  assertEquals(created.status, 200);
  assertEquals(created.body.access_token, undefined, "sign-up alone gives no session");
  track(created.body.id);

  const early = await signIn(email, password);
  assertEquals([early.status, early.body.error_code], [400, "email_not_confirmed"]);

  const mail = await nextMail(email, SUBJECT.confirmation);
  assertCodeOnly(mail);

  const verified = await verifyCode("email", email, mail.code!);
  assertEquals(verified.status, 200);
  assert(verified.body.access_token, "the code gives a session");
  assertEquals(verified.body.user.id, created.body.id);

  const me = await rpc("my_profile", {}, verified.body.access_token);
  assertEquals(me.status, 200);
  assertEquals(me.body.user, {
    id: created.body.id,
    email,
    name: "Ada Lovelace",
    institution: "Analytical Society",
    role: "researcher",
    status: "active",
    mustResetPassword: false,
    lastLoginAt: me.body.user.lastLoginAt,
    createdAt: me.body.user.createdAt,
    emailConfirmed: true,
  });
  assertEquals(typeof me.body.user.lastLoginAt, "number");

  const again = await verifyCode("email", email, mail.code!);
  assertEquals([again.status, again.body.error_code], [403, "otp_expired"], "a code works once");

  assertEquals((await signIn(email, password)).status, 200);
});

Deno.test("sign-up: a role in the sign-up data is ignored", async () => {
  const email = newAddress("signup-role");
  const created = await signUp(email, newPassword(), { name: "Mallory", role: "master_admin", status: "active" });
  assertEquals(created.status, 200);
  track(created.body.id);
  const verified = await verifyCode("email", email, await nextCode(email, SUBJECT.confirmation));
  const me = await rpc("my_profile", {}, verified.body.access_token);
  assertEquals(me.body.user.role, "researcher");
});

Deno.test("sign-up: a wrong code is refused and confirms nothing", async () => {
  const email = newAddress("wrong-code");
  const password = newPassword();
  const created = await signUp(email, password);
  track(created.body.id);
  const code = await nextCode(email, SUBJECT.confirmation);

  const wrong = await verifyCode("email", email, wrongCode(code));
  assertEquals([wrong.status, wrong.body.error_code], [403, "otp_expired"]);
  assertEquals(wrong.body.access_token, undefined);

  const still = await signIn(email, password);
  assertEquals(still.body.error_code, "email_not_confirmed");

  // The right code for another kind of email is refused too.
  const asRecovery = await verifyCode("recovery", email, code);
  assertEquals(asRecovery.status, 403);

  assertEquals((await verifyCode("email", email, code)).status, 200, "the right code still works afterwards");
});

Deno.test("sign-up: asking for the code again replaces the earlier code", async () => {
  const email = newAddress("resend");
  const created = await signUp(email, newPassword());
  track(created.body.id);
  const first = await nextCode(email, SUBJECT.confirmation);

  await nextEmailAllowed();
  const resent = await auth("POST", "/resend", { body: { type: "signup", email } });
  assertEquals(resent.status, 200);
  const second = await nextCode(email, SUBJECT.confirmation);
  assertNotEquals(second, first);

  const old = await verifyCode("email", email, first);
  assertEquals([old.status, old.body.error_code], [403, "otp_expired"], "the superseded code is refused");
  assertEquals((await verifyCode("email", email, second)).status, 200);
});

Deno.test("sign-up with an address that already has an account changes nothing, sends no email and says no error", async () => {
  // What this protects is the owner of the address: their account, password and
  // name stay as they are, and they are not bothered with an email. It does NOT
  // hide that the address is registered: the placeholder Auth answers with can
  // be told from a new account (see "known limits" at the end of this file).
  const owner = await newAccount("taken", "Real Owner");
  const before = await mailCount(owner.email);
  const otherPassword = newPassword();

  const again = await signUp(owner.email, otherPassword, { name: "Somebody Else" });
  assertEquals(again.status, 200, "no error is shown");
  assertEquals(again.body.access_token, undefined);
  assertEquals(again.body.identities, [], "a placeholder user, not the real one");
  assertNotEquals(again.body.id, owner.id);

  // Auth sends its emails before it answers, so an email would be here by now.
  // Asking for a reset next proves it: the very next email is the reset code.
  assertEquals(await unreadMail(owner.email), []);
  await nextEmailAllowed();
  assertEquals((await auth("POST", "/recover", { body: { email: owner.email } })).status, 200);
  await nextMail(owner.email, SUBJECT.recovery);
  assertEquals(await mailCount(owner.email), before + 1);

  assertEquals((await signIn(owner.email, owner.password)).status, 200, "the owner's password still works");
  assertEquals((await signIn(owner.email, otherPassword)).body.error_code, "invalid_credentials");
  const me = await rpc("my_profile", {}, owner.token);
  assertEquals(me.body.user.name, "Real Owner");
});

Deno.test("password reset: code, then a new password; the old one stops working", async () => {
  const user = await newAccount("recovery");
  const fresh = newPassword();

  await nextEmailAllowed();
  const asked = await auth("POST", "/recover", { body: { email: user.email } });
  assertEquals([asked.status, asked.body], [200, {}]);
  const mail = await nextMail(user.email, SUBJECT.recovery);
  assertCodeOnly(mail);

  const wrong = await verifyCode("recovery", user.email, wrongCode(mail.code!));
  assertEquals([wrong.status, wrong.body.error_code], [403, "otp_expired"]);

  const verified = await verifyCode("recovery", user.email, mail.code!);
  assertEquals(verified.status, 200);
  const changed = await auth("PUT", "/user", { token: verified.body.access_token, body: { password: fresh } });
  assertEquals(changed.status, 200);

  assertEquals((await signIn(user.email, user.password)).body.error_code, "invalid_credentials");
  assertEquals((await signIn(user.email, fresh)).status, 200);

  // The owner of the address is told, in an email without a code.
  const notice = await nextMail(user.email, SUBJECT.passwordChanged);
  assertEquals(notice.code, null);
  assert(!/https?:\/\//i.test(notice.text + notice.html));

  const actions = (await auditOf(user.id)).map((row) => row.action);
  assert(actions.includes("auth.password_changed"), `audit has auth.password_changed: ${actions}`);
});

Deno.test("password reset for an unknown address answers the same and sends nothing", async () => {
  const nobody = newAddress("nobody");
  const asked = await auth("POST", "/recover", { body: { email: nobody } });
  assertEquals([asked.status, asked.body], [200, {}]);
  await sleep(500);
  assertEquals(await mailCount(nobody), 0);
});

Deno.test("invitation: code, then a password, and no data access in between", async () => {
  // The admin function's own invitation is tested in admin.e2e.test.ts. This
  // is the Auth half alone: an invited account exists without a password.
  const email = newAddress("invited");
  const invited = await auth("POST", "/invite", { key: SECRET_KEY, body: { email } });
  assertEquals(invited.status, 200);
  const id = track(invited.body.id);
  const [stored] = await sql<{ no_password: boolean; confirmed: boolean }>(
    "select coalesce(encrypted_password, '') = '' as no_password, email_confirmed_at is not null as confirmed from auth.users where id = $1",
    [id],
  );
  assertEquals(stored, { no_password: true, confirmed: false });

  const mail = await nextMail(email, SUBJECT.invite);
  assertCodeOnly(mail);

  const wrong = await verifyCode("invite", email, wrongCode(mail.code!));
  assertEquals([wrong.status, wrong.body.error_code], [403, "otp_expired"]);

  const verified = await verifyCode("invite", email, mail.code!);
  assertEquals(verified.status, 200);
  const token = verified.body.access_token;

  const me = await rpc("my_profile", {}, token);
  assertEquals([me.status, me.body.user.mustResetPassword, me.body.user.emailConfirmed], [200, true, true]);
  const blocked = await rpc("list_my_projects", {}, token);
  assertEquals([blocked.status, blocked.body.code], [403, "password_reset_required"]);

  const set = await auth("PUT", "/user", { token, body: { password: newPassword() } });
  assertEquals(set.status, 200);
  const after = await rpc("my_profile", {}, token);
  assertEquals(after.body.user.mustResetPassword, false);
  assertEquals((await rpc("list_my_projects", {}, token)).status, 200);

  const actions = (await auditOf(id)).map((row) => row.action);
  assert(actions.includes("auth.first_login_completed"), `audit has auth.first_login_completed: ${actions}`);
});

Deno.test("pre-registration: whoever signed up first with someone's address does not get in", async () => {
  // Auth keeps the FIRST password and the FIRST name when an address is signed
  // up twice before it is confirmed. So a stranger can sign up with a victim's
  // address, wait for the victim to sign up and confirm, and then sign in.
  // The app closes this itself, right after the code is accepted, by setting
  // the password and the name the person typed on this device.
  const email = newAddress("prereg");
  const strangerPassword = newPassword();
  const ownerPassword = newPassword();

  const first = await signUp(email, strangerPassword, { name: "Stranger" });
  assertEquals(first.status, 200);
  track(first.body.id);
  const strangerCode = await nextCode(email, SUBJECT.confirmation);

  await nextEmailAllowed();
  const second = await signUp(email, ownerPassword, { name: "Rightful Owner" });
  assertEquals(second.status, 200, "the second sign-up looks like a first one");
  assertEquals(second.body.id, first.body.id, "it is the same unconfirmed account");
  const ownerCode = await nextCode(email, SUBJECT.confirmation);

  const stale = await verifyCode("email", email, strangerCode);
  assertEquals(stale.status, 403, "the stranger's code died when the owner asked for theirs");

  const verified = await verifyCode("email", email, ownerCode);
  assertEquals(verified.status, 200);
  const token = verified.body.access_token;

  // The hole, as Auth leaves it. If this ever stops being true the fix below
  // is still harmless.
  assertEquals((await signIn(email, strangerPassword)).status, 200, "the stranger's password works at this point");
  assertEquals((await signIn(email, ownerPassword)).body.error_code, "invalid_credentials");
  assertEquals((await rpc("my_profile", {}, token)).body.user.name, "Stranger");

  // The app's fix, step 1: set the password that was typed on this device.
  const fixed = await auth("PUT", "/user", {
    token,
    body: { password: ownerPassword, current_password: ownerPassword },
  });
  assertEquals(fixed.status, 200);
  // Step 2: set the name that was typed on this device.
  const named = await rpc("update_my_profile", { p_name: "Rightful Owner" }, token);
  assertEquals([named.status, named.body.user.name], [200, "Rightful Owner"]);

  assertEquals((await signIn(email, strangerPassword)).body.error_code, "invalid_credentials", "the stranger is out");
  assertEquals((await signIn(email, ownerPassword)).status, 200);
});

Deno.test("pre-registration, when the password cannot be set directly: a reset code closes it too", async () => {
  // A hosted project can require the current password for a password change.
  // The owner does not know the stranger's password, so the app then sends a
  // reset code and lets the owner choose the password with that.
  const email = newAddress("prereg-reset");
  const strangerPassword = newPassword();
  const ownerPassword = newPassword();

  const first = await signUp(email, strangerPassword, { name: "Stranger" });
  track(first.body.id);
  await nextCode(email, SUBJECT.confirmation);
  await nextEmailAllowed();
  assertEquals((await signUp(email, ownerPassword, { name: "Rightful Owner" })).status, 200);
  const verified = await verifyCode("email", email, await nextCode(email, SUBJECT.confirmation));
  assertEquals(verified.status, 200);

  await nextEmailAllowed();
  assertEquals((await auth("POST", "/recover", { body: { email } })).status, 200);
  const recovered = await verifyCode("recovery", email, await nextCode(email, SUBJECT.recovery));
  assertEquals(recovered.status, 200);
  const set = await auth("PUT", "/user", { token: recovered.body.access_token, body: { password: ownerPassword } });
  assertEquals(set.status, 200);

  assertEquals((await signIn(email, strangerPassword)).body.error_code, "invalid_credentials", "the stranger is out");
  assertEquals((await signIn(email, ownerPassword)).status, 200);
});

Deno.test("pre-registration fix on an ordinary sign-up: same_password, which the app treats as success", async () => {
  const user = await newAccount("prereg-normal");
  const fixed = await auth("PUT", "/user", {
    token: user.token,
    body: { password: user.password, current_password: user.password },
  });
  assertEquals([fixed.status, fixed.body.error_code], [422, "same_password"]);
  assertEquals((await signIn(user.email, user.password)).status, 200);
});

Deno.test("known limits: Auth's public endpoints can tell a registered address from an unregistered one", async () => {
  // Scholea's own functions never say whether an address has an account: a
  // project invitation answers the same either way, and the admin functions
  // answer "forbidden" before they look. Supabase Auth is less discreet, in
  // ways the database cannot change. They are written down here so that nobody
  // relies on the opposite, and so that a change in Auth is noticed. A hosted
  // project keeps Auth's default rate limits, which slow this down. CAPTCHA
  // would do more, but it has to stay off until the app sends a CAPTCHA token:
  // with it on, Auth refuses every sign-up, password sign-in and reset request
  // that carries none (docs/deployment.md, section 4).
  const owner = await newAccount("known", "Known Person");
  const unknown = newAddress("unknown");

  // 1. A sign-in code can be asked for an existing account only. Auth has no
  //    switch to turn this endpoint off.
  await nextEmailAllowed();
  const forOwner = await auth("POST", "/otp", { body: { email: owner.email, create_user: false } });
  const forNobody = await auth("POST", "/otp", { body: { email: unknown, create_user: false } });
  assertEquals([forOwner.status, forNobody.status, forNobody.body.error_code], [200, 422, "otp_disabled"]);
  // At least the owner hears of it: they are sent a code they did not ask for.
  await nextMail(owner.email, SUBJECT.signIn);

  // 2. A signed-in person who asks to change their own address to a taken one is told that it is taken.
  const prober = await newAccount("prober");
  const taken = await auth("PUT", "/user", { token: prober.token, body: { email: owner.email } });
  const free = await auth("PUT", "/user", { token: prober.token, body: { email: newAddress("free") } });
  assertEquals([taken.status, taken.body.error_code, free.status], [422, "email_exists", 200]);
  assertEquals(await unreadMail(owner.email), [], "and the owner of the taken address is not told");

  // 3. Sign-up answers with a placeholder that has no identity for a confirmed
  //    address, and with one identity for a new address.
  const again = await signUp(owner.email, newPassword());
  const fresh = await signUp(unknown, newPassword());
  track(fresh.body.id);
  assertEquals([again.body.identities.length, fresh.body.identities.length], [0, 1]);

  // 4. A suspended account answers "banned" to any password (admin.e2e.test.ts
  //    asserts user_banned), so a suspension can be seen from outside.
});
