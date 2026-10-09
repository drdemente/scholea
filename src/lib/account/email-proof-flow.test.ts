import { describe, expect, it } from "vitest";
import { SyncError } from "@/lib/supabase/errors";
import { RESEND_COOLDOWN_MS, canResend } from "./auth-flow";
import * as flow from "./email-proof-flow";
import { afterSend, afterVerify, sendResult, type ProofStep } from "./email-proof-flow";

const T0 = 1_800_000_000_000;
const OFFER: ProofStep = { step: "offer" };
const CODE: ProofStep = { step: "code", resendAt: T0 + 5_000 };

describe("reading how a request for a code went", () => {
  it("is sent when nothing was thrown", () => {
    expect(sendResult(null)).toBe("sent");
    expect(sendResult(undefined)).toBe("sent");
  });

  it("is recent when the server refused because a code went out moments ago", () => {
    expect(sendResult(new SyncError(429, "email_rate_limited"))).toBe("recent");
  });

  it("is failed for everything else", () => {
    for (const error of [
      new SyncError(429, "rate_limited"),
      new SyncError(0, "offline"),
      new SyncError(0, "network"),
      new SyncError(422, "otp_disabled"),
      new SyncError(500, "server_error"),
      new TypeError("Failed to fetch"),
      "email_rate_limited",
      { code: "email_rate_limited" },
    ]) {
      expect(sendResult(error)).toBe("failed");
    }
  });
});

describe("asking for the first code", () => {
  it("moves on to the code and starts the wait, without a word more", () => {
    expect(afterSend(OFFER, "sent", T0)).toEqual({
      state: { step: "code", resendAt: T0 + RESEND_COOLDOWN_MS },
      announce: false,
      showError: false,
    });
  });

  it("moves on just the same when a code went out a moment ago: it is in the inbox either way", () => {
    // Someone who closed the dialog and opened it again must not be stuck in front of a refusal.
    expect(afterSend(OFFER, "recent", T0)).toEqual({
      state: { step: "code", resendAt: T0 + RESEND_COOLDOWN_MS },
      announce: false,
      showError: false,
    });
  });

  it("stays put and shows why when it failed", () => {
    expect(afterSend(OFFER, "failed", T0)).toEqual({ state: OFFER, announce: false, showError: true });
  });
});

describe("asking for another code", () => {
  it("restarts the wait and says a new code is on its way", () => {
    expect(afterSend(CODE, "sent", T0 + 70_000)).toEqual({
      state: { step: "code", resendAt: T0 + 70_000 + RESEND_COOLDOWN_MS },
      announce: true,
      showError: false,
    });
  });

  it("restarts the wait and shows the reason when it was too soon", () => {
    expect(afterSend(CODE, "recent", T0 + 70_000)).toEqual({
      state: { step: "code", resendAt: T0 + 70_000 + RESEND_COOLDOWN_MS },
      announce: false,
      showError: true,
    });
  });

  it("keeps the step and its wait as they were when it failed", () => {
    const result = afterSend(CODE, "failed", T0 + 70_000);
    expect(result).toEqual({ state: CODE, announce: false, showError: true });
    expect(result.state).toBe(CODE);
  });

  it("uses the same wait as the account screens", () => {
    const next = afterSend(OFFER, "sent", T0).state;
    if (next.step !== "code") throw new Error("expected the code step");
    expect(canResend(next.resendAt, T0 + RESEND_COOLDOWN_MS - 1)).toBe(false);
    expect(canResend(next.resendAt, T0 + RESEND_COOLDOWN_MS)).toBe(true);
  });
});

describe("after the code was accepted", () => {
  it("is confirmed when the backend says the address is proven", () => {
    expect(afterVerify(true)).toBe("confirmed");
  });

  it("is not reported as a success when the backend still lists the address as unproven", () => {
    expect(afterVerify(false)).toBe("unrecorded");
  });

  it("is taken as confirmed when the backend could not be asked", () => {
    expect(afterVerify(null)).toBe("confirmed");
  });
});

describe("copy", () => {
  const sentences = Object.entries(flow)
    .filter(([name, value]) => name.startsWith("PROOF_") && typeof value === "string")
    .map(([, value]) => value as string);

  it("is all there", () => {
    expect(sentences).toHaveLength(11);
    expect(flow.PROOF_TITLE).toBe("Confirm your email address");
    expect(flow.PROOF_SEND_LABEL).toBe("Email me a code");
    expect(flow.PROOF_RESEND_LABEL).toBe("Send a new code");
    expect(flow.PROOF_DONE_MESSAGE).toBe("Email address confirmed.");
  });

  it("has no em-dash and never says how many digits a code has", () => {
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/—|–/);
      expect(sentence).not.toMatch(/\d/);
      expect(sentence.toLowerCase()).not.toContain("digit");
    }
  });

  it("calls the code what its email calls it, so the person knows which email to look for", () => {
    expect(flow.PROOF_OFFER_AFTER).toContain("sign-in code");
    expect(flow.PROOF_CODE_BEFORE).toContain("sign-in code");
  });
});
