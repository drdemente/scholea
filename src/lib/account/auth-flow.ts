/**
 * The account screens as a pure state machine: which step is showing, what each
 * outcome leads to, and what the screen must do next. Also the field validators,
 * the resend cooldown and the error copy.
 *
 * The state holds only the step, the email, the name and the resend time.
 * Passwords and codes stay in the component and are never kept here, so the
 * state can outlive the dialog (closing and reopening resumes at the code step)
 * without holding a secret.
 *
 * Email flows use typed one-time codes, never links.
 */
import { SyncError, toSyncError, type SyncErrorDetail } from "@/lib/supabase/errors";

// --- Limits ----------------------------------------------------------------------

/**
 * How many digits a one-time code may have. The length is a server setting, so
 * the input accepts the whole range and the copy never names a number.
 */
export const CODE_LENGTH = { min: 6, max: 10 } as const;
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 72;
export const MAX_NAME_LENGTH = 200;
/** Wait this long before another code can be requested. */
export const RESEND_COOLDOWN_MS = 60_000;

/** Shown on the reset step when the typed password could not be confirmed as the account's. */
export const SECURITY_RESET_MESSAGE = "For your security, enter the new code we just sent to set your password.";

/**
 * Shown when the server refuses to send an email and this device did not ask
 * for one for that address a moment ago: the server's own limit on email was
 * reached, or somebody else asked. No code is on its way.
 */
export const EMAIL_BUSY_MESSAGE = "This server can't send more email right now. Try again in a few minutes, or contact the administrator.";

// --- Validators (each returns the message to show, or null) ------------------------

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function validateEmail(value: string): string | null {
  const email = normalizeEmail(value);
  if (!email) return "Enter your email address.";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter a valid email address.";
  return null;
}

export function validateName(value: string): string | null {
  const name = value.trim();
  if (!name) return "Enter your name.";
  if (name.length > MAX_NAME_LENGTH) return `Use ${MAX_NAME_LENGTH} characters or fewer.`;
  return null;
}

/** Sign-in only checks that something was typed; the server judges the rest. */
export function validateSignInPassword(value: string): string | null {
  return value ? null : "Enter your password.";
}

