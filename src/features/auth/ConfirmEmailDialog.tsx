import { useEffect, useRef, useState, type FormEvent } from "react";
import { CheckCircle2 } from "lucide-react";
import { GlassButton, GlassOverlay } from "@/components/glass";
import { ErrorNote, TextField, toast } from "@/components/ui";
import { CODE_LENGTH, cooldownSeconds, describeAuthError, formatCooldown, normalizeCode, validateCode } from "@/lib/account/auth-flow";
import { CODE_SENT_MESSAGE } from "@/lib/account/auth-ui";
import { emailProof } from "@/lib/account/email-proof";
import {
  PROOF_CODE_AFTER,
  PROOF_CODE_BEFORE,
  PROOF_CODE_HELP,
  PROOF_CONFIRM_LABEL,
  PROOF_DONE_MESSAGE,
  PROOF_OFFER_AFTER,
  PROOF_OFFER_BEFORE,
  PROOF_RESEND_LABEL,
  PROOF_SEND_LABEL,
  PROOF_TITLE,
  PROOF_UNRECORDED_MESSAGE,
  afterSend,
  afterVerify,
  sendResult,
  type ProofStep,
} from "@/lib/account/email-proof-flow";
import { useInvitations } from "@/lib/collab/invitations";
import { focusFirstField } from "./focus";

/** Room for a code pasted with spaces between its digits; the spaces are dropped before it is checked. */
const CODE_INPUT_MAX = CODE_LENGTH.max * 2;

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
 * Proves that the account's email address is the person's own, with a sign-in
 * code sent to it. Only offered when the backend says the address is unproven,
 * which happens after an administrator changed it. Until then the person sees
 * no project invitations sent to that address.
 *
 * The code step works like the ones on the account screens: a typed code,
 * never a link, and a wait before another one can be asked for. The steps and
 * the copy are in `lib/account/email-proof-flow`.
 */
export function ConfirmEmailDialog({ email, onClose, onConfirmed }: { email: string; onClose: () => void; onConfirmed: () => void }) {
  const [flow, setFlow] = useState<ProofStep>({ step: "offer" });
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  /** How many times a new code was announced, so the same words are read out again. */
  const [announced, setAnnounced] = useState(0);
  const [refused, setRefused] = useState(0);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const seconds = useCooldown(flow.step === "code" ? flow.resendAt : 0);

  // The code step has one field: that is where typing should land.
  useEffect(() => {
    if (flow.step !== "code") return;
    return focusFirstField(() => form.current);
  }, [flow.step]);

  // A code that cannot be right: back to the field that needs attention.
  useEffect(() => {
    if (refused > 0) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [refused]);

  const send = async () => {
    setError(null);
    setBusy(true);
    let failure: unknown = null;
    try {
      await emailProof.sendCode(email);
    } catch (e) {
      failure = e;
    }
    const next = afterSend(flow, sendResult(failure), Date.now());
    setFlow(next.state);
    if (next.showError) setError(describeAuthError(failure));
    if (next.announce) setAnnounced((n) => n + 1);
    setBusy(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (flow.step === "offer") return void send();
    setError(null);
    const problem = validateCode(code);
    setCodeError(problem ?? undefined);
    if (problem) return setRefused((n) => n + 1);
    setBusy(true);
    try {
      await emailProof.verify(email, normalizeCode(code));
      // The code was right. What counts is whether the backend now lists the address as proven.
      if (afterVerify(await emailProof.isConfirmed()) === "unrecorded") {
        setError(PROOF_UNRECORDED_MESSAGE);
        return;
      }
      onConfirmed();
      toast.success(PROOF_DONE_MESSAGE);
      // Invitations sent to this address can be seen from now on.
      void useInvitations.getState().refresh();
      onClose();
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <GlassOverlay open onClose={onClose} labelledBy="confirm-email-title" className="max-h-[calc(100dvh-2rem)] w-full !max-w-sm overflow-y-auto !p-6">
      <form ref={form} onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <h2 id="confirm-email-title" className="text-lg font-bold text-ink">
          {PROOF_TITLE}
        </h2>
        {flow.step === "code" ? (
          <>
            <p className="text-sm text-ink-soft">
              {PROOF_CODE_BEFORE} <strong className="[overflow-wrap:anywhere] font-semibold text-ink">{email}</strong>. {PROOF_CODE_AFTER}
            </p>
            <TextField
              label="Code from the email"
              value={code}
              onChange={setCode}
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={CODE_INPUT_MAX}
              error={codeError}
            />
            <p className="text-xs text-ink-soft">{PROOF_CODE_HELP}</p>
          </>
        ) : (
          <p className="text-sm text-ink-soft">
            {PROOF_OFFER_BEFORE} <strong className="[overflow-wrap:anywhere] font-semibold text-ink">{email}</strong> {PROOF_OFFER_AFTER}
          </p>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
        <GlassButton type="submit" loading={busy} className="w-full justify-center">
          {flow.step === "code" ? PROOF_CONFIRM_LABEL : PROOF_SEND_LABEL}
        </GlassButton>
        {flow.step === "code" && (
          // While the wait runs the button is disabled and its own text counts
          // down. Only the fact that a code was sent is announced, not each second.
          <div className="flex flex-col items-center gap-1">
            <GlassButton type="button" variant="ghost" size="sm" disabled={busy || seconds > 0} onClick={() => void send()}>
              {seconds > 0 ? `${PROOF_RESEND_LABEL} in ${formatCooldown(seconds)}` : PROOF_RESEND_LABEL}
            </GlassButton>
            <p role="status" aria-live="polite" className="text-center text-xs font-medium text-ink">
              {announced > 0 && (
                <span key={announced} className="inline-flex items-center gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {CODE_SENT_MESSAGE}
                </span>
              )}
            </p>
          </div>
        )}
        <div className="flex justify-center">
          <GlassButton type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </GlassButton>
        </div>
      </form>
    </GlassOverlay>
  );
}
