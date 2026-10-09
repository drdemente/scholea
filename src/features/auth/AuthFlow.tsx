import { useEffect, useRef, useState, type FormEvent, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { CheckCircle2, Info, Loader2, LogIn } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { ErrorNote, PasswordField, TextField } from "@/components/ui";
import { CODE_LENGTH, MAX_NAME_LENGTH, MIN_PASSWORD_LENGTH, cooldownSeconds, formatCooldown, type AuthStep } from "@/lib/account/auth-flow";
import { useAuthUi, type FieldErrors, type SubmitResult } from "@/lib/account/auth-ui";
import { useSession } from "@/lib/account/session-store";
import { focusFirstField } from "./focus";

/**
 * The account screens: sign in, create an account, enter an emailed code,
 * reset a password, and choose one after an invitation. One form at a time,
 * picked by the step in `useAuthUi`; that store also runs every action, so
 * this file only holds what is being typed.
 *
 * It has no frame of its own. `AccountDialog` shows it in a dialog; with
 * `heading="h1"` it can also stand on a page of its own.
 */
export interface AuthFlowProps {
  /** `h2` inside a dialog (the default), `h1` on a page of its own. */
  heading?: "h1" | "h2";
  /** Id for the heading, so a dialog can be labelled by it. */
  headingId?: string;
  /** Replaces the title of the sign-in form. */
  title?: string;
  /** Replaces the sentence under the title of the sign-in form. */
  subtitle?: string;
  /** False leaves no way to the "Create your account" form from here. */
  allowSignUp?: boolean;
  /** Adds the reminder that Scholea works without an account. */
  guestNote?: boolean;
}

/** Room for a code pasted with spaces between its digits; the spaces are dropped before it is checked. */
const CODE_INPUT_MAX = CODE_LENGTH.max * 2;
const PASSWORD_HELP = `At least ${MIN_PASSWORD_LENGTH} characters.`;

type TypedPassword = MutableRefObject<string | null>;

interface Frame {
  heading: "h1" | "h2";
  headingId?: string;
}

export function AuthFlow({ heading = "h2", headingId, title, subtitle, allowSignUp = true, guestNote = false }: AuthFlowProps) {
  const flow = useAuthUi((s) => s.flow);
  const show = useAuthUi((s) => s.show);
  const root = useRef<HTMLDivElement>(null);
  // The password typed at sign-up or sign-in, kept only while its code is
  // awaited, so the confirmed account ends up with it. It lives and dies with
  // this component and is never stored.
  const typed = useRef<string | null>(null);

  // A new step: move focus to its first field (or its heading when it has none).
  useEffect(() => focusFirstField(() => root.current), [flow.step]);

  useEffect(() => {
    if (flow.step !== "signIn" && flow.step !== "signUp" && flow.step !== "confirm" && flow.step !== "securing") typed.current = null;
  }, [flow.step]);

  // Where nobody may create an account, the sign-up form is never shown,
  // whichever way the screens got to it: they go back to the sign-in form.
  const signUpBarred = !allowSignUp && flow.step === "signUp";
  const barredEmail = signUpBarred ? flow.email : "";
  useEffect(() => {
    if (signUpBarred) show("signIn", barredEmail);
  }, [signUpBarred, barredEmail, show]);

  const frame: Frame = { heading, headingId };

  return (
    <div ref={root}>
      {flow.step === "signIn" && (
        <SignInForm frame={frame} flow={flow} typed={typed} title={title} subtitle={subtitle} allowSignUp={allowSignUp} guestNote={guestNote} />
      )}
      {flow.step === "signUp" && allowSignUp && <SignUpForm frame={frame} flow={flow} typed={typed} />}
      {flow.step === "confirm" && <ConfirmForm frame={frame} flow={flow} typed={typed} allowSignUp={allowSignUp} />}
      {flow.step === "securing" && <Securing frame={frame} />}
      {flow.step === "forgot" && <ForgotForm frame={frame} flow={flow} />}
      {flow.step === "reset" && <ResetForm frame={frame} flow={flow} />}
      {flow.step === "setPassword" && <SetPasswordForm frame={frame} flow={flow} />}
    </div>
  );
}

// --- Shared pieces -------------------------------------------------------------------

function Heading({ frame, children }: { frame: Frame; children: ReactNode }) {
  const Tag = frame.heading;
  return (
    <Tag
      id={frame.headingId}
      tabIndex={-1}
      data-auth-heading=""
      className={`rounded-input font-bold text-ink outline-none focus-visible:focus-ring ${frame.heading === "h1" ? "text-xl" : "text-lg"}`}
    >
      {children}
    </Tag>
  );
}

function Body({ children }: { children: ReactNode }) {
  return <p className="text-sm text-ink-soft">{children}</p>;
}

/** What the last action left to say: a note for this step, and why it failed if it did. */
function Notes() {
  const notice = useAuthUi((s) => s.notice);
  const error = useAuthUi((s) => s.error);
  return (
    <>
      {notice && (
        <p role="status" className="flex items-start gap-2 rounded-input bg-info-soft p-3 text-sm text-ink">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{notice}</span>
        </p>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </>
  );
}

function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  const busy = useAuthUi((s) => s.busy);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="rounded-input text-sm font-medium text-ink underline underline-offset-2 hover:text-primary focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function Links({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">{children}</div>;
}

/**
 * The account's address on a form that only asks for a new password, so a
 * password manager files the password under the right account. Not shown, not
 * reachable by keyboard.
 */
function UsernameHint({ email }: { email: string }) {
  if (!email) return null;
  return <input type="text" name="username" autoComplete="username" value={email} readOnly tabIndex={-1} aria-hidden="true" className="sr-only" />;
}

/** Field messages from the last submit. Focus goes to the first field that needs attention. */
function useFieldErrors(form: RefObject<HTMLFormElement>) {
  const [errors, setErrors] = useState<FieldErrors>({});
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (attempt > 0) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [attempt, form]);

  const report = (result: SubmitResult) => {
    const fields = result.ok ? {} : (result.fields ?? {});
    setErrors(fields);
    if (Object.keys(fields).length > 0) setAttempt((n) => n + 1);
  };
  return { errors, report };
}

/** Whole seconds until another code can be asked for, counting down while it is above zero. */
function useCooldown(resendAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (resendAt <= Date.now()) return;
    const timer = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= resendAt) window.clearInterval(timer);
    }, 500);
    return () => window.clearInterval(timer);
  }, [resendAt]);
  return cooldownSeconds(resendAt, now);
}

