/**
 * The working state of the account screens, and what each of their buttons
 * does. The screens themselves (`features/auth/AuthFlow.tsx`) only hold what
 * is being typed.
 *
 * Which step shows is decided by the pure machine in `auth-flow.ts`; this
 * store keeps the machine's state, runs the session action behind each button
 * and carries out the work the machine asks for afterwards. It lives outside
 * the dialog and is never written to the device, so closing the dialog and
 * opening it again resumes where the person was (for example at the code
 * step), while a relaunch starts clean.
 *
 * One kind of step is never out of sight: the one that settles a password that
 * is owed. An emailed code has signed the person in by then, and the account
 * may still open with a password somebody else chose. The dialog cannot be
 * closed on it, and reaching it opens the dialog.
 *
 * No password and no code is ever kept here. They are passed in for the one
 * call that needs them.
 */
import { create } from "zustand";
import {
  EMAIL_BUSY_MESSAGE,
  MAX_NAME_LENGTH,
  RESEND_COOLDOWN_MS,
  SECURITY_RESET_MESSAGE,
  authFlow,
  canResend,
  describeAuthError,
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
  type AuthOutcome,
  type AuthStep,
  type ResetKind,
} from "./auth-flow";
import { useSession } from "./session-store";

// --- Copy --------------------------------------------------------------------------

/** Announced, politely, when a code was requested again. */
export const CODE_SENT_MESSAGE = "A new code is on its way.";

/**
 * Shown on the reset step when the typed password could not be confirmed as
 * the account's and the recovery code could not be sent yet either (an email
 * went to the address moments ago).
 */
export const SECURITY_RESET_UNSENT_MESSAGE =
  "For your security, you need a new code to set your password. Send one with the button below once the timer ends.";

// --- What the screens need from the session -------------------------------------
// A narrow view of the session store, so tests can pass a plain hand-written object.

export interface AuthSession {
  signIn(email: string, password: string): Promise<void>;
  signUp(input: { name: string; email: string; password: string }): Promise<"confirm" | "signedIn">;
  confirmSignUp(email: string, code: string): Promise<void>;
  resendSignUpCode(email: string): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  verifyEmailCode(email: string, code: string, kind: ResetKind): Promise<void>;
  setPassword(next: string): Promise<void>;
  securePassword(password: string): Promise<void>;
  updateMyProfile(patch: { name?: string; institution?: string }): Promise<void>;
  signOut(): Promise<void>;
}

export interface AuthUiDeps {
  session: AuthSession;
  /** The clock, in epoch milliseconds. Tests pass their own. */
  now?: () => number;
}

// --- Forms ---------------------------------------------------------------------------

export type FieldName = "name" | "institution" | "email" | "password" | "confirm" | "code";
/** The message to show under each field that needs attention. */
export type FieldErrors = Partial<Record<FieldName, string>>;

/**
 * What a form gets back from its submit. `fields` are problems caught before
 * any request. A failure with no `fields` is described in the store's `error`.
 */
export type SubmitResult = { ok: true } | { ok: false; fields?: FieldErrors };

/** Problems with a new password and its confirmation, each under the field it belongs to. */
export function passwordFields(password: string, confirm: string): FieldErrors {
  const own = validateNewPassword(password, password);
  if (own) return { password: own };
  const both = validateNewPassword(password, confirm);
  return both ? { confirm: both } : {};
}

function hasErrors(fields: FieldErrors): boolean {
  return Object.keys(fields).length > 0;
}

// --- Rules (pure) ----------------------------------------------------------------------

/**
 * A step that waits on something already under way (a code was emailed, or the
 * account was just confirmed). Opening the dialog again returns to it instead
 * of starting over.
 */
export function isMidway(flow: AuthStep): boolean {
  if (flow.step === "confirm" || owesPassword(flow)) return true;
  return flow.step === "reset" && flow.kind === "recovery";
}

/** The person is signed in and this step is settling their password. */
export function owesPassword(flow: AuthStep): boolean {
  return flow.step === "securing" || flow.step === "setPassword" || (flow.step === "reset" && flow.reason === "security");
}

/** What the session says about a person who may still owe a password. */
export interface PendingInput {
  signedIn: boolean;
  passwordPending: boolean;
  mustSetPassword: boolean;
  email: string;
}

/** The part of the session state `PendingInput` is read from. */
export function pendingInputOf(s: {
  phase: string;
  profile: { email: string; mustSetPassword: boolean } | null;
  passwordPending: boolean;
}): PendingInput {
  const profile = s.phase === "ready" ? s.profile : null;
  return {
    signedIn: profile !== null,
    passwordPending: profile !== null && s.passwordPending,
    mustSetPassword: profile?.mustSetPassword === true,
    email: profile?.email ?? "",
  };
}

