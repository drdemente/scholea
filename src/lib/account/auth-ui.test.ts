import { describe, expect, it } from "vitest";
import { SyncError } from "@/lib/supabase/errors";
import { EMAIL_BUSY_MESSAGE, RESEND_COOLDOWN_MS, SECURITY_RESET_MESSAGE, describeAuthError, type AuthStep } from "./auth-flow";
import {
  CODE_SENT_MESSAGE,
  SECURITY_RESET_UNSENT_MESSAGE,
  createAuthUi,
  isMidway,
  owesPassword,
  passwordFields,
  pendingInputOf,
  type AuthSession,
  type PendingInput,
} from "./auth-ui";

// The account screens' store driven with a hand-written session: every call is
// recorded, and each can be made to fail or to wait.

const NOW = 5_000_000;
const EMAIL = "ada@example.test";
const CODE = "12345678";

// No fixed password is kept in the repo: these are made up afresh on every run.
const makePassword = () => `pw-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
const PASSWORD = makePassword();
const OTHER_PASSWORD = makePassword();

const err = (code: string, status = 400) => new SyncError(status, code);

type Call = [name: keyof AuthSession, ...args: unknown[]];

function setup() {
  const calls: Call[] = [];
  /** Errors to answer with, per action, first in first out. */
  const fail: Partial<Record<keyof AuthSession, unknown[]>> = {};
  /** An action listed here does not answer until the promise resolves. */
  const hold: Partial<Record<keyof AuthSession, Promise<void>>> = {};
  const answers = { signUp: "confirm" as "confirm" | "signedIn" };

  const act = async (name: keyof AuthSession, ...args: unknown[]): Promise<void> => {
    calls.push([name, ...args]);
    await hold[name];
    const queue = fail[name];
    if (queue && queue.length > 0) throw queue.shift();
  };

  const session: AuthSession = {
    signIn: (email, password) => act("signIn", email, password),
    signUp: async (input) => {
      await act("signUp", input);
      return answers.signUp;
    },
    confirmSignUp: (email, code) => act("confirmSignUp", email, code),
    resendSignUpCode: (email) => act("resendSignUpCode", email),
    requestPasswordReset: (email) => act("requestPasswordReset", email),
    verifyEmailCode: (email, code, kind) => act("verifyEmailCode", email, code, kind),
    setPassword: (next) => act("setPassword", next),
    securePassword: (password) => act("securePassword", password),
    updateMyProfile: (patch) => act("updateMyProfile", patch),
    signOut: () => act("signOut"),
  };

  const clock = { now: NOW };
  const store = createAuthUi({ session, now: () => clock.now });
  return {
    store,
    ui: () => store.getState(),
    calls,
    names: () => calls.map((c) => c[0]),
    fail,
    hold,
    answers,
    clock,
    /** Put the screens on a given step, as if the person had got there. */
    at: (flow: AuthStep) => store.setState({ flow, open: true }),
  };
}

const confirmStep: AuthStep = { step: "confirm", email: EMAIL, name: "Ada", resendAt: NOW + RESEND_COOLDOWN_MS };
const recoveryStep: AuthStep = { step: "reset", email: EMAIL, name: "", kind: "recovery", resendAt: NOW + RESEND_COOLDOWN_MS, reason: "requested" };
const inviteStep: AuthStep = { step: "reset", email: "", name: "", kind: "invite", resendAt: 0, reason: "requested" };
const securityStep: AuthStep = { step: "reset", email: EMAIL, name: "Ada", kind: "recovery", resendAt: NOW + RESEND_COOLDOWN_MS, reason: "security" };

describe("sign in", () => {
  it("asks for an email and a password before making any request", async () => {
    const t = setup();
    const result = await t.ui().signIn({ email: " ", password: "" });
    expect(result).toEqual({ ok: false, fields: { email: "Enter your email address.", password: "Enter your password." } });
    expect(t.calls).toEqual([]);
  });

  it("signs in with the tidied address, ends the flow and closes the dialog", async () => {
    const t = setup();
    t.ui().openAccount("signIn");
    expect(await t.ui().signIn({ email: "  Ada@Example.test ", password: PASSWORD })).toEqual({ ok: true });
    expect(t.calls).toEqual([["signIn", EMAIL, PASSWORD]]);
    expect(t.ui().finished).toEqual({ id: expect.any(Number), outcome: "signedIn" });
    expect(t.ui().open).toBe(false);
    expect(t.ui().flow).toEqual({ step: "signIn", email: "" });
    expect(t.ui().busy).toBe(false);
  });

  it("shows one message for a wrong email or password and stays on the form", async () => {
    const t = setup();
    t.ui().openAccount("signIn");
    t.fail.signIn = [err("invalid_credentials")];
    expect(await t.ui().signIn({ email: EMAIL, password: PASSWORD })).toEqual({ ok: false });
    expect(t.ui().error).toBe("Email or password is incorrect.");
    expect(t.ui().flow.step).toBe("signIn");
    expect(t.ui().open).toBe(true);
    expect(t.ui().finished).toBeNull();
    expect(t.ui().busy).toBe(false);
  });

  it("an unconfirmed address gets a fresh code and the code step, with a note saying so", async () => {
    const t = setup();
    t.fail.signIn = [err("email_not_confirmed")];
    await t.ui().signIn({ email: EMAIL, password: PASSWORD });
    expect(t.ui().flow).toEqual({ step: "confirm", email: EMAIL, name: "", resendAt: NOW + RESEND_COOLDOWN_MS });
    expect(t.calls).toEqual([
      ["signIn", EMAIL, PASSWORD],
      ["resendSignUpCode", EMAIL],
    ]);
    expect(t.ui().notice).toBe("Confirm your email to finish signing in. We've sent you a new code.");
    expect(t.ui().error).toBeNull();
  });

  it("when that code could not be sent, says why instead of claiming it was", async () => {
    const t = setup();
    t.fail.signIn = [err("email_not_confirmed")];
    t.fail.resendSignUpCode = [err("network", 0)];
    await t.ui().signIn({ email: EMAIL, password: PASSWORD });
    expect(t.ui().flow.step).toBe("confirm");
    expect(t.ui().notice).toBeNull();
    expect(t.ui().error).toBe(describeAuthError(err("network", 0)));
  });

  it("a code sent moments ago still counts as sent", async () => {
    const t = setup();
    // The person has just signed up here (a code went out), then tries to sign in instead.
    t.ui().openAccount("signUp");
    await t.ui().signUp({ name: "Ada", email: EMAIL, password: PASSWORD, confirm: PASSWORD });
    t.ui().show("signIn", EMAIL);
    t.fail.signIn = [err("email_not_confirmed")];
    t.fail.resendSignUpCode = [err("email_rate_limited", 429)];
    await t.ui().signIn({ email: EMAIL, password: PASSWORD });
    expect(t.ui().error).toBeNull();
    expect(t.ui().notice).toMatch(/sent you a new code/);
  });

  it("a new attempt clears the previous attempt's error straight away", async () => {
    const t = setup();
    t.fail.signIn = [err("invalid_credentials")];
    await t.ui().signIn({ email: EMAIL, password: PASSWORD });
    expect(t.ui().error).not.toBeNull();

    let release = () => {};
    t.hold.signIn = new Promise<void>((resolve) => (release = resolve));
    const second = t.ui().signIn({ email: EMAIL, password: PASSWORD });
    expect(t.ui().busy).toBe(true);
    expect(t.ui().error).toBeNull();
    release();
    await second;
  });

  it("runs one action at a time", async () => {
    const t = setup();
    let release = () => {};
    t.hold.signIn = new Promise<void>((resolve) => (release = resolve));
    const first = t.ui().signIn({ email: EMAIL, password: PASSWORD });
    expect(t.ui().busy).toBe(true);
    expect(await t.ui().signIn({ email: EMAIL, password: PASSWORD })).toEqual({ ok: false });
    t.ui().show("signUp");
    expect(t.ui().flow.step).toBe("signIn");
    release();
    await first;
    expect(t.names()).toEqual(["signIn"]);
    expect(t.ui().busy).toBe(false);
  });
});

describe("create an account", () => {
  it("puts each problem under its own field", async () => {
    const t = setup();
    t.ui().openAccount("signUp");
    const short = await t.ui().signUp({ name: " ", email: "nope", password: "short", confirm: "short" });
    expect(short).toEqual({
      ok: false,
      fields: { name: "Enter your name.", email: "Enter a valid email address.", password: "Use at least 10 characters." },
    });
    const mismatch = await t.ui().signUp({ name: "Ada", email: EMAIL, password: PASSWORD, confirm: OTHER_PASSWORD });
    expect(mismatch).toEqual({ ok: false, fields: { confirm: "Passwords don't match." } });
    expect(t.calls).toEqual([]);
  });

  it("moves to the code step and starts the wait before another code", async () => {
    const t = setup();
    t.ui().openAccount("signUp");
    expect(await t.ui().signUp({ name: " Ada ", email: " Ada@example.test", password: PASSWORD, confirm: PASSWORD })).toEqual({ ok: true });
    expect(t.calls).toEqual([["signUp", { name: "Ada", email: EMAIL, password: PASSWORD }]]);
    expect(t.ui().flow).toEqual(confirmStep);
    expect(t.ui().open).toBe(true);
  });

  it("is done at once when the server needs no confirmation", async () => {
    const t = setup();
    t.ui().openAccount("signUp");
    t.answers.signUp = "signedIn";
    await t.ui().signUp({ name: "Ada", email: EMAIL, password: PASSWORD, confirm: PASSWORD });
    expect(t.ui().finished?.outcome).toBe("accountCreated");
    expect(t.ui().open).toBe(false);
  });

  it("shows why the server refused", async () => {
    const t = setup();
    t.ui().openAccount("signUp");
    t.fail.signUp = [err("signup_disabled", 422)];
    await t.ui().signUp({ name: "Ada", email: EMAIL, password: PASSWORD, confirm: PASSWORD });
    expect(t.ui().flow.step).toBe("signUp");
    expect(t.ui().error).toBe("New sign-ups are turned off on this server. Ask an administrator for an invitation.");
  });
});

describe("the confirmation code", () => {
  it("refuses something that is not a code without a request", async () => {
    const t = setup();
    t.at(confirmStep);
    const result = await t.ui().confirm({ code: "12ab", password: PASSWORD });
    expect(result).toEqual({ ok: false, fields: { code: expect.stringContaining("doesn't look like the code") } });
    expect(t.calls).toEqual([]);
  });

  it("a wrong code keeps the person on the step with the shared code message", async () => {
    const t = setup();
    t.at(confirmStep);
    t.fail.confirmSignUp = [err("code_invalid", 403)];
    await t.ui().confirm({ code: CODE, password: PASSWORD });
    expect(t.ui().flow).toEqual(confirmStep);
    expect(t.ui().error).toBe("That code is incorrect or has expired. Check it, or send a new one.");
    expect(t.names()).toEqual(["confirmSignUp"]);
  });

  it("confirms, makes the typed password the account's, saves the typed name, and ends", async () => {
    const t = setup();
    t.at(confirmStep);
    expect(await t.ui().confirm({ code: " 1234 5678 ", password: PASSWORD })).toEqual({ ok: true });
    expect(t.calls).toEqual([
      ["confirmSignUp", EMAIL, CODE],
      ["securePassword", PASSWORD],
      ["updateMyProfile", { name: "Ada", institution: "" }],
    ]);
    expect(t.ui().finished?.outcome).toBe("accountCreated");
    expect(t.ui().open).toBe(false);
    expect(t.ui().flow).toEqual({ step: "signIn", email: "" });
    expect(t.ui().error).toBeNull();
  });

  it("shows the securing step while the password is being set", async () => {
    const t = setup();
    t.at(confirmStep);
    let release = () => {};
    t.hold.securePassword = new Promise<void>((resolve) => (release = resolve));
    const done = t.ui().confirm({ code: CODE, password: PASSWORD });
    await Promise.resolve();
    await Promise.resolve();
    expect(t.ui().flow).toEqual({ step: "securing", email: EMAIL, name: "Ada" });
    expect(t.ui().busy).toBe(true);
    release();
    await done;
    expect(t.ui().finished?.outcome).toBe("accountCreated");
  });

  it("a name that could not be saved is not an error", async () => {
    const t = setup();
    t.at(confirmStep);
    t.fail.updateMyProfile = [err("rate_limited", 429)];
    await t.ui().confirm({ code: CODE, password: PASSWORD });
    expect(t.ui().finished?.outcome).toBe("accountCreated");
    expect(t.ui().error).toBeNull();
  });

  it("asks for a password again when the typed one is gone (the dialog was closed in between)", async () => {
    const t = setup();
    t.at(confirmStep);
    for (const password of [null, ""]) {
      t.at(confirmStep);
      await t.ui().confirm({ code: CODE, password });
      expect(t.ui().flow).toEqual({ step: "setPassword", email: EMAIL, name: "Ada", via: "secure" });
    }
    expect(t.names()).toEqual(["confirmSignUp", "confirmSignUp"]);
    expect(t.ui().open).toBe(true);
    expect(t.ui().finished).toBeNull();
  });

  it("falls back to a recovery code when the server will not take the typed password", async () => {
    const t = setup();
    t.at(confirmStep);
    t.fail.securePassword = [err("invalid_credentials")];
    await t.ui().confirm({ code: CODE, password: PASSWORD });
    expect(t.ui().flow).toEqual(securityStep);
    expect(t.calls).toEqual([
      ["confirmSignUp", EMAIL, CODE],
      ["securePassword", PASSWORD],
      ["requestPasswordReset", EMAIL],
    ]);
    expect(t.ui().notice).toBe(SECURITY_RESET_MESSAGE);
    expect(t.ui().error).toBeNull();
    expect(t.ui().open).toBe(true);
  });

  it("does not claim a recovery code was sent when it was refused", async () => {
    const t = setup();
    // The sign-up code went to this address a moment ago, which is why the server refuses another email.
    t.ui().openAccount("signUp");
    await t.ui().signUp({ name: "Ada", email: EMAIL, password: PASSWORD, confirm: PASSWORD });
    t.fail.securePassword = [err("invalid_credentials")];
    t.fail.requestPasswordReset = [err("email_rate_limited", 429)];
    await t.ui().confirm({ code: CODE, password: PASSWORD });
    expect(t.ui().flow).toEqual(securityStep);
    expect(t.ui().notice).toBe(SECURITY_RESET_UNSENT_MESSAGE);
    expect(t.ui().error).toBe("We've emailed this address recently. Wait a minute, then try again.");
  });

  it("nor does it blame an email of its own when it sent none to that address", async () => {
    const t = setup();
    t.at(confirmStep);
    t.fail.securePassword = [err("invalid_credentials")];
    t.fail.requestPasswordReset = [err("email_rate_limited", 429)];
    await t.ui().confirm({ code: CODE, password: PASSWORD });
    expect(t.ui().flow).toEqual(securityStep);
    expect(t.ui().notice).toBe(SECURITY_RESET_UNSENT_MESSAGE);
    expect(t.ui().error).toBe(EMAIL_BUSY_MESSAGE);
  });

  it("when setting the password fails for another reason, asks for it by hand and says why", async () => {
    const t = setup();
    t.at(confirmStep);
    t.fail.securePassword = [err("network", 0)];
    await t.ui().confirm({ code: CODE, password: PASSWORD });
    expect(t.ui().flow).toEqual({ step: "setPassword", email: EMAIL, name: "Ada", via: "secure" });
    expect(t.ui().error).toBe(describeAuthError(err("network", 0)));
    expect(t.names()).toEqual(["confirmSignUp", "securePassword"]);
  });

  it("goes back to the sign-up form for a different email, keeping the name", () => {
    const t = setup();
    t.at(confirmStep);
    t.ui().useDifferentEmail();
    expect(t.ui().flow).toEqual({ step: "signUp", name: "Ada", email: EMAIL });
  });
});

describe("sending a code again", () => {
  it("does nothing while the wait is running", async () => {
    const t = setup();
    t.at(confirmStep);
    expect(await t.ui().resendCode()).toEqual({ ok: false });
    t.clock.now = NOW + RESEND_COOLDOWN_MS - 1;
    expect(await t.ui().resendCode()).toEqual({ ok: false });
    expect(t.calls).toEqual([]);
  });

  it("sends, restarts the wait and announces it; every send is announced anew", async () => {
    const t = setup();
    t.at(confirmStep);
    t.clock.now = NOW + RESEND_COOLDOWN_MS;
    expect(await t.ui().resendCode()).toEqual({ ok: true });
    expect(t.calls).toEqual([["resendSignUpCode", EMAIL]]);
    expect(t.ui().flow).toEqual({ ...confirmStep, resendAt: t.clock.now + RESEND_COOLDOWN_MS });
    const first = t.ui().sent;
    expect(first?.text).toBe(CODE_SENT_MESSAGE);

    t.clock.now += RESEND_COOLDOWN_MS;
    await t.ui().resendCode();
    expect(t.ui().sent?.text).toBe(CODE_SENT_MESSAGE);
    expect(t.ui().sent?.id).not.toBe(first?.id);
  });

  it("a refusal for sending too often restarts the wait and is shown, not announced as sent", async () => {
    const t = setup();
    t.at(confirmStep);
    t.clock.now = NOW + RESEND_COOLDOWN_MS;
    t.fail.resendSignUpCode = [err("email_rate_limited", 429)];
    expect(await t.ui().resendCode()).toEqual({ ok: false });
    expect(t.ui().flow).toEqual({ ...confirmStep, resendAt: t.clock.now + RESEND_COOLDOWN_MS });
    // The wait since this device's last request is over, so the refusal is not about that request.
    expect(t.ui().error).toBe(EMAIL_BUSY_MESSAGE);
    expect(t.ui().sent).toBeNull();
  });

  it("any other failure leaves the wait alone", async () => {
    const t = setup();
    t.at(confirmStep);
    t.clock.now = NOW + RESEND_COOLDOWN_MS;
    t.fail.resendSignUpCode = [err("server_error", 500)];
    await t.ui().resendCode();
    expect(t.ui().flow).toEqual(confirmStep);
    expect(t.ui().error).toBe("Something went wrong on our side. Try again in a moment.");
    expect(t.ui().sent).toBeNull();
  });

  it("on the reset step asks for a recovery code, to the address the step is for, once the wait is over", async () => {
    const t = setup();
    t.at(recoveryStep);
    expect(await t.ui().resendCode()).toEqual({ ok: false });
    expect(t.calls).toEqual([]);

    t.clock.now = NOW + RESEND_COOLDOWN_MS;
    // Only the invitation form has an address field; anything passed here is ignored.
    await t.ui().resendCode("someone-else@example.test");
    expect(t.calls).toEqual([["requestPasswordReset", EMAIL]]);
    expect(t.ui().flow).toEqual({ ...recoveryStep, resendAt: t.clock.now + RESEND_COOLDOWN_MS });
    expect(t.ui().sent?.text).toBe(CODE_SENT_MESSAGE);
    expect(t.ui().notice).toBeNull();
  });

  it("on the security reset step the note says a code was really sent, or that it was not", async () => {
    const t = setup();
    t.at(securityStep);
    t.clock.now = NOW + RESEND_COOLDOWN_MS;
    await t.ui().resendCode();
    expect(t.ui().notice).toBe(SECURITY_RESET_MESSAGE);
    expect(t.ui().sent?.text).toBe(CODE_SENT_MESSAGE);

    t.clock.now += RESEND_COOLDOWN_MS;
    t.fail.requestPasswordReset = [err("email_rate_limited", 429)];
    await t.ui().resendCode();
    expect(t.ui().notice).toBe(SECURITY_RESET_UNSENT_MESSAGE);
    expect(t.ui().sent).toBeNull();
    expect(t.ui().flow).toEqual({ ...securityStep, resendAt: t.clock.now + RESEND_COOLDOWN_MS });
  });

  it("on the invitation form needs the typed address, then waits for a recovery code to it", async () => {
    const t = setup();
    t.at(inviteStep);
    expect(await t.ui().resendCode("not-an-address")).toEqual({ ok: false, fields: { email: "Enter a valid email address." } });
    expect(t.calls).toEqual([]);

    expect(await t.ui().resendCode(" Grace@Example.test ")).toEqual({ ok: true });
    expect(t.calls).toEqual([["requestPasswordReset", "grace@example.test"]]);
    expect(t.ui().flow).toEqual({
      step: "reset",
      email: "grace@example.test",
      name: "",
      kind: "recovery",
      resendAt: NOW + RESEND_COOLDOWN_MS,
      reason: "requested",
    });
  });

  it("on the invitation form a refusal keeps it an invitation form", async () => {
    const t = setup();
    t.at(inviteStep);
    t.fail.requestPasswordReset = [err("email_rate_limited", 429)];
    expect(await t.ui().resendCode("grace@example.test")).toEqual({ ok: false });
    expect(t.ui().flow).toMatchObject({ step: "reset", kind: "invite", email: "grace@example.test", resendAt: 0 });
    expect(t.ui().error).toBe(EMAIL_BUSY_MESSAGE);
  });

  it("does nothing on a step that has no code", async () => {
    const t = setup();
    expect(await t.ui().resendCode()).toEqual({ ok: false });
    expect(t.calls).toEqual([]);
  });
});

describe("forgot password", () => {
  it("needs a valid address", async () => {
    const t = setup();
    t.ui().show("forgot");
    expect(await t.ui().forgot({ email: "ada" })).toEqual({ ok: false, fields: { email: "Enter a valid email address." } });
    expect(t.calls).toEqual([]);
  });

  it("asks for a code and moves on", async () => {
    const t = setup();
    t.ui().show("forgot");
    await t.ui().forgot({ email: " ADA@example.test " });
    expect(t.calls).toEqual([["requestPasswordReset", EMAIL]]);
    expect(t.ui().flow).toEqual(recoveryStep);
  });

  it("moves on as well when this device had a code sent less than a minute ago", async () => {
    const t = setup();
    t.ui().show("forgot");
    await t.ui().forgot({ email: EMAIL });
    t.ui().show("forgot");
    t.fail.requestPasswordReset = [err("email_rate_limited", 429)];
    await t.ui().forgot({ email: EMAIL });
    expect(t.ui().flow).toEqual(recoveryStep);
    expect(t.ui().error).toBeNull();
  });

  it("stays and shows the error for anything else", async () => {
    const t = setup();
    t.ui().show("forgot");
    t.fail.requestPasswordReset = [err("offline", 0)];
    await t.ui().forgot({ email: EMAIL });
    expect(t.ui().flow).toEqual({ step: "forgot", email: "" });
    expect(t.ui().error).toBe("You're offline. Connect to the internet and try again.");
  });
});

describe("a code and a new password", () => {
  it("checks everything on the device first", async () => {
    const t = setup();
    t.at(recoveryStep);
    expect(await t.ui().reset({ code: "", password: "short", confirm: "" })).toEqual({
      ok: false,
      fields: { code: "Enter the code from the email.", password: "Use at least 10 characters." },
    });
    t.at(inviteStep);
    expect(await t.ui().reset({ email: "", code: CODE, password: PASSWORD, confirm: OTHER_PASSWORD })).toEqual({
      ok: false,
      fields: { email: "Enter your email address.", confirm: "Passwords don't match." },
    });
    expect(t.calls).toEqual([]);
  });

  it("checks the code, sets the password and ends", async () => {
    const t = setup();
    t.at(recoveryStep);
    // The address is the one the code was sent to, whatever else is passed in.
    expect(await t.ui().reset({ email: "someone-else@example.test", code: "1234 5678", password: PASSWORD, confirm: PASSWORD })).toEqual({ ok: true });
    expect(t.calls).toEqual([
      ["verifyEmailCode", EMAIL, CODE, "recovery"],
      ["setPassword", PASSWORD],
    ]);
    expect(t.ui().finished?.outcome).toBe("passwordChanged");
    expect(t.ui().open).toBe(false);
  });

  it("a wrong code changes nothing", async () => {
    const t = setup();
    t.at(recoveryStep);
    t.fail.verifyEmailCode = [err("code_invalid", 403)];
    await t.ui().reset({ code: CODE, password: PASSWORD, confirm: PASSWORD });
    expect(t.names()).toEqual(["verifyEmailCode"]);
    expect(t.ui().flow).toEqual(recoveryStep);
    expect(t.ui().error).toBe("That code is incorrect or has expired. Check it, or send a new one.");
  });

  it("when the code passed but the password did not, only the password is asked for again, and it cannot be put off", async () => {
    const t = setup();
    t.at(recoveryStep);
    t.fail.setPassword = [err("same_password", 422)];
    await t.ui().reset({ code: CODE, password: PASSWORD, confirm: PASSWORD });
    expect(t.ui().flow).toEqual({ step: "setPassword", email: EMAIL, name: "", via: "plain" });
    expect(t.ui().error).toBe("Your new password must be different from your current one.");
    expect(t.ui().open).toBe(true);
    // The code confirmed the address. Closing the dialog is not a way past the password.
    t.ui().close();
    expect(t.ui().open).toBe(true);
    expect(t.ui()).not.toHaveProperty("skipPassword");
  });

  it("an invitation uses the typed address and its own kind of code", async () => {
    const t = setup();
    t.at(inviteStep);
    await t.ui().reset({ email: " Grace@Example.test", code: CODE, password: PASSWORD, confirm: PASSWORD });
    expect(t.calls).toEqual([
      ["verifyEmailCode", "grace@example.test", CODE, "invite"],
      ["setPassword", PASSWORD],
    ]);
    expect(t.ui().finished?.outcome).toBe("passwordChanged");
  });

  it("an invited person whose password did not save must still choose one", async () => {
    const t = setup();
    t.at(inviteStep);
    t.fail.setPassword = [err("weak_password", 422)];
    await t.ui().reset({ email: "grace@example.test", code: CODE, password: PASSWORD, confirm: PASSWORD });
    expect(t.ui().flow).toEqual({ step: "setPassword", email: "grace@example.test", name: "", via: "plain" });
    expect(t.ui().error).toMatch(/isn't strong enough/);
  });

  it("after the security fallback the typed name is still saved", async () => {
    const t = setup();
    t.at(securityStep);
    await t.ui().reset({ code: CODE, password: PASSWORD, confirm: PASSWORD });
    expect(t.calls).toEqual([
      ["verifyEmailCode", EMAIL, CODE, "recovery"],
      ["setPassword", PASSWORD],
      ["updateMyProfile", { name: "Ada", institution: "" }],
    ]);
    expect(t.ui().finished?.outcome).toBe("passwordChanged");
  });
});

describe("choosing a password while signed in", () => {
  const secure: AuthStep = { step: "setPassword", email: EMAIL, name: "Ada", via: "secure" };
  const plain: AuthStep = { step: "setPassword", email: EMAIL, name: "", via: "plain" };

  it("checks the two fields first", async () => {
    const t = setup();
    t.at(secure);
    expect(await t.ui().savePassword({ password: PASSWORD, confirm: "" })).toEqual({ ok: false, fields: { confirm: "Passwords don't match." } });
    expect(t.calls).toEqual([]);
  });

  it("after a sign-up code it secures the account and saves the name", async () => {
    const t = setup();
    t.at(secure);
    await t.ui().savePassword({ password: PASSWORD, confirm: PASSWORD });
    expect(t.calls).toEqual([
      ["securePassword", PASSWORD],
      ["updateMyProfile", { name: "Ada", institution: "" }],
    ]);
    expect(t.ui().finished?.outcome).toBe("accountCreated");
  });

  it("after a recovery or invitation code it just sets the password", async () => {
    const t = setup();
    t.at(plain);
    await t.ui().savePassword({ password: PASSWORD, confirm: PASSWORD });
    expect(t.calls).toEqual([["setPassword", PASSWORD]]);
    expect(t.ui().finished?.outcome).toBe("passwordChanged");
  });

  it("stays, with the reason, when it fails", async () => {
    const t = setup();
    t.at(secure);
    t.fail.securePassword = [err("weak_password", 422)];
    expect(await t.ui().savePassword({ password: PASSWORD, confirm: PASSWORD })).toEqual({ ok: false });
    expect(t.ui().flow).toEqual(secure);
    expect(t.ui().error).toMatch(/isn't strong enough/);
  });

  it("falls back to a recovery code when the server wants a different current password", async () => {
    const t = setup();
    t.at(secure);
    t.fail.securePassword = [err("invalid_credentials")];
    expect(await t.ui().savePassword({ password: PASSWORD, confirm: PASSWORD })).toEqual({ ok: true });
    expect(t.ui().flow).toEqual(securityStep);
    expect(t.calls).toEqual([
      ["securePassword", PASSWORD],
      ["requestPasswordReset", EMAIL],
    ]);
    expect(t.ui().notice).toBe(SECURITY_RESET_MESSAGE);
  });

  it("there is no 'Not now': after any emailed code the password is saved, or the person signs out", () => {
    const t = setup();
    for (const step of [secure, plain]) {
      t.at(step);
      expect(t.ui()).not.toHaveProperty("skipPassword");
      // No link leads to another form, and the dialog does not close.
      t.ui().show("signIn");
      t.ui().close();
      expect(t.ui().flow).toEqual(step);
      expect(t.ui().open).toBe(true);
      expect(t.ui().finished).toBeNull();
    }
  });

  it("'Sign out instead' leaves the account and clears the step", async () => {
    const t = setup();
    t.at(secure);
    await t.ui().signOutInstead();
    expect(t.names()).toEqual(["signOut"]);
    expect(t.ui().flow).toEqual({ step: "signIn", email: "" });
    expect(t.ui().open).toBe(false);
    expect(t.ui().busy).toBe(false);
  });
});

describe("a password that is owed is never out of sight", () => {
  const secure: AuthStep = { step: "setPassword", email: EMAIL, name: "Ada", via: "secure" };

  it("cannot be closed: not the password form, not the wait before it, not the code that settles it", () => {
    const t = setup();
    for (const step of [secure, { step: "securing", email: EMAIL, name: "Ada" } as AuthStep, securityStep]) {
      t.at(step);
      t.ui().close();
      expect(t.ui().open).toBe(true);
      expect(t.ui().flow).toEqual(step);
    }
  });

  it("opens the dialog again when saving the password fails after the person closed it", async () => {
    const t = setup();
    t.at(confirmStep);
    let release = () => {};
    t.hold.confirmSignUp = new Promise<void>((resolve) => (release = resolve));
    const confirming = t.ui().confirm({ code: CODE, password: PASSWORD });
    // Escape while the code is being checked: that is still allowed.
    t.ui().close();
    expect(t.ui().open).toBe(false);

    t.fail.securePassword = [err("network", 0)];
    release();
    await confirming;

    expect(t.ui().flow).toEqual(secure);
    expect(t.ui().open).toBe(true);
    expect(t.ui().error).toBe(describeAuthError(err("network", 0)));
  });

  it("opens the dialog again when the typed password is refused and a new code is needed", async () => {
    const t = setup();
    t.at(confirmStep);
    t.store.setState({ open: false });
    t.fail.securePassword = [err("invalid_credentials")];
    await t.ui().confirm({ code: CODE, password: PASSWORD });
    expect(t.ui().flow).toEqual(securityStep);
    expect(t.ui().open).toBe(true);
  });

  it("the session saying so brings a hidden password step back", () => {
    const t = setup();
    t.store.setState({ flow: secure, open: false });
    expect(t.ui().autoResume({ signedIn: true, passwordPending: true, mustSetPassword: false, email: EMAIL })).toBe(true);
    expect(t.ui().open).toBe(true);
    expect(t.ui().flow).toEqual(secure);
  });
});

describe("a server that will not send more email", () => {
  const limited = () => err("email_rate_limited", 429);

  it("forgot password: says so and stays, instead of asking for a code that was never sent", async () => {
    const t = setup();
    t.ui().show("forgot");
    t.fail.requestPasswordReset = [limited()];
    expect(await t.ui().forgot({ email: EMAIL })).toEqual({ ok: false });
    expect(t.ui().flow).toEqual({ step: "forgot", email: "" });
    expect(t.ui().error).toBe(EMAIL_BUSY_MESSAGE);
  });

  it("forgot password: a code this device asked for a moment ago is the one to use", async () => {
    const t = setup();
    t.ui().show("forgot");
    await t.ui().forgot({ email: EMAIL });
    expect(t.ui().flow).toEqual(recoveryStep);

    // Back, and asked again within the minute: the server refuses, and the first code is in the inbox.
    t.ui().show("forgot");
    t.clock.now = NOW + 20_000;
    t.fail.requestPasswordReset = [limited()];
    expect(await t.ui().forgot({ email: EMAIL })).toEqual({ ok: true });
    expect(t.ui().flow).toEqual({ ...recoveryStep, resendAt: NOW + 20_000 + RESEND_COOLDOWN_MS });
    expect(t.ui().error).toBeNull();

    // A minute later it no longer explains a refusal, and neither does a code for another address.
    t.ui().show("forgot");
    t.clock.now = NOW + RESEND_COOLDOWN_MS + 1;
    t.fail.requestPasswordReset = [limited(), limited()];
    expect(await t.ui().forgot({ email: EMAIL })).toEqual({ ok: false });
    expect(await t.ui().forgot({ email: "grace@example.test" })).toEqual({ ok: false });
    expect(t.ui().flow.step).toBe("forgot");
    expect(t.ui().error).toBe(EMAIL_BUSY_MESSAGE);
  });

  it("sign-in to an unconfirmed account: does not claim a code was sent", async () => {
    const t = setup();
    t.fail.signIn = [err("email_not_confirmed")];
    t.fail.resendSignUpCode = [limited()];
    await t.ui().signIn({ email: EMAIL, password: PASSWORD });
    expect(t.ui().flow.step).toBe("confirm");
    expect(t.ui().notice).toBeNull();
    expect(t.ui().error).toBe(EMAIL_BUSY_MESSAGE);
  });

  it("'Send a new code' after the wait: the refusal is not this device's doing, and is said as it is", async () => {
    const t = setup();
    t.ui().openAccount("signUp");
    await t.ui().signUp({ name: "Ada", email: EMAIL, password: PASSWORD, confirm: PASSWORD });
    t.clock.now = NOW + RESEND_COOLDOWN_MS;
    t.fail.resendSignUpCode = [limited()];
    expect(await t.ui().resendCode()).toEqual({ ok: false });
    expect(t.ui().error).toBe(EMAIL_BUSY_MESSAGE);
    expect(t.ui().sent).toBeNull();
    // The wait starts again all the same, so the button is not hammered.
    expect(t.ui().flow).toEqual({ ...confirmStep, resendAt: t.clock.now + RESEND_COOLDOWN_MS });
  });
});

describe("the name on the account", () => {
  it("the name typed at sign-up is saved with an empty institution: nothing an earlier registrant put there stays", async () => {
    const t = setup();
    t.at(confirmStep);
    await t.ui().confirm({ code: CODE, password: PASSWORD });
    expect(t.calls.at(-1)).toEqual(["updateMyProfile", { name: "Ada", institution: "" }]);
  });

  it("a password step that carries no name saves the one the person confirms there, and leaves the institution alone", async () => {
    const t = setup();
    t.at({ step: "setPassword", email: EMAIL, name: "", via: "secure" });
    expect(await t.ui().savePassword({ password: PASSWORD, confirm: PASSWORD, name: "x".repeat(201) })).toEqual({
      ok: false,
      fields: { name: "Use 200 characters or fewer." },
    });
    expect(t.calls).toEqual([]);

    await t.ui().savePassword({ password: PASSWORD, confirm: PASSWORD, name: "  Ada King " });
    expect(t.calls).toEqual([
      ["securePassword", PASSWORD],
      ["updateMyProfile", { name: "Ada King" }],
    ]);
    expect(t.ui().finished?.outcome).toBe("accountCreated");
  });

  it("where that step shows the institution too, what the person leaves there is saved: emptied, if it was not theirs", async () => {
    const t = setup();
    t.at({ step: "setPassword", email: EMAIL, name: "", via: "secure" });
    expect(await t.ui().savePassword({ password: PASSWORD, confirm: PASSWORD, name: "Ada", institution: "x".repeat(201) })).toEqual({
      ok: false,
      fields: { institution: "Use 200 characters or fewer." },
    });
    await t.ui().savePassword({ password: PASSWORD, confirm: PASSWORD, name: "Ada King", institution: "" });
    expect(t.calls.at(-1)).toEqual(["updateMyProfile", { name: "Ada King", institution: "" }]);
  });

  it("says a flow has ended only once the name is saved, so what is said about the account is true", async () => {
    const t = setup();
    t.at(confirmStep);
    let release = () => {};
    t.hold.updateMyProfile = new Promise<void>((resolve) => (release = resolve));
    const confirming = t.ui().confirm({ code: CODE, password: PASSWORD });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // The dialog is away, and the name is still being saved.
    expect(t.names()).toEqual(["confirmSignUp", "securePassword", "updateMyProfile"]);
    expect(t.ui().open).toBe(false);
    expect(t.ui().finished).toBeNull();
    release();
    await confirming;
    expect(t.ui().finished?.outcome).toBe("accountCreated");
  });

  it("no name given on that step: nothing is changed", async () => {
    const t = setup();
    t.at({ step: "setPassword", email: EMAIL, name: "", via: "plain" });
    await t.ui().savePassword({ password: PASSWORD, confirm: PASSWORD, name: " " });
    expect(t.calls).toEqual([["setPassword", PASSWORD]]);
  });
});

describe("actions only act on their own step", () => {
  it("ignores a submit that belongs to another step", async () => {
    const t = setup();
    t.at(recoveryStep);
    expect(await t.ui().signIn({ email: EMAIL, password: PASSWORD })).toEqual({ ok: false });
    expect(await t.ui().signUp({ name: "Ada", email: EMAIL, password: PASSWORD, confirm: PASSWORD })).toEqual({ ok: false });
    expect(await t.ui().confirm({ code: CODE, password: PASSWORD })).toEqual({ ok: false });
    expect(await t.ui().forgot({ email: EMAIL })).toEqual({ ok: false });
    expect(await t.ui().savePassword({ password: PASSWORD, confirm: PASSWORD })).toEqual({ ok: false });
    t.at(confirmStep);
    expect(await t.ui().reset({ code: CODE, password: PASSWORD, confirm: PASSWORD })).toEqual({ ok: false });
    expect(t.calls).toEqual([]);
  });
});

describe("opening and closing the dialog", () => {
  it("opens on the form asked for", () => {
    const t = setup();
    t.ui().openAccount("signUp");
    expect(t.ui().open).toBe(true);
    expect(t.ui().flow).toEqual({ step: "signUp", name: "", email: "" });
    t.ui().close();
    t.ui().openAccount("signIn", EMAIL);
    expect(t.ui().flow).toEqual({ step: "signIn", email: EMAIL });
    t.ui().close();
    t.ui().openAccount();
    expect(t.ui().flow.step).toBe("signIn");
  });

  it("closing keeps the step, and opening again returns to a step that is under way", () => {
    const t = setup();
    for (const step of [confirmStep, recoveryStep]) {
      t.at(step);
      t.ui().close();
      expect(t.ui().open).toBe(false);
      t.ui().openAccount("signIn");
      expect(t.ui().open).toBe(true);
      expect(t.ui().flow).toEqual(step);
    }
    // A step that settles a password that is owed does not close at all, and is returned to as well.
    t.at(securityStep);
    t.ui().close();
    expect(t.ui().open).toBe(true);
    t.ui().openAccount("signIn");
    expect(t.ui().flow).toEqual(securityStep);
  });

  it("a new step drops the previous step's messages", async () => {
    const t = setup();
    t.fail.signIn = [err("invalid_credentials")];
    await t.ui().signIn({ email: EMAIL, password: PASSWORD });
    expect(t.ui().error).not.toBeNull();
    t.ui().show("forgot", EMAIL);
    expect(t.ui().flow).toEqual({ step: "forgot", email: EMAIL });
    expect(t.ui().error).toBeNull();
  });

  it("tracks whether the invitations list is showing", () => {
    const t = setup();
    expect(t.ui().invitationsOpen).toBe(false);
    t.ui().openInvitations();
    expect(t.ui().invitationsOpen).toBe(true);
    t.ui().closeInvitations();
    expect(t.ui().invitationsOpen).toBe(false);
  });
});

describe("someone signed in who still owes a password", () => {
  const owing = (over: Partial<PendingInput> = {}): PendingInput => ({
    signedIn: true,
    passwordPending: false,
    mustSetPassword: false,
    email: EMAIL,
    ...over,
  });

  it("nothing owed, or nobody signed in: nothing opens", () => {
    const t = setup();
    expect(t.ui().resumePending(owing())).toBe(false);
    expect(t.ui().resumePending(owing({ signedIn: false, passwordPending: true, mustSetPassword: true }))).toBe(false);
    expect(t.ui().open).toBe(false);
    expect(t.ui().flow.step).toBe("signIn");
  });

  it("an unsecured sign-up opens the secure password step", () => {
    const t = setup();
    expect(t.ui().resumePending(owing({ passwordPending: true }))).toBe(true);
    expect(t.ui().open).toBe(true);
    expect(t.ui().flow).toEqual({ step: "setPassword", email: EMAIL, name: "", via: "secure" });
  });

  it("an invited person opens the plain password step", () => {
    const t = setup();
    expect(t.ui().resumePending(owing({ mustSetPassword: true }))).toBe(true);
    expect(t.ui().flow).toEqual({ step: "setPassword", email: EMAIL, name: "", via: "plain" });
  });

  it("returns to a password step that is already under way instead of replacing it", () => {
    const t = setup();
    t.at(securityStep);
    t.store.setState({ open: false, notice: SECURITY_RESET_MESSAGE });
    expect(t.ui().resumePending(owing({ passwordPending: true }))).toBe(true);
    expect(t.ui().flow).toEqual(securityStep);
    expect(t.ui().notice).toBe(SECURITY_RESET_MESSAGE);
    expect(t.ui().open).toBe(true);
  });

  it("by itself it only opens while the account screens are untouched", async () => {
    const t = setup();
    // The dialog is open on some form.
    t.ui().openAccount("signIn");
    expect(t.ui().autoResume(owing({ passwordPending: true }))).toBe(false);
    t.ui().close();

    // A flow is under way: the code step, as during a normal sign-up.
    t.at(confirmStep);
    t.ui().close();
    expect(t.ui().autoResume(owing({ passwordPending: true }))).toBe(false);
    expect(t.ui().flow).toEqual(confirmStep);

    // A password step cannot be closed, so there is nothing to bring back.
    const step: AuthStep = { step: "setPassword", email: EMAIL, name: "", via: "secure" };
    t.at(step);
    t.ui().close();
    expect(t.ui().open).toBe(true);
    expect(t.ui().autoResume(owing({ passwordPending: true }))).toBe(false);
    expect(t.ui().flow).toEqual(step);

    // A request is in flight.
    const busy = setup();
    let release = () => {};
    busy.hold.signIn = new Promise<void>((resolve) => (release = resolve));
    const pending = busy.ui().signIn({ email: EMAIL, password: PASSWORD });
    expect(busy.ui().autoResume(owing({ passwordPending: true }))).toBe(false);
    release();
    await pending;

    // Untouched: it opens.
    const idle = setup();
    expect(idle.ui().autoResume(owing({ passwordPending: true }))).toBe(true);
    expect(idle.ui().open).toBe(true);
  });

  it("when the session ends, a password step is dropped and any other step is kept", () => {
    const t = setup();
    t.at(securityStep);
    t.ui().sessionEnded();
    expect(t.ui().flow).toEqual({ step: "signIn", email: "" });
    expect(t.ui().open).toBe(false);

    t.at(confirmStep);
    t.ui().sessionEnded();
    expect(t.ui().flow).toEqual(confirmStep);
    expect(t.ui().open).toBe(true);
  });
});

describe("rules", () => {
  const steps: AuthStep[] = [
    { step: "signIn", email: "" },
    { step: "signUp", name: "", email: "" },
    confirmStep,
    { step: "securing", email: EMAIL, name: "" },
    { step: "forgot", email: "" },
    recoveryStep,
    inviteStep,
    securityStep,
    { step: "setPassword", email: EMAIL, name: "", via: "plain" },
  ];

  it("isMidway: a code was sent or the account was just confirmed", () => {
    expect(steps.map(isMidway)).toEqual([false, false, true, true, false, true, false, true, true]);
  });

  it("owesPassword: signed in, settling the password", () => {
    expect(steps.map(owesPassword)).toEqual([false, false, false, true, false, false, false, true, true]);
  });

  it("passwordFields puts a length problem on the password and a mismatch on the confirmation", () => {
    expect(passwordFields("short", "short")).toEqual({ password: "Use at least 10 characters." });
    expect(passwordFields("short", "other")).toEqual({ password: "Use at least 10 characters." });
    expect(passwordFields("x".repeat(73), "x".repeat(73))).toEqual({ password: "Use 72 characters or fewer." });
    expect(passwordFields(PASSWORD, OTHER_PASSWORD)).toEqual({ confirm: "Passwords don't match." });
    expect(passwordFields(PASSWORD, PASSWORD)).toEqual({});
  });

  it("pendingInputOf reads only a signed-in session", () => {
    const profile = { email: EMAIL, mustSetPassword: true };
    expect(pendingInputOf({ phase: "ready", profile, passwordPending: true })).toEqual({
      signedIn: true,
      passwordPending: true,
      mustSetPassword: true,
      email: EMAIL,
    });
    expect(pendingInputOf({ phase: "ready", profile: { email: EMAIL, mustSetPassword: false }, passwordPending: false })).toEqual({
      signedIn: true,
      passwordPending: false,
      mustSetPassword: false,
      email: EMAIL,
    });
    for (const phase of ["anon", "loading", "unconfigured"]) {
      expect(pendingInputOf({ phase, profile, passwordPending: true })).toEqual({
        signedIn: false,
        passwordPending: false,
        mustSetPassword: false,
        email: "",
      });
    }
    expect(pendingInputOf({ phase: "ready", profile: null, passwordPending: true }).signedIn).toBe(false);
  });
});
