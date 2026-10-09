import { describe, expect, it } from "vitest";
import { AuthWeakPasswordError } from "@supabase/supabase-js";
import { SyncError } from "@/lib/supabase/errors";
import {
  CODE_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  RESEND_COOLDOWN_MS,
  SECURITY_RESET_MESSAGE,
  authFlow,
  canResend,
  cooldownSeconds,
  describeAuthError,
  formatCooldown,
  initialAuthStep,
  isRecentlySent,
  isUnconfirmed,
  normalizeCode,
  normalizeEmail,
  passwordFailure,
  pendingPasswordStep,
  validateCode,
  validateEmail,
  validateName,
  validateNewPassword,
  validateSignInPassword,
  type AuthEffect,
  type AuthEvent,
  type AuthStep,
} from "./auth-flow";

const NOW = 1_000_000;
const EMAIL = "ada@example.test";

/** Feed a list of events through the machine and return the final transition. */
function run(start: AuthStep, ...events: AuthEvent[]) {
  let state = start;
  let effects: AuthEffect[] = [];
  for (const event of events) ({ state, effects } = authFlow(state, event));
  return { state, effects };
}

const confirmStep: AuthStep = { step: "confirm", email: EMAIL, name: "Ada", resendAt: NOW + RESEND_COOLDOWN_MS };

describe("authFlow: sign in", () => {
  it("starts at sign-in", () => {
    expect(initialAuthStep()).toEqual({ step: "signIn", email: "" });
  });

  it("success is done", () => {
    expect(authFlow(initialAuthStep(), { type: "signedIn" })).toEqual({ state: { step: "done", outcome: "signedIn" }, effects: [] });
  });

  it("an unconfirmed address sends a fresh code and moves to the code step", () => {
    const t = authFlow(initialAuthStep(), { type: "signInUnconfirmed", email: EMAIL, now: NOW });
    expect(t.state).toEqual({ step: "confirm", email: EMAIL, name: "", resendAt: NOW + RESEND_COOLDOWN_MS });
    expect(t.effects).toEqual([{ type: "resendSignUpCode", email: EMAIL }]);
  });

  it("the links move between forms and carry the typed email", () => {
    const start: AuthStep = { step: "signIn", email: EMAIL };
    expect(authFlow(start, { type: "show", step: "signUp" }).state).toEqual({ step: "signUp", name: "", email: EMAIL });
    expect(authFlow(start, { type: "show", step: "forgot" }).state).toEqual({ step: "forgot", email: EMAIL });
    expect(authFlow(start, { type: "show", step: "signIn", email: "other@example.test" }).state).toEqual({
      step: "signIn",
      email: "other@example.test",
    });
  });
});

describe("authFlow: create an account", () => {
  const signUp: AuthStep = { step: "signUp", name: "", email: "" };

  it("moves to the code step and starts the resend cooldown", () => {
    const t = authFlow(signUp, { type: "signUpDone", name: "Ada", email: EMAIL, result: "confirm", now: NOW });
    expect(t).toEqual({ state: confirmStep, effects: [] });
  });

  it("is done at once when the server needs no confirmation", () => {
    const t = authFlow(signUp, { type: "signUpDone", name: "Ada", email: EMAIL, result: "signedIn", now: NOW });
    expect(t.state).toEqual({ step: "done", outcome: "accountCreated" });
  });

  it("'Use a different email' goes back to the form with what was typed", () => {
    expect(authFlow(confirmStep, { type: "useDifferentEmail" }).state).toEqual({ step: "signUp", name: "Ada", email: EMAIL });
  });

  it("a resend restarts the cooldown and stays on the code step", () => {
    const later = NOW + 90_000;
    expect(authFlow(confirmStep, { type: "codeResent", now: later }).state).toEqual({ ...confirmStep, resendAt: later + RESEND_COOLDOWN_MS });
  });
});