// --- Store -------------------------------------------------------------------------------

export interface AuthUiData {
  /** Whether the account dialog is showing. */
  open: boolean;
  /** Where the account screens are. Kept while the dialog is closed. */
  flow: AuthStep;
  /** A request is under way. Forms disable their buttons. */
  busy: boolean;
  /** Why the last action failed, as a sentence to show. */
  error: string | null;
  /** Something the person should know on this step that is not a failure. */
  notice: string | null;
  /** A code was sent again. `id` changes with every send, so the same text is announced again. */
  sent: { id: number; text: string } | null;
  /**
   * The last flow that ran to its end. `id` changes each time. Set once the
   * work the flow ended with is done (the name is saved), so what is said
   * about the account then is true.
   */
  finished: { id: number; outcome: AuthOutcome } | null;
  /** Whether the list of the person's project invitations is showing. */
  invitationsOpen: boolean;
}

export interface AuthUiState extends AuthUiData {
  /**
   * Show the account dialog. A step that is under way is returned to;
   * otherwise the dialog opens on the form asked for.
   */
  openAccount(step?: "signIn" | "signUp", email?: string): void;
  /** Hide the dialog. Where the person was is kept. Does nothing on a step that settles a password that is owed. */
  close(): void;
  /** A link between forms. */
  show(step: "signIn" | "signUp" | "forgot" | "invite", email?: string): void;

  signIn(input: { email: string; password: string }): Promise<SubmitResult>;
  signUp(input: { name: string; email: string; password: string; confirm: string }): Promise<SubmitResult>;
  /**
   * Enter the sign-up code. `password` is what the person typed when they
   * signed up or signed in, if the screen still has it: it becomes the
   * account's password. `null` when it is gone, and the person is asked again.
   */
  confirm(input: { code: string; password: string | null }): Promise<SubmitResult>;
  /** "Send a new code". `email` is only read on the invitation form, where the address is typed. */
  resendCode(email?: string): Promise<SubmitResult>;
  forgot(input: { email: string }): Promise<SubmitResult>;
  /** Enter a code and a new password. `email` is only read on the invitation form. */
  reset(input: { email?: string; code: string; password: string; confirm: string }): Promise<SubmitResult>;
  /**
   * Save the password that is owed. `name` and `institution` are what the
   * form showed of the account for the person to check, on a step that
   * carries no name of its own.
   */
  savePassword(input: { password: string; confirm: string; name?: string; institution?: string }): Promise<SubmitResult>;
  useDifferentEmail(): void;
  /** Leave the account instead of choosing a password. */
  signOutInstead(): Promise<void>;

  /**
   * Open the step for someone who is signed in but still owes a password.
   * Returns false, and does nothing, when nothing is owed.
   */
  resumePending(input: PendingInput): boolean;
  /**
   * The same, for launch and for changes in the background: only while the
   * account screens are untouched, or on a password step that is not showing.
   */
  autoResume(input: PendingInput): boolean;
  /** The session ended. A password step that was open has nothing left to act on. */
  sessionEnded(): void;

  openInvitations(): void;
  closeInvitations(): void;
}

/** What is left to do after a transition: the machine's own effects, and saying that a flow has ended. */
type Work = AuthEffect | { type: "finish"; id: number; outcome: AuthOutcome };