export function validateNewPassword(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Use ${MAX_PASSWORD_LENGTH} characters or fewer.`;
  if (password !== confirm) return "Passwords don't match.";
  return null;
}

/** Codes are often pasted with spaces. Strip them before checking or sending. */
export function normalizeCode(value: string): string {
  return value.replace(/\s+/g, "");
}

const CODE_PATTERN = new RegExp(`^\\d{${CODE_LENGTH.min},${CODE_LENGTH.max}}$`);

export function validateCode(value: string): string | null {
  const code = normalizeCode(value);
  if (!code) return "Enter the code from the email.";
  if (!CODE_PATTERN.test(code)) return "That doesn't look like the code from the email. Check it and try again.";
  return null;
}

// --- Resend cooldown ------------------------------------------------------------------

/** Whole seconds left before another code can be requested. 0 means ready. */
export function cooldownSeconds(resendAt: number, now: number): number {
  return Math.max(0, Math.ceil((resendAt - now) / 1000));
}

export function canResend(resendAt: number, now: number): boolean {
  return cooldownSeconds(resendAt, now) === 0;
}

/** `42` -> `0:42`, for "Send a new code in 0:42". */
export function formatCooldown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// --- State machine ----------------------------------------------------------------------

/** `recovery`: a code the person asked for. `invite`: a code an administrator sent. */
export type ResetKind = "recovery" | "invite";
export type AuthOutcome = "signedIn" | "accountCreated" | "passwordChanged";

export type AuthStep =
  | { step: "signIn"; email: string }
  | { step: "signUp"; name: string; email: string }
  /** A sign-up code was emailed. `name` is what to save once the account is confirmed. */
  | { step: "confirm"; email: string; name: string; resendAt: number }
  /**
   * The sign-up code was accepted and the person is signed in. The screen is
   * now making sure the account's password is the one they typed (see
   * `securePassword` below). Nothing to fill in; show progress.
   */
  | { step: "securing"; email: string; name: string }
  | { step: "forgot"; email: string }
  /**
   * Enter a code and choose a password. `reason` is `security` when this step
   * was reached because the typed password could not be confirmed after
   * sign-up: show `SECURITY_RESET_MESSAGE`.
   */
  | { step: "reset"; email: string; name: string; kind: ResetKind; resendAt: number; reason: "requested" | "security" }
  /**
   * The code is spent and the person is signed in, but no password is settled
   * yet. `via` says which session action saves it: `secure` after a sign-up
   * code (`securePassword`), `plain` after a recovery or invitation code
   * (`setPassword`). Either way report `passwordSecured` or
   * `passwordNotSecured`.
   *
   * There is no way past this step except a saved password or signing out.
   * The code confirmed the address, and the account may still open with a
   * password somebody else chose for it before.
   */
  | { step: "setPassword"; email: string; name: string; via: "secure" | "plain" }
  | { step: "done"; outcome: AuthOutcome };

export type AuthEvent =
  /** A link on the screen. `invite` opens the "Have an invitation code?" form. */
  | { type: "show"; step: "signIn" | "signUp" | "forgot" | "invite"; email?: string }
  | { type: "signedIn" }
  /** Sign-in was refused because the address is not confirmed yet. */
  | { type: "signInUnconfirmed"; email: string; now: number }
  | { type: "signUpDone"; name: string; email: string; result: "confirm" | "signedIn"; now: number }
  /** The sign-up code was accepted. `hasPassword`: the typed password is still in memory. */
  | { type: "codeConfirmed"; hasPassword: boolean }
  /**
   * The password is saved. `name` and `institution` are what the person left
   * in those fields of the password step, where that step showed them (it
   * carried no name of its own).
   */
  | { type: "passwordSecured"; name?: string; institution?: string }
  /** `mismatch`: the server wanted the account's current password and it is a different one. */
  | { type: "passwordNotSecured"; reason: "mismatch" | "failed"; now: number }
  /** A recovery code is on its way, or one was sent less than a minute ago. */
  | { type: "forgotDone"; email: string; now: number }
  /** On the reset step: the code and the new password were both accepted. */
  | { type: "resetDone" }
  /** On the reset step: the code was accepted but saving the password failed. */
  | { type: "resetCodeAccepted" }
  /** A new code was requested, or the server said one was sent too recently. */
  | { type: "codeResent"; now: number }
  | { type: "useDifferentEmail" }
  | { type: "restart" };

/** Work the screen must do after a transition. Each maps to one session action. */
export type AuthEffect =
  /** `session.resendSignUpCode(email)` */
  | { type: "resendSignUpCode"; email: string }
  /**
   * `session.securePassword(<typed password>)`, then report `passwordSecured`
   * or `passwordNotSecured` (use `passwordFailure` to pick the reason).
   */
  | { type: "securePassword" }
  /**
   * `session.updateMyProfile({ name, institution })`. A failure here is not
   * shown: both can be changed from the account menu. `institution` is left
   * out when it is not to be touched. It is empty when the name was typed on
   * this device's own sign-up form: that form asks for no institution, so one
   * that is on the account was put there by whoever registered the address
   * first.
   */
  | { type: "saveName"; name: string; institution?: string }
  /**
   * `session.requestPasswordReset(email)`. If it is refused (an email went to
   * this address moments ago), show the error: the step's own "Send a new code"
   * button sends one once the cooldown ends.
   */
  | { type: "sendRecoveryCode"; email: string };

export interface AuthTransition {
  state: AuthStep;
  effects: AuthEffect[];
}

export function initialAuthStep(email = ""): AuthStep {
  return { step: "signIn", email };
}

/**
 * The step to open for someone who is signed in but still owes a password:
 * a sign-up whose password was never confirmed (`passwordPending`), or an
 * invited person who has not chosen one (`mustSetPassword`). `null` otherwise.
 */
export function pendingPasswordStep(input: { passwordPending: boolean; mustSetPassword: boolean; email: string }): AuthStep | null {
  if (input.mustSetPassword) return { step: "setPassword", email: input.email, name: "", via: "plain" };
  if (input.passwordPending) return { step: "setPassword", email: input.email, name: "", via: "secure" };
  return null;
}

/** `institution`: what to set it to with the name. Left out, it is not touched. */
function saveName(name: string, institution?: string): AuthEffect[] {
  if (!name.trim()) return [];
  return [{ type: "saveName", name: name.trim(), ...(institution !== undefined ? { institution: institution.trim() } : {}) }];
}

/** The name was typed on the sign-up form, which asks for no institution: the account's is cleared with it. */
const NO_INSTITUTION = "";

/**
 * The password typed at sign-up could not be confirmed as the account's own.
 * Only a recovery code proves ownership of the address strongly enough to set
 * one, so send it and move to the reset step.
 */
function fallBackToRecovery(email: string, name: string, now: number): AuthTransition {
  return {
    state: { step: "reset", email, name, kind: "recovery", resendAt: now + RESEND_COOLDOWN_MS, reason: "security" },
    effects: [{ type: "sendRecoveryCode", email }],
  };
}

export function authFlow(state: AuthStep, event: AuthEvent): AuthTransition {
  const stay: AuthTransition = { state, effects: [] };
  const go = (next: AuthStep, effects: AuthEffect[] = []): AuthTransition => ({ state: next, effects });

  if (event.type === "restart") return go(initialAuthStep());

  if (event.type === "show") {
    // Mid-way through securing the account there is nowhere else to go.
    if (state.step === "securing" || state.step === "setPassword") return stay;
    const email = event.email ?? ("email" in state ? state.email : "");
    switch (event.step) {
      case "signIn":
        return go({ step: "signIn", email });
      case "signUp":
        return go({ step: "signUp", name: "name" in state ? state.name : "", email });
      case "forgot":
        return go({ step: "forgot", email });
      case "invite":
        // No email is sent here: the administrator's invitation carried the code.
        return go({ step: "reset", email, name: "", kind: "invite", resendAt: 0, reason: "requested" });
    }
  }

  switch (state.step) {
    case "signIn":
      if (event.type === "signedIn") return go({ step: "done", outcome: "signedIn" });
      if (event.type === "signInUnconfirmed") {
        return go({ step: "confirm", email: event.email, name: "", resendAt: event.now + RESEND_COOLDOWN_MS }, [
          { type: "resendSignUpCode", email: event.email },
        ]);
      }
      return stay;

    case "signUp":
      if (event.type !== "signUpDone") return stay;
      if (event.result === "signedIn") return go({ step: "done", outcome: "accountCreated" });
      return go({ step: "confirm", email: event.email, name: event.name, resendAt: event.now + RESEND_COOLDOWN_MS });

    case "confirm":
      if (event.type === "codeConfirmed") {
        // An address can be registered by someone else before its owner
        // confirms it, and the account would keep their password. So the
        // password typed here is written over whatever is there.
        if (event.hasPassword) return go({ step: "securing", email: state.email, name: state.name }, [{ type: "securePassword" }]);
        // The dialog was closed and reopened: the typed password is gone. Ask again.
        return go({ step: "setPassword", email: state.email, name: state.name, via: "secure" });
      }
      if (event.type === "codeResent") return go({ ...state, resendAt: event.now + RESEND_COOLDOWN_MS });
      if (event.type === "useDifferentEmail") return go({ step: "signUp", name: state.name, email: state.email });
      return stay;

    case "securing":
      if (event.type === "passwordSecured") return go({ step: "done", outcome: "accountCreated" }, saveName(state.name, NO_INSTITUTION));
      if (event.type === "passwordNotSecured") {
        if (event.reason === "mismatch") return fallBackToRecovery(state.email, state.name, event.now);
        // Offline or refused for another reason: let the person try again by hand.
        return go({ step: "setPassword", email: state.email, name: state.name, via: "secure" });
      }
      return stay;

    case "forgot":
      if (event.type !== "forgotDone") return stay;
      return go({
        step: "reset",
        email: event.email,
        name: "",
        kind: "recovery",
        resendAt: event.now + RESEND_COOLDOWN_MS,
        reason: "requested",
      });

    case "reset":
      if (event.type === "resetDone") return go({ step: "done", outcome: "passwordChanged" }, saveName(state.name, NO_INSTITUTION));
      if (event.type === "resetCodeAccepted") {
        // The code is spent, so it is not asked for again. It also confirmed
        // the address, whatever kind of code it was: only a saved password
        // makes the account this person's alone.
        return go({ step: "setPassword", email: state.email, name: state.name, via: "plain" });
      }
      if (event.type === "codeResent") {
        // A new code is always a recovery code, which also works for an
        // invitation that has expired.
        return go({ ...state, kind: "recovery", resendAt: event.now + RESEND_COOLDOWN_MS });
      }
      return stay;

    case "setPassword":
      if (event.type === "passwordSecured") {
        const outcome: AuthOutcome = state.via === "secure" ? "accountCreated" : "passwordChanged";
        // A name the step carries came from the sign-up form. Otherwise the
        // step showed the account's name and institution for the person to
        // check, and what they left there is saved.
        const effects = state.name.trim() ? saveName(state.name, NO_INSTITUTION) : saveName(event.name ?? "", event.institution);
        return go({ step: "done", outcome }, effects);
      }
      if (event.type === "passwordNotSecured" && event.reason === "mismatch") {
        return fallBackToRecovery(state.email, state.name, event.now);
      }
      return stay;

    case "done":
      return stay;
  }
}

// --- Reading errors ---------------------------------------------------------------------

/**
 * Why saving a password failed. `mismatch` means the server wanted the
 * account's current password and it is not the one supplied (or the session is
 * too old to change a password): only a recovery code can settle it.
 */
export function passwordFailure(e: unknown): "mismatch" | "failed" {
  const code = toSyncError(e).code;
  return code === "invalid_credentials" || code === "reauth_needed" ? "mismatch" : "failed";
}

/** Sign-in was refused only because the address still needs confirming. */
export function isUnconfirmed(e: unknown): boolean {
  return e instanceof SyncError && e.code === "email_not_confirmed";
}

/**
 * A code request that was refused because one was sent moments ago. The flow
 * still moves on (and the cooldown restarts): a code is already in the inbox.
 */
export function isRecentlySent(e: unknown): boolean {
  return e instanceof SyncError && e.code === "email_rate_limited";
}

const COPY: Record<string, string> = {
  invalid_credentials: "Email or password is incorrect.",
  email_not_confirmed: "Confirm your email to finish signing in. We've sent you a new code.",
  email_taken: "An account with this email already exists. Sign in or reset your password.",
  weak_password: `That password isn't strong enough. Use at least ${MIN_PASSWORD_LENGTH} characters.`,
  same_password: "Your new password must be different from your current one.",
  code_invalid: "That code is incorrect or has expired. Check it, or send a new one.",
  email_rate_limited: "We've emailed this address recently. Wait a minute, then try again.",
  rate_limited: "Too many attempts. Wait a few minutes and try again.",
  account_suspended: "This account is suspended. Contact an administrator.",
  password_reset_required: "Choose a password to finish setting up your account.",
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

const WEAK_REASONS: Record<string, string> = {
  characters: "Mix letters, numbers and symbols.",
  pwned: "This password has appeared in a data breach, so choose a different one.",
};

/**
 * The sentence to show for a failed account action. Sign-in has one message
 * for every wrong email or password, and every code failure shares one, so the
 * copy never reveals whether an address has an account.
 */
export function describeAuthError(e: unknown, context?: "changePassword"): string {
  const err = toSyncError(e);
  if (err.code === "invalid_credentials" && context === "changePassword") return "Current password is incorrect.";
  const base = Object.hasOwn(COPY, err.code) ? COPY[err.code] : "Something went wrong. Try again.";
  if (err.code !== "weak_password") return base;
  const reasons = (err.payload as SyncErrorDetail | undefined)?.reasons ?? [];
  const extra = reasons.filter((r) => Object.hasOwn(WEAK_REASONS, r)).map((r) => WEAK_REASONS[r]);
  return [base, ...extra].join(" ");
}
