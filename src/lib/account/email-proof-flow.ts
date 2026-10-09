/**
 * The "Confirm your email address" dialog as pure rules: which step is showing,
 * what a send or a check of the code leads to, and the copy. It follows the
 * account screens (`auth-flow.ts`): a typed one-time code, never a link, the
 * same wait before another code can be asked for, and one message for every
 * code failure.
 *
 * The dialog is only offered to someone who is signed in and whose address the
 * backend lists as unproven, which happens after an administrator changed it.
 * The code is a sign-in code sent to the account's own address.
 */
import { RESEND_COOLDOWN_MS, isRecentlySent } from "./auth-flow";

export type ProofStep =
  /** Nothing was sent yet: say what this is for and offer to send a code. */
  | { step: "offer" }
  /** A code is in the inbox. `resendAt` is when another one may be asked for. */
  | { step: "code"; resendAt: number };

/**
 * How asking for a code went. `recent`: refused because one was emailed to
 * this address moments ago, so a code is in the inbox either way.
 */
export type SendResult = "sent" | "recent" | "failed";

/** Reads the result of `emailProof.sendCode`: pass what it threw, or `null` when it did not. */
export function sendResult(error: unknown): SendResult {
  if (error === null || error === undefined) return "sent";
  return isRecentlySent(error) ? "recent" : "failed";
}

export interface SendTransition {
  state: ProofStep;
  /** Say, politely, that a new code is on its way. Only after a repeat request went through. */
  announce: boolean;
  /** Show why the request was refused. */
  showError: boolean;
}

/**
 * What a request for a code leads to.
 *
 * The first request moves on to the code whether it went out now or a moment
 * ago, and says nothing more: the person asked once and a code is there. A
 * repeat request restarts the wait in both cases, and when it was refused for
 * being too soon the reason is shown, as on the account screens. Anything else
 * leaves the step as it is and shows the error.
 */
export function afterSend(state: ProofStep, result: SendResult, now: number): SendTransition {
  if (result === "failed") return { state, announce: false, showError: true };
  const next: ProofStep = { step: "code", resendAt: now + RESEND_COOLDOWN_MS };
  if (state.step === "offer") return { state: next, announce: false, showError: false };
  return { state: next, announce: result === "sent", showError: result === "recent" };
}

/**
 * What an accepted code leads to. `proven` is what the backend says about the
 * address afterwards (`emailProof.isConfirmed()`): `false` means the code was
 * right but the backend still does not count the address as the person's own,
 * which must not be reported as a success. `null` (it could not be asked) is
 * taken as done; the account menu asks again the next time it opens.
 */
export function afterVerify(proven: boolean | null): "confirmed" | "unrecorded" {
  return proven === false ? "unrecorded" : "confirmed";
}

// --- Copy ---------------------------------------------------------------------------

export const PROOF_TITLE = "Confirm your email address";
/** Each follows the address, which is shown in bold. */
export const PROOF_OFFER_BEFORE = "Your address";
export const PROOF_OFFER_AFTER =
  "has not been confirmed yet. Until it is, project invitations sent to it don't reach you. We'll email you a sign-in code to confirm it.";
export const PROOF_CODE_BEFORE = "We sent a sign-in code to";
export const PROOF_CODE_AFTER = "Enter it below to confirm the address.";
export const PROOF_CODE_HELP = "No email after a few minutes? Check your spam folder.";
export const PROOF_SEND_LABEL = "Email me a code";
export const PROOF_CONFIRM_LABEL = "Confirm address";
export const PROOF_RESEND_LABEL = "Send a new code";
export const PROOF_DONE_MESSAGE = "Email address confirmed.";
export const PROOF_UNRECORDED_MESSAGE =
  "Your code was accepted, but this server did not record the address as confirmed. Contact an administrator.";