/**
 * "Send a new code". While the wait runs the button is disabled and its own
 * text counts down. Only the fact that a code was sent is announced, not each
 * second.
 */
function ResendButton({ resendAt, label, onResend }: { resendAt: number; label: string; onResend: () => void }) {
  const busy = useAuthUi((s) => s.busy);
  const sent = useAuthUi((s) => s.sent);
  const seconds = useCooldown(resendAt);
  return (
    <div className="flex flex-col items-center gap-1">
      <GlassButton type="button" variant="ghost" size="sm" disabled={busy || seconds > 0} onClick={onResend}>
        {seconds > 0 ? `Send a new code in ${formatCooldown(seconds)}` : label}
      </GlassButton>
      <p role="status" aria-live="polite" className="text-center text-xs font-medium text-ink">
        {sent && (
          <span key={sent.id} className="inline-flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {sent.text}
          </span>
        )}
      </p>
    </div>
  );
}

// --- Steps ------------------------------------------------------------------------------

function SignInForm({
  frame,
  flow,
  typed,
  title,
  subtitle,
  allowSignUp,
  guestNote,
}: {
  frame: Frame;
  flow: Extract<AuthStep, { step: "signIn" }>;
  typed: TypedPassword;
  title?: string;
  subtitle?: string;
  allowSignUp: boolean;
  guestNote: boolean;
}) {
  const busy = useAuthUi((s) => s.busy);
  const signIn = useAuthUi((s) => s.signIn);
  const show = useAuthUi((s) => s.show);
  const form = useRef<HTMLFormElement>(null);
  const { errors, report } = useFieldErrors(form);
  const [email, setEmail] = useState(flow.email);
  const [password, setPassword] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // If the address turns out to be unconfirmed, the code step follows and
    // this is the password the account then keeps.
    typed.current = password;
    report(await signIn({ email, password }));
  };

  return (
    <form ref={form} onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <Heading frame={frame}>{title ?? "Sign in to Scholea"}</Heading>
      <Body>{subtitle ?? "Sign in to sync your projects across devices and work with collaborators."}</Body>
      <TextField label="Email" type="email" value={email} onChange={setEmail} required autoComplete="username" error={errors.email} />
      <PasswordField label="Password" value={password} onChange={setPassword} required autoComplete="current-password" error={errors.password} />
      <Notes />
      <GlassButton type="submit" loading={busy} className="w-full justify-center">
        {!busy && <LogIn className="h-4 w-4" aria-hidden="true" />}
        Sign in
      </GlassButton>
      <Links>
        <LinkButton onClick={() => show("forgot", email.trim())}>Forgot password?</LinkButton>
        {allowSignUp && <LinkButton onClick={() => show("signUp", email.trim())}>Create an account</LinkButton>}
        <LinkButton onClick={() => show("invite", email.trim())}>Have an invitation code?</LinkButton>
      </Links>
      {guestNote && (
        <p className="text-center text-xs text-ink-soft">You can keep using Scholea without an account. Your work stays on this device.</p>
      )}
    </form>
  );
}