export function createAuthUi(deps: AuthUiDeps) {
  const { session } = deps;
  const now = deps.now ?? (() => Date.now());
  let seq = 0;
  /** The last address this device had a code emailed to, and when. Never kept beyond the launch. */
  let lastCode: { email: string; at: number } | null = null;

  /** A code was emailed to this address just now. */
  const noteSent = (email: string): void => {
    lastCode = { email, at: now() };
  };
  /**
   * Whether a refusal to send an email is explained by this device's own
   * request: it had a code sent to that address within the last minute, so
   * one is in the inbox. Any other refusal (the server's own limit on email,
   * or somebody else's request) means no code is on its way.
   */
  const sentHere = (email: string): boolean => lastCode !== null && lastCode.email === email && now() - lastCode.at < RESEND_COOLDOWN_MS;
  /** The sentence for a failed request for a code to this address. */
  const describeSendError = (e: unknown, email: string): string => (isRecentlySent(e) && !sentHere(email) ? EMAIL_BUSY_MESSAGE : describeAuthError(e));

  return create<AuthUiState>((set, get) => {
    /** Feed the machine. Returns the work it asks for: pass it to `run`. */
    function send(event: AuthEvent): Work[] {
      const prev = get().flow;
      const { state, effects } = authFlow(prev, event);
      if (state === prev) return effects;
      if (state.step === "done") {
        // The end of a flow: back to the start and dialog away. How it ended
        // is said last, after the rest of the work.
        seq += 1;
        set({ flow: initialAuthStep(), open: false, error: null, notice: null, sent: null });
        return [...effects, { type: "finish", id: seq, outcome: state.outcome }];
      } else {
        // A step that needs the person to settle their password shows itself,
        // even if they closed the dialog while the step before it was working.
        const mustShow = owesPassword(state) && state.step !== "securing";
        set({ flow: state, error: null, notice: null, sent: null, ...(mustShow ? { open: true } : {}) });
      }
      return effects;
    }

    /**
     * Carry out what the machine asked for. `secret` is the typed password,
     * for the one effect that needs it.
     */
    async function run(effects: Work[], secret: string | null): Promise<void> {
      for (const effect of effects) {
        switch (effect.type) {
          case "finish":
            set({ finished: { id: effect.id, outcome: effect.outcome } });
            break;

          case "resendSignUpCode":
            try {
              await session.resendSignUpCode(effect.email);
              noteSent(effect.email);
            } catch (e) {
              // Refused because this device had one sent moments ago: a code is
              // in the inbox either way. Any other refusal means none is coming.
              if (!(isRecentlySent(e) && sentHere(effect.email))) set({ error: describeSendError(e, effect.email), notice: null });
            }
            break;

          case "securePassword": {
            let next: Work[];
            let failure: unknown = null;
            try {
              await session.securePassword(secret ?? "");
              next = send({ type: "passwordSecured" });
            } catch (e) {
              const reason = passwordFailure(e);
              next = send({ type: "passwordNotSecured", reason, now: now() });
              // Kept on a password form to try again by hand: say what went wrong.
              if (reason === "failed") failure = e;
            }
            if (failure !== null) set({ error: describeAuthError(failure) });
            await run(next, secret);
            break;
          }

          case "saveName":
            try {
              await session.updateMyProfile({ name: effect.name, ...(effect.institution !== undefined ? { institution: effect.institution } : {}) });
            } catch {
              /* not shown: the name can be changed from the account menu */
            }
            break;

          case "sendRecoveryCode":
            try {
              await session.requestPasswordReset(effect.email);
              noteSent(effect.email);
              set({ notice: SECURITY_RESET_MESSAGE });
            } catch (e) {
              // No code went out. The step's own button sends one once the timer ends.
              set({ error: describeSendError(e, effect.email), notice: SECURITY_RESET_UNSENT_MESSAGE });
            }
            break;
        }
      }
    }

    /** Run one action at a time. A failure becomes the sentence in `error`. */
    async function guarded(work: () => Promise<void>): Promise<SubmitResult> {
      if (get().busy) return { ok: false };
      set({ busy: true, error: null, sent: null });
      try {
        await work();
        return { ok: true };
      } catch (e) {
        set({ error: describeAuthError(e) });
        return { ok: false };
      } finally {
        set({ busy: false });
      }
    }

    function announceSent(): void {
      seq += 1;
      set({ sent: { id: seq, text: CODE_SENT_MESSAGE } });
    }

    /** An action that put its own sentence in `error` instead of throwing still did not succeed. */
    function failedIfError(result: SubmitResult): SubmitResult {
      return result.ok && get().error !== null ? { ok: false } : result;
    }

    return {
      open: false,
      flow: initialAuthStep(),
      busy: false,
      error: null,
      notice: null,
      sent: null,
      finished: null,
      invitationsOpen: false,

      openAccount(step = "signIn", email) {
        if (!isMidway(get().flow)) send({ type: "show", step, ...(email ? { email } : {}) });
        set({ open: true });
      },

      close() {
        // Signed in, with a password still owed: saving one or signing out are the only ways on.
        if (owesPassword(get().flow)) return;
        set({ open: false });
      },

      show(step, email) {
        if (get().busy) return;
        send({ type: "show", step, ...(email !== undefined ? { email } : {}) });
      },

      async signIn({ email, password }) {
        if (get().flow.step !== "signIn") return { ok: false };
        const fields: FieldErrors = {};
        const emailError = validateEmail(email);
        if (emailError) fields.email = emailError;
        const passwordError = validateSignInPassword(password);
        if (passwordError) fields.password = passwordError;
        if (hasErrors(fields)) return { ok: false, fields };

        const address = normalizeEmail(email);
        return guarded(async () => {
          try {
            await session.signIn(address, password);
          } catch (e) {
            if (!isUnconfirmed(e)) throw e;
            // The password was right but the address is not confirmed yet:
            // send a fresh code and ask for it.
            const effects = send({ type: "signInUnconfirmed", email: address, now: now() });
            set({ notice: describeAuthError(e) });
            await run(effects, null);
            return;
          }
          await run(send({ type: "signedIn" }), null);
        });
      },

      async signUp({ name, email, password, confirm }) {
        if (get().flow.step !== "signUp") return { ok: false };
        const fields: FieldErrors = {};
        const nameError = validateName(name);
        if (nameError) fields.name = nameError;
        const emailError = validateEmail(email);
        if (emailError) fields.email = emailError;
        Object.assign(fields, passwordFields(password, confirm));
        if (hasErrors(fields)) return { ok: false, fields };

        const input = { name: name.trim(), email: normalizeEmail(email), password };
        return guarded(async () => {
          const result = await session.signUp(input);
          if (result === "confirm") noteSent(input.email);
          await run(send({ type: "signUpDone", name: input.name, email: input.email, result, now: now() }), null);
        });
      },

      async confirm({ code, password }) {
        const flow = get().flow;
        if (flow.step !== "confirm") return { ok: false };
        const codeError = validateCode(code);
        if (codeError) return { ok: false, fields: { code: codeError } };

        return guarded(async () => {
          await session.confirmSignUp(flow.email, normalizeCode(code));
          const secret = password ? password : null;
          await run(send({ type: "codeConfirmed", hasPassword: secret !== null }), secret);
        });
      },

      async resendCode(email) {
        const flow = get().flow;

        if (flow.step === "confirm") {
          if (!canResend(flow.resendAt, now())) return { ok: false };
          return guarded(async () => {
            try {
              await session.resendSignUpCode(flow.email);
            } catch (e) {
              // Refused for sending too much: the wait starts again, and the reason is shown.
              if (isRecentlySent(e)) {
                send({ type: "codeResent", now: now() });
                set({ error: describeSendError(e, flow.email) });
                return;
              }
              throw e;
            }
            noteSent(flow.email);
            send({ type: "codeResent", now: now() });
            announceSent();
          }).then(failedIfError);
        }

        if (flow.step === "reset") {
          const typed = flow.kind === "invite";
          const address = typed ? normalizeEmail(email ?? flow.email) : flow.email;
          if (typed) {
            const emailError = validateEmail(address);
            if (emailError) return { ok: false, fields: { email: emailError } };
          }
          if (!canResend(flow.resendAt, now())) return { ok: false };
          const security = flow.reason === "security";
          return guarded(async () => {
            // On the invitation form the address is typed: remember it.
            if (typed && address !== flow.email) send({ type: "show", step: "invite", email: address });
            try {
              await session.requestPasswordReset(address);
            } catch (e) {
              if (!isRecentlySent(e)) throw e;
              // Only a step that already waits for a recovery code restarts its
              // wait. An invitation code stays an invitation code.
              if (!typed) send({ type: "codeResent", now: now() });
              set({ error: describeSendError(e, address), ...(security && !typed ? { notice: SECURITY_RESET_UNSENT_MESSAGE } : {}) });
              return;
            }
            noteSent(address);
            send({ type: "codeResent", now: now() });
            if (security) set({ notice: SECURITY_RESET_MESSAGE });
            announceSent();
          }).then(failedIfError);
        }

        return { ok: false };
      },

      async forgot({ email }) {
        if (get().flow.step !== "forgot") return { ok: false };
        const emailError = validateEmail(email);
        if (emailError) return { ok: false, fields: { email: emailError } };

        const address = normalizeEmail(email);
        return guarded(async () => {
          try {
            await session.requestPasswordReset(address);
            noteSent(address);
          } catch (e) {
            // This device had a code sent to this address less than a minute
            // ago: use that one. Refused for any other reason, no code is on
            // its way, and the form says so instead of asking for one.
            if (!isRecentlySent(e)) throw e;
            if (!sentHere(address)) {
              set({ error: EMAIL_BUSY_MESSAGE });
              return;
            }
          }
          send({ type: "forgotDone", email: address, now: now() });
        }).then(failedIfError);
      },

      async reset({ email, code, password, confirm }) {
        const flow = get().flow;
        if (flow.step !== "reset") return { ok: false };
        const typed = flow.kind === "invite";
        const address = typed ? normalizeEmail(email ?? flow.email) : flow.email;

        const fields: FieldErrors = {};
        if (typed) {
          const emailError = validateEmail(address);
          if (emailError) fields.email = emailError;
        }
        const codeError = validateCode(code);
        if (codeError) fields.code = codeError;
        Object.assign(fields, passwordFields(password, confirm));
        if (hasErrors(fields)) return { ok: false, fields };

        return guarded(async () => {
          if (typed && address !== flow.email) send({ type: "show", step: "invite", email: address });
          await session.verifyEmailCode(address, normalizeCode(code), flow.kind);
          try {
            await session.setPassword(password);
          } catch (e) {
            // The code is spent and the person is signed in. Only the password is left.
            send({ type: "resetCodeAccepted" });
            throw e;
          }
          await run(send({ type: "resetDone" }), null);
        });
      },

      async savePassword({ password, confirm, name, institution }) {
        const flow = get().flow;
        if (flow.step !== "setPassword") return { ok: false };
        const fields = passwordFields(password, confirm);
        // Both are optional here. They only have to fit.
        const typedName = (name ?? "").trim();
        if (typedName) {
          const nameError = validateName(typedName);
          if (nameError) fields.name = nameError;
        }
        if ((institution ?? "").trim().length > MAX_NAME_LENGTH) fields.institution = `Use ${MAX_NAME_LENGTH} characters or fewer.`;
        if (hasErrors(fields)) return { ok: false, fields };

        return guarded(async () => {
          try {
            if (flow.via === "secure") await session.securePassword(password);
            else await session.setPassword(password);
          } catch (e) {
            const reason = passwordFailure(e);
            const effects = send({ type: "passwordNotSecured", reason, now: now() });
            if (reason === "failed") throw e;
            // Only a recovery code can settle it: one is sent and asked for.
            await run(effects, null);
            return;
          }
          const checked = typedName ? { name: typedName, ...(institution !== undefined ? { institution } : {}) } : {};
          await run(send({ type: "passwordSecured", ...checked }), null);
        });
      },

      useDifferentEmail() {
        if (get().busy) return;
        send({ type: "useDifferentEmail" });
      },

      async signOutInstead() {
        if (get().busy) return;
        set({ busy: true });
        try {
          await session.signOut();
        } catch {
          /* signing out clears this device whatever the backend says */
        } finally {
          set({ busy: false });
        }
        get().sessionEnded();
      },

      resumePending(input) {
        if (!input.signedIn) return false;
        const step = pendingPasswordStep(input);
        if (!step) return false;
        // A password step that is already under way is returned to as it is.
        if (!owesPassword(get().flow)) set({ flow: step, error: null, notice: null, sent: null });
        set({ open: true });
        return true;
      },

      autoResume(input) {
        const s = get();
        if (s.open || s.busy) return false;
        // Another form is in use (a code is awaited, say): it is left alone.
        if (s.flow.step !== "signIn" && !owesPassword(s.flow)) return false;
        return get().resumePending(input);
      },

      sessionEnded() {
        if (!owesPassword(get().flow)) return;
        set({ flow: initialAuthStep(), open: false, error: null, notice: null, sent: null });
      },

      openInvitations() {
        set({ invitationsOpen: true });
      },

      closeInvitations() {
        set({ invitationsOpen: false });
      },
    };
  });
}