describe("authFlow: after the sign-up code is accepted (pre-registration fix)", () => {
  it("first writes the typed password over whatever the account has", () => {
    const t = authFlow(confirmStep, { type: "codeConfirmed", hasPassword: true });
    expect(t.state).toEqual({ step: "securing", email: EMAIL, name: "Ada" });
    expect(t.effects).toEqual([{ type: "securePassword" }]);
  });

  it("then saves the typed name and finishes", () => {
    const t = run(confirmStep, { type: "codeConfirmed", hasPassword: true }, { type: "passwordSecured" });
    expect(t.state).toEqual({ step: "done", outcome: "accountCreated" });
    expect(t.effects).toEqual([{ type: "saveName", name: "Ada", institution: "" }]);
  });

  it("does not save an empty name (reached through sign-in, where none was typed)", () => {
    const viaSignIn: AuthStep = { ...confirmStep, name: "" };
    const t = run(viaSignIn, { type: "codeConfirmed", hasPassword: true }, { type: "passwordSecured" });
    expect(t.state).toEqual({ step: "done", outcome: "accountCreated" });
    expect(t.effects).toEqual([]);
  });

  it("falls back to a recovery code when the account's password is someone else's", () => {
    const t = run(
      confirmStep,
      { type: "codeConfirmed", hasPassword: true },
      { type: "passwordNotSecured", reason: "mismatch", now: NOW + 5_000 },
    );
    expect(t.state).toEqual({
      step: "reset",
      email: EMAIL,
      name: "Ada",
      kind: "recovery",
      resendAt: NOW + 5_000 + RESEND_COOLDOWN_MS,
      reason: "security",
    });
    expect(t.effects).toEqual([{ type: "sendRecoveryCode", email: EMAIL }]);
    expect(SECURITY_RESET_MESSAGE).toBe("For your security, enter the new code we just sent to set your password.");
  });

  it("still saves the typed name once the recovery code sets the password", () => {
    const t = run(
      confirmStep,
      { type: "codeConfirmed", hasPassword: true },
      { type: "passwordNotSecured", reason: "mismatch", now: NOW },
      { type: "resetDone" },
    );
    expect(t.state).toEqual({ step: "done", outcome: "passwordChanged" });
    expect(t.effects).toEqual([{ type: "saveName", name: "Ada", institution: "" }]);
  });

  it("asks for the password by hand when the call failed for another reason", () => {
    const t = run(confirmStep, { type: "codeConfirmed", hasPassword: true }, { type: "passwordNotSecured", reason: "failed", now: NOW });
    expect(t.state).toEqual({ step: "setPassword", email: EMAIL, name: "Ada", via: "secure" });
    expect(t.effects).toEqual([]);
  });

  it("asks for the password again when the typed one is no longer in memory", () => {
    const t = authFlow(confirmStep, { type: "codeConfirmed", hasPassword: false });
    expect(t.state).toEqual({ step: "setPassword", email: EMAIL, name: "Ada", via: "secure" });
    expect(t.effects).toEqual([]);
  });

  it("the by-hand step finishes the same way, and can also fall back to recovery", () => {
    const byHand: AuthStep = { step: "setPassword", email: EMAIL, name: "Ada", via: "secure" };
    expect(authFlow(byHand, { type: "passwordSecured" })).toEqual({
      state: { step: "done", outcome: "accountCreated" },
      effects: [{ type: "saveName", name: "Ada", institution: "" }],
    });
    const fallback = authFlow(byHand, { type: "passwordNotSecured", reason: "mismatch", now: NOW });
    expect(fallback.state).toMatchObject({ step: "reset", kind: "recovery", reason: "security" });
    expect(fallback.effects).toEqual([{ type: "sendRecoveryCode", email: EMAIL }]);
    // Any other failure stays put so the person can try again.
    expect(authFlow(byHand, { type: "passwordNotSecured", reason: "failed", now: NOW }).state).toBe(byHand);
  });

  it("cannot be skipped or navigated away from while the password is unsettled", () => {
    const byHand: AuthStep = { step: "setPassword", email: EMAIL, name: "Ada", via: "secure" };
    expect(authFlow(byHand, { type: "skipPassword" } as never).state).toBe(byHand);
    expect(authFlow(byHand, { type: "show", step: "signIn" }).state).toBe(byHand);
    const securing: AuthStep = { step: "securing", email: EMAIL, name: "Ada" };
    expect(authFlow(securing, { type: "show", step: "signUp" }).state).toBe(securing);
  });
});