function SignUpForm({ frame, flow, typed }: { frame: Frame; flow: Extract<AuthStep, { step: "signUp" }>; typed: TypedPassword }) {
  const busy = useAuthUi((s) => s.busy);
  const signUp = useAuthUi((s) => s.signUp);
  const show = useAuthUi((s) => s.show);
  const form = useRef<HTMLFormElement>(null);
  const { errors, report } = useFieldErrors(form);
  const [name, setName] = useState(flow.name);
  const [email, setEmail] = useState(flow.email);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    typed.current = password;
    report(await signUp({ name, email, password, confirm }));
  };

  return (
    <form ref={form} onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <Heading frame={frame}>Create your account</Heading>
      <Body>Your projects stay on this device and also sync to your account.</Body>
      <TextField label="Your name" value={name} onChange={setName} required autoComplete="name" error={errors.name} />
      <TextField label="Email" type="email" value={email} onChange={setEmail} required autoComplete="email" error={errors.email} />
      <PasswordField
        label="Password"
        value={password}
        onChange={setPassword}
        required
        autoComplete="new-password"
        help={PASSWORD_HELP}
        error={errors.password}
      />
      <PasswordField label="Confirm password" value={confirm} onChange={setConfirm} required autoComplete="new-password" error={errors.confirm} />
      <p className="text-xs text-ink-soft">We'll email you a code to confirm your address.</p>
      <Notes />
      <GlassButton type="submit" loading={busy} className="w-full justify-center">
        Create account
      </GlassButton>
      <Links>
        <LinkButton onClick={() => show("signIn", email.trim())}>Already have an account? Sign in</LinkButton>
      </Links>
    </form>
  );
}

function ConfirmForm({
  frame,
  flow,
  typed,
  allowSignUp,
}: {
  frame: Frame;
  flow: Extract<AuthStep, { step: "confirm" }>;
  typed: TypedPassword;
  allowSignUp: boolean;
}) {
  const busy = useAuthUi((s) => s.busy);
  const confirm = useAuthUi((s) => s.confirm);
  const resendCode = useAuthUi((s) => s.resendCode);
  const useDifferentEmail = useAuthUi((s) => s.useDifferentEmail);
  const show = useAuthUi((s) => s.show);
  const form = useRef<HTMLFormElement>(null);
  const { errors, report } = useFieldErrors(form);
  const [code, setCode] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    report(await confirm({ code, password: typed.current }));
  };

  return (
    <form ref={form} onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <Heading frame={frame}>Check your email</Heading>
      <Body>
        We sent a confirmation code to <strong className="[overflow-wrap:anywhere] font-semibold text-ink">{flow.email}</strong>. Enter it below to finish
        creating your account.
      </Body>
      <TextField
        label="Confirmation code"
        value={code}
        onChange={setCode}
        required
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={CODE_INPUT_MAX}
        error={errors.code}
      />
      <p className="text-xs text-ink-soft">
        No email after a few minutes? Check your spam folder. If you already have a Scholea account with this address, no code is sent.{" "}
        <InlineLink onClick={() => show("signIn", flow.email)}>Sign in</InlineLink> or{" "}
        <InlineLink onClick={() => show("forgot", flow.email)}>reset your password</InlineLink> instead.
      </p>
      <Notes />
      <GlassButton type="submit" loading={busy} className="w-full justify-center">
        Confirm and sign in
      </GlassButton>
      <ResendButton resendAt={flow.resendAt} label="Send a new code" onResend={() => void resendCode().then(report)} />
      <Links>
        {allowSignUp ? (
          <LinkButton onClick={useDifferentEmail}>Use a different email</LinkButton>
        ) : (
          // "Use a different email" leads to the sign-up form, which this surface does not offer.
          <LinkButton onClick={() => show("signIn", flow.email)}>Back to sign in</LinkButton>
        )}
      </Links>
    </form>
  );
}

function InlineLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  const busy = useAuthUi((s) => s.busy);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="rounded-input font-medium text-ink underline underline-offset-2 hover:text-primary focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** The sign-up code was accepted; the typed password is being made the account's. Nothing to fill in. */
function Securing({ frame }: { frame: Frame }) {
  return (
    <div className="flex flex-col gap-4">
      <Heading frame={frame}>Finishing up</Heading>
      <p role="status" className="flex items-center gap-2 text-sm text-ink-soft">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        Your code was accepted. Setting up your account…
      </p>
    </div>
  );
}

function ForgotForm({ frame, flow }: { frame: Frame; flow: Extract<AuthStep, { step: "forgot" }> }) {
  const busy = useAuthUi((s) => s.busy);
  const forgot = useAuthUi((s) => s.forgot);
  const show = useAuthUi((s) => s.show);
  const form = useRef<HTMLFormElement>(null);
  const { errors, report } = useFieldErrors(form);
  const [email, setEmail] = useState(flow.email);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    report(await forgot({ email }));
  };

  return (
    <form ref={form} onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <Heading frame={frame}>Reset your password</Heading>
      <Body>Enter your account email and we'll send you a code to set a new password.</Body>
      <TextField label="Email" type="email" value={email} onChange={setEmail} required autoComplete="username" error={errors.email} />
      <Notes />
      <GlassButton type="submit" loading={busy} className="w-full justify-center">
        Email me a code
      </GlassButton>
      <Links>
        <LinkButton onClick={() => show("signIn", email.trim())}>Back to sign in</LinkButton>
      </Links>
    </form>
  );
}

function ResetForm({ frame, flow }: { frame: Frame; flow: Extract<AuthStep, { step: "reset" }> }) {
  const busy = useAuthUi((s) => s.busy);
  const reset = useAuthUi((s) => s.reset);
  const resendCode = useAuthUi((s) => s.resendCode);
  const show = useAuthUi((s) => s.show);
  const signOutInstead = useAuthUi((s) => s.signOutInstead);
  const form = useRef<HTMLFormElement>(null);
  const { errors, report } = useFieldErrors(form);
  const [email, setEmail] = useState(flow.email);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const invited = flow.kind === "invite";
  // Reached because the password typed at sign-up could not be confirmed. The
  // person is signed in already, and the note above the button says why a code is needed.
  const security = flow.reason === "security";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    report(await reset({ email, code, password, confirm }));
  };

  return (
    <form ref={form} onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <Heading frame={frame}>{invited ? "Set your password" : "Set a new password"}</Heading>
      {invited ? (
        <Body>Enter the email your invitation was sent to, the code from that email, and a password.</Body>
      ) : security ? (
        <Body>
          Enter the code sent to <strong className="[overflow-wrap:anywhere] font-semibold text-ink">{flow.email}</strong> and choose a password.
        </Body>
      ) : (
        <Body>
          If an account exists for <strong className="[overflow-wrap:anywhere] font-semibold text-ink">{flow.email}</strong>, we've emailed it a code. Enter
          the code and choose a new password.
        </Body>
      )}
      {invited ? (
        <TextField label="Email" type="email" value={email} onChange={setEmail} required autoComplete="username" error={errors.email} />
      ) : (
        <UsernameHint email={flow.email} />
      )}
      <TextField
        label="Code from the email"
        value={code}
        onChange={setCode}
        required
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={CODE_INPUT_MAX}
        error={errors.code}
      />
      <PasswordField
        label={invited ? "Password" : "New password"}
        value={password}
        onChange={setPassword}
        required
        autoComplete="new-password"
        help={PASSWORD_HELP}
        error={errors.password}
      />
      <PasswordField
        label={invited ? "Confirm password" : "Confirm new password"}
        value={confirm}
        onChange={setConfirm}
        required
        autoComplete="new-password"
        error={errors.confirm}
      />
      <Notes />
      <GlassButton type="submit" loading={busy} className="w-full justify-center">
        Set password and sign in
      </GlassButton>
      <ResendButton
        resendAt={flow.resendAt}
        label={invited ? "Code expired? Email me a new one" : "Send a new code"}
        onResend={() => void resendCode(email).then(report)}
      />
      <Links>
        {security ? (
          <LinkButton onClick={() => void signOutInstead()}>Sign out instead</LinkButton>
        ) : (
          <LinkButton onClick={() => show("signIn", invited ? email.trim() : flow.email)}>Back to sign in</LinkButton>
        )}
      </Links>
    </form>
  );
}