// --- The app's own account screens ---------------------------------------------------

export const useAuthUi = createAuthUi({
  session: {
    signIn: (email, password) => useSession.getState().signIn(email, password),
    signUp: (input) => useSession.getState().signUp(input),
    confirmSignUp: (email, code) => useSession.getState().confirmSignUp(email, code),
    resendSignUpCode: (email) => useSession.getState().resendSignUpCode(email),
    requestPasswordReset: (email) => useSession.getState().requestPasswordReset(email),
    verifyEmailCode: (email, code, kind) => useSession.getState().verifyEmailCode(email, code, kind),
    setPassword: (next) => useSession.getState().setPassword(next),
    securePassword: (password) => useSession.getState().securePassword(password),
    updateMyProfile: (patch) => useSession.getState().updateMyProfile(patch),
    signOut: () => useSession.getState().signOut(),
  },
});

/**
 * Keep the account screens in step with the session, once, at launch: open the
 * password step for someone who is signed in but still owes one, and drop that
 * step when the session ends. Returns the undo.
 */
export function bindAuthUiToSession(): () => void {
  const check = (state: Parameters<typeof pendingInputOf>[0]) => {
    const input = pendingInputOf(state);
    if (input.signedIn) useAuthUi.getState().autoResume(input);
    else useAuthUi.getState().sessionEnded();
  };
  check(useSession.getState());
  return useSession.subscribe((state) => check(state));
}