describe("authFlow: forgot password", () => {
  const forgot: AuthStep = { step: "forgot", email: "" };

  it("always moves on to the code step (the copy says 'if an account exists')", () => {
    const t = authFlow(forgot, { type: "forgotDone", email: EMAIL, now: NOW });
    expect(t.state).toEqual({
      step: "reset",
      email: EMAIL,
      name: "",
      kind: "recovery",
      resendAt: NOW + RESEND_COOLDOWN_MS,
      reason: "requested",
    });
    expect(t.effects).toEqual([]);
  });

  it("code and password accepted is done", () => {
    const t = run(forgot, { type: "forgotDone", email: EMAIL, now: NOW }, { type: "resetDone" });
    expect(t).toEqual({ state: { step: "done", outcome: "passwordChanged" }, effects: [] });
  });

  it("code accepted but password refused: the code is spent, so only the password is asked for again", () => {
    const t = run(forgot, { type: "forgotDone", email: EMAIL, now: NOW }, { type: "resetCodeAccepted" });
    expect(t.state).toEqual({ step: "setPassword", email: EMAIL, name: "", via: "plain" });
    expect(authFlow(t.state, { type: "passwordSecured" }).state).toEqual({ step: "done", outcome: "passwordChanged" });
  });

  it("after a recovery code the password cannot be put off: the address was confirmed by it, and whose password the account has is unknown", () => {
    const t = run(forgot, { type: "forgotDone", email: EMAIL, now: NOW }, { type: "resetCodeAccepted" });
    expect(t.state.step).toBe("setPassword");
    // No "Not now": nothing but a saved password ends this step, and no link leads away from it.
    expect(authFlow(t.state, { type: "skipPassword" } as never).state).toBe(t.state);
    expect(authFlow(t.state, { type: "show", step: "signIn" }).state).toBe(t.state);
  });

  it("a name asked for on the password step is saved by itself; one from the sign-up form also clears the institution", () => {
    // No name came with the step (a relaunch, a recovery, an invitation): the step asks, and only the name is saved.
    const asked: AuthStep = { step: "setPassword", email: EMAIL, name: "", via: "plain" };
    expect(authFlow(asked, { type: "passwordSecured", name: "  Ada King " }).effects).toEqual([{ type: "saveName", name: "Ada King" }]);
    expect(authFlow(asked, { type: "passwordSecured", name: " " }).effects).toEqual([]);
    expect(authFlow(asked, { type: "passwordSecured" }).effects).toEqual([]);
    // Where the step showed the institution as well, what was left in that field is saved with the name.
    expect(authFlow(asked, { type: "passwordSecured", name: "Ada King", institution: " Analytical Society " }).effects).toEqual([
      { type: "saveName", name: "Ada King", institution: "Analytical Society" },
    ]);
    expect(authFlow(asked, { type: "passwordSecured", name: "Ada King", institution: "" }).effects).toEqual([{ type: "saveName", name: "Ada King", institution: "" }]);
    // The name typed at sign-up wins over anything entered later, and the institution goes with whoever registered first.
    const carried: AuthStep = { step: "setPassword", email: EMAIL, name: "Ada", via: "secure" };
    expect(authFlow(carried, { type: "passwordSecured", name: "Somebody Else" }).effects).toEqual([{ type: "saveName", name: "Ada", institution: "" }]);
  });

  it("a resend restarts the cooldown", () => {
    const reset = authFlow(forgot, { type: "forgotDone", email: EMAIL, now: NOW }).state;
    const again = authFlow(reset, { type: "codeResent", now: NOW + 70_000 }).state;
    expect(again).toMatchObject({ step: "reset", kind: "recovery", resendAt: NOW + 70_000 + RESEND_COOLDOWN_MS });
  });
});

describe("authFlow: invitation code", () => {
  const invite = authFlow(initialAuthStep(EMAIL), { type: "show", step: "invite" });

  it("opens the code form without sending any email", () => {
    expect(invite.state).toEqual({ step: "reset", email: EMAIL, name: "", kind: "invite", resendAt: 0, reason: "requested" });
    expect(invite.effects).toEqual([]);
  });

  it("'Email me a new code' turns it into a recovery code", () => {
    const t = authFlow(invite.state, { type: "codeResent", now: NOW });
    expect(t.state).toMatchObject({ step: "reset", kind: "recovery", resendAt: NOW + RESEND_COOLDOWN_MS });
  });

  it("an invited person must choose a password: no 'Not now'", () => {
    const t = authFlow(invite.state, { type: "resetCodeAccepted" });
    expect(t.state).toEqual({ step: "setPassword", email: EMAIL, name: "", via: "plain" });
    expect(authFlow(t.state, { type: "skipPassword" } as never).state).toBe(t.state);
  });
});