function SetPasswordForm({ frame, flow }: { frame: Frame; flow: Extract<AuthStep, { step: "setPassword" }> }) {
  const busy = useAuthUi((s) => s.busy);
  const savePassword = useAuthUi((s) => s.savePassword);
  const signOutInstead = useAuthUi((s) => s.signOutInstead);
  const form = useRef<HTMLFormElement>(null);
  const { errors, report } = useFieldErrors(form);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  // This step did not come with the name typed at sign-up (the app was closed
  // in between, or the code was a reset or an invitation). The account's name
  // is shown for the person to check: if somebody else registered this address
  // before them, it is that person's choice.
  const asksName = flow.name.trim() === "";
  const accountName = useSession((s) => (s.phase === "ready" ? (s.profile?.name ?? "") : ""));
  const accountInstitution = useSession((s) => (s.phase === "ready" ? (s.profile?.institution ?? "") : ""));
  const [name, setName] = useState(accountName);
  const [institution, setInstitution] = useState(accountInstitution);
  const touched = useRef({ name: false, institution: false });
  // The account record can arrive a moment after the form: fill each field in then, unless it was typed in already.
  useEffect(() => {
    if (!touched.current.name) setName(accountName);
  }, [accountName]);
  useEffect(() => {
    if (!touched.current.institution) setInstitution(accountInstitution);
  }, [accountInstitution]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    report(await savePassword({ password, confirm, ...(asksName ? { name, institution } : {}) }));
  };

  return (
    <form ref={form} onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <Heading frame={frame}>Choose a password</Heading>
      <Body>Your code was accepted and you're signed in. Choose a password to finish. Until you do, nothing is synced to this account.</Body>
      <UsernameHint email={flow.email} />
      <PasswordField
        label="Password"
        value={password}
        onChange={setPassword}
        required
        autoComplete="new-password"
        help={PASSWORD_HELP}
        error={errors.password}
      />
      <PasswordField label="Confirm password" value={confirm} onChange={setConfirm} required autoComplete="new-password" error={errors.confirm} />
      {asksName && (
        <>
          <TextField
            label="Your name"
            value={name}
            onChange={(value) => {
              touched.current.name = true;
              setName(value);
            }}
            autoComplete="name"
            maxLength={MAX_NAME_LENGTH}
            error={errors.name}
            help="Shown to the people you work with. Check that it is yours."
          />
          <TextField
            label="Institution"
            value={institution}
            onChange={(value) => {
              touched.current.institution = true;
              setInstitution(value);
            }}
            autoComplete="organization"
            maxLength={MAX_NAME_LENGTH}
            error={errors.institution}
            help="Optional. Check this too."
          />
        </>
      )}
      <Notes />
      <GlassButton type="submit" loading={busy} className="w-full justify-center">
        Save password
      </GlassButton>
      <Links>
        {/* The address was confirmed by the code, and the password on the account may be somebody else's.
            So the only other way out is to leave the account. */}
        <LinkButton onClick={() => void signOutInstead()}>Sign out instead</LinkButton>
      </Links>
    </form>
  );
}