describe("authFlow: odds and ends", () => {
  it("ignores events that do not belong to the current step", () => {
    const signIn = initialAuthStep();
    expect(authFlow(signIn, { type: "resetDone" })).toEqual({ state: signIn, effects: [] });
    expect(authFlow(confirmStep, { type: "signedIn" }).state).toBe(confirmStep);
    const done: AuthStep = { step: "done", outcome: "signedIn" };
    expect(authFlow(done, { type: "passwordSecured" }).state).toBe(done);
  });

  it("restart returns to an empty sign-in form from anywhere", () => {
    expect(authFlow(confirmStep, { type: "restart" }).state).toEqual({ step: "signIn", email: "" });
    expect(authFlow({ step: "done", outcome: "signedIn" }, { type: "restart" }).state).toEqual({ step: "signIn", email: "" });
  });

  it("the state never holds a password or a code", () => {
    const states: AuthStep[] = [
      confirmStep,
      authFlow(confirmStep, { type: "codeConfirmed", hasPassword: true }).state,
      authFlow({ step: "forgot", email: "" }, { type: "forgotDone", email: EMAIL, now: NOW }).state,
    ];
    for (const s of states) expect(Object.keys(s).sort().join(",")).not.toMatch(/password|code|token/i);
  });

  it("pendingPasswordStep reopens the right step for someone who still owes a password", () => {
    expect(pendingPasswordStep({ passwordPending: false, mustSetPassword: false, email: EMAIL })).toBeNull();
    expect(pendingPasswordStep({ passwordPending: true, mustSetPassword: false, email: EMAIL })).toEqual({
      step: "setPassword",
      email: EMAIL,
      name: "",
      via: "secure",
    });
    expect(pendingPasswordStep({ passwordPending: false, mustSetPassword: true, email: EMAIL })).toEqual({ step: "setPassword", email: EMAIL, name: "", via: "plain" });
  });
});

describe("validators", () => {
  it("email: trimmed, lowercased, basic shape", () => {
    expect(normalizeEmail("  Ada@Example.TEST ")).toBe("ada@example.test");
    expect(validateEmail("  Ada@Example.TEST ")).toBeNull();
    expect(validateEmail("")).toBe("Enter your email address.");
    for (const bad of ["ada", "ada@", "@example.test", "ada@example", "a da@example.test"]) {
      expect(validateEmail(bad)).toBe("Enter a valid email address.");
    }
  });

  it("name: 1 to 200 characters after trimming", () => {
    expect(validateName("Ada")).toBeNull();
    expect(validateName("   ")).toBe("Enter your name.");
    expect(validateName("a".repeat(200))).toBeNull();
    expect(validateName("a".repeat(201))).toBe("Use 200 characters or fewer.");
  });

  it("new password: 10 to 72 characters and a matching confirmation", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(10);
    expect(validateNewPassword("123456789", "123456789")).toBe("Use at least 10 characters.");
    expect(validateNewPassword("1234567890", "1234567890")).toBeNull();
    expect(validateNewPassword("a".repeat(MAX_PASSWORD_LENGTH), "a".repeat(MAX_PASSWORD_LENGTH))).toBeNull();
    expect(validateNewPassword("a".repeat(73), "a".repeat(73))).toBe("Use 72 characters or fewer.");
    expect(validateNewPassword("1234567890", "1234567891")).toBe("Passwords don't match.");
  });

  it("sign-in password: only has to be non-empty", () => {
    expect(validateSignInPassword("x")).toBeNull();
    expect(validateSignInPassword("")).toBe("Enter your password.");
  });

  it("code: spaces stripped, 6 to 10 digits, driven by one constant", () => {
    expect(CODE_LENGTH).toEqual({ min: 6, max: 10 });
    expect(normalizeCode(" 1234 5678\n")).toBe("12345678");
    expect(validateCode("123456")).toBeNull();
    expect(validateCode("1234 5678")).toBeNull();
    expect(validateCode("1234567890")).toBeNull();
    expect(validateCode("")).toBe("Enter the code from the email.");
    for (const bad of ["12345", "12345678901", "12345a", "12-34-56"]) expect(validateCode(bad)).not.toBeNull();
  });

  it("the copy never names how many digits a code has", () => {
    for (const message of [validateCode(""), validateCode("1"), describeAuthError(new SyncError(403, "code_invalid"))]) {
      expect(message).not.toMatch(/\d/);
    }
  });
});

describe("resend cooldown", () => {
  it("lasts sixty seconds", () => {
    expect(RESEND_COOLDOWN_MS).toBe(60_000);
  });

  it("counts whole seconds down to zero and never below", () => {
    const resendAt = NOW + RESEND_COOLDOWN_MS;
    expect(cooldownSeconds(resendAt, NOW)).toBe(60);
    expect(cooldownSeconds(resendAt, NOW + 17_500)).toBe(43);
    expect(cooldownSeconds(resendAt, resendAt - 1)).toBe(1);
    expect(cooldownSeconds(resendAt, resendAt)).toBe(0);
    expect(cooldownSeconds(resendAt, resendAt + 5_000)).toBe(0);
    expect(cooldownSeconds(0, NOW)).toBe(0);
  });

  it("canResend flips exactly when the cooldown ends", () => {
    const resendAt = NOW + RESEND_COOLDOWN_MS;
    expect(canResend(resendAt, resendAt - 1)).toBe(false);
    expect(canResend(resendAt, resendAt)).toBe(true);
  });

  it("formats as m:ss", () => {
    expect(formatCooldown(42)).toBe("0:42");
    expect(formatCooldown(60)).toBe("1:00");
    expect(formatCooldown(5)).toBe("0:05");
    expect(formatCooldown(0)).toBe("0:00");
    expect(formatCooldown(-3)).toBe("0:00");
  });
});

describe("reading errors", () => {
  it("passwordFailure tells a wrong current password from any other failure", () => {
    expect(passwordFailure(new SyncError(400, "invalid_credentials"))).toBe("mismatch");
    expect(passwordFailure(new SyncError(401, "reauth_needed"))).toBe("mismatch");
    expect(passwordFailure(new SyncError(0, "network"))).toBe("failed");
    expect(passwordFailure(new SyncError(422, "weak_password"))).toBe("failed");
  });

  it("isUnconfirmed and isRecentlySent", () => {
    expect(isUnconfirmed(new SyncError(400, "email_not_confirmed"))).toBe(true);
    expect(isUnconfirmed(new SyncError(400, "invalid_credentials"))).toBe(false);
    expect(isRecentlySent(new SyncError(429, "email_rate_limited"))).toBe(true);
    expect(isRecentlySent(new SyncError(429, "rate_limited"))).toBe(false);
    expect(isRecentlySent(new Error("x"))).toBe(false);
  });

  it("has a sentence for every account error code", () => {
    const expected: Record<string, string> = {
      invalid_credentials: "Email or password is incorrect.",
      email_not_confirmed: "Confirm your email to finish signing in. We've sent you a new code.",
      email_taken: "An account with this email already exists. Sign in or reset your password.",
      weak_password: "That password isn't strong enough. Use at least 10 characters.",
      same_password: "Your new password must be different from your current one.",
      code_invalid: "That code is incorrect or has expired. Check it, or send a new one.",
      email_rate_limited: "We've emailed this address recently. Wait a minute, then try again.",
      rate_limited: "Too many attempts. Wait a few minutes and try again.",
      account_suspended: "This account is suspended. Contact an administrator.",
      signup_disabled: "New sign-ups are turned off on this server. Ask an administrator for an invitation.",
      invalid_input: "Check the email address and try again.",
      email_undeliverable: "This server can't send email to that address yet. Contact the administrator.",
      reauth_needed: "For your security, sign in again before changing your password.",
      unauthenticated: "Your session has ended. Please sign in again.",
      offline: "You're offline. Connect to the internet and try again.",
      network: "Can't reach the Scholea server. Check your connection and try again.",
      server_error: "Something went wrong on our side. Try again in a moment.",
      not_configured: "Accounts aren't set up in this build of Scholea.",
    };
    for (const [code, sentence] of Object.entries(expected)) {
      expect(describeAuthError(new SyncError(400, code))).toBe(sentence);
    }
  });

  it("uses the change-password wording only in that context", () => {
    const wrong = new SyncError(400, "invalid_credentials");
    expect(describeAuthError(wrong, "changePassword")).toBe("Current password is incorrect.");
    expect(describeAuthError(wrong)).toBe("Email or password is incorrect.");
  });

  it("adds the server's reasons to a weak-password message", () => {
    const pwned = new AuthWeakPasswordError("weak", 422, ["pwned"]);
    expect(describeAuthError(pwned)).toBe(
      "That password isn't strong enough. Use at least 10 characters. This password has appeared in a data breach, so choose a different one.",
    );
  });

  it("falls back to a plain sentence for anything else, and never to an em-dash", () => {
    expect(describeAuthError(new SyncError(418, "teapot"))).toBe("Something went wrong. Try again.");
    expect(describeAuthError(new SyncError(400, "constructor"))).toBe("Something went wrong. Try again.");
    expect(describeAuthError(new Error("boom"))).toBe("Something went wrong on our side. Try again in a moment.");
    expect(describeAuthError(new SyncError(418, "teapot"))).not.toContain("—");
  });
});
