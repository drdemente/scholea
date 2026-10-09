import { describe, expect, it } from "vitest";
import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthWeakPasswordError,
  PostgrestError,
} from "@supabase/supabase-js";
import {
  SyncError,
  isConnectivityError,
  notConfiguredError,
  toSyncError,
  unauthenticatedError,
  type SyncErrorDetail,
} from "./errors";

const online = { online: true };

/** An Auth API error as the client library builds it. */
const authError = (code: string, status = 400) => new AuthApiError("server prose that must never be matched", status, code);

/** A PostgREST error body, as returned beside the HTTP status. */
const dataError = (code: string, message = "", details = "") => new PostgrestError({ code, message, details, hint: "" });

describe("SyncError", () => {
  it("carries status, code and payload, and is a real Error", () => {
    const e = new SyncError(409, "last_owner", { a: 1 });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("SyncError");
    expect(e.message).toBe("last_owner");
    expect([e.status, e.code, e.payload]).toEqual([409, "last_owner", { a: 1 }]);
  });

  it("passes an existing SyncError through unchanged", () => {
    const e = new SyncError(403, "forbidden");
    expect(toSyncError(e)).toBe(e);
    expect(toSyncError(e, 500)).toBe(e);
  });
});

describe("toSyncError: Supabase Auth codes", () => {
  const table: Array<[string, number, string]> = [
    ["invalid_credentials", 400, "invalid_credentials"],
    ["email_not_confirmed", 400, "email_not_confirmed"],
    ["user_already_exists", 422, "email_taken"],
    ["email_exists", 422, "email_taken"],
    ["weak_password", 422, "weak_password"],
    ["same_password", 422, "same_password"],
    ["otp_expired", 403, "code_invalid"],
    ["over_email_send_rate_limit", 429, "email_rate_limited"],
    ["over_request_rate_limit", 429, "rate_limited"],
    ["user_banned", 400, "account_suspended"],
    ["signup_disabled", 422, "signup_disabled"],
    ["email_provider_disabled", 400, "signup_disabled"],
    ["email_address_invalid", 400, "invalid_input"],
    ["validation_failed", 400, "invalid_input"],
    ["email_address_not_authorized", 400, "email_undeliverable"],
    ["reauthentication_needed", 400, "reauth_needed"],
  ];
  it.each(table)("%s (%i) -> %s", (code, status, expected) => {
    const e = toSyncError(authError(code, status), undefined, online);
    expect(e).toBeInstanceOf(SyncError);
    expect(e.code).toBe(expected);
    expect(e.status).toBe(status);
  });

  it("maps every way a session can be over to unauthenticated (401)", () => {
    for (const code of ["session_not_found", "session_expired", "refresh_token_not_found", "refresh_token_already_used", "bad_jwt"]) {
      const e = toSyncError(authError(code, 400), undefined, online);
      expect([e.code, e.status]).toEqual(["unauthenticated", 401]);
    }
    const missing = toSyncError(new AuthSessionMissingError(), undefined, online);
    expect([missing.code, missing.status]).toEqual(["unauthenticated", 401]);
  });

  it("treats a vanished account behind the session as unauthenticated", () => {
    expect(toSyncError(authError("user_not_found", 404), undefined, online).code).toBe("unauthenticated");
  });

  it("maps any current-password refusal to invalid_credentials and keeps the original code", () => {
    for (const code of ["current_password_mismatch", "current_password_required"]) {
      const e = toSyncError(authError(code, 400), undefined, online);
      expect(e.code).toBe("invalid_credentials");
      expect((e.payload as SyncErrorDetail).original).toBe(code);
    }
  });

  it("keeps the reasons a password was refused", () => {
    const e = toSyncError(new AuthWeakPasswordError("too weak", 422, ["length", "pwned"]), undefined, online);
    expect(e.code).toBe("weak_password");
    expect((e.payload as SyncErrorDetail).reasons).toEqual(["length", "pwned"]);
  });

  it("maps unexpected_failure and any 5xx to server_error", () => {
    expect(toSyncError(authError("unexpected_failure", 500), undefined, online).code).toBe("server_error");
    expect(toSyncError(authError("hook_timeout", 500), undefined, online).code).toBe("server_error");
  });

  it("passes an unlisted code through rather than inventing a meaning", () => {
    const e = toSyncError(authError("captcha_failed", 400), undefined, online);
    expect([e.code, e.status]).toEqual(["captcha_failed", 400]);
  });

  it("is not fooled by a code that names a built-in property", () => {
    for (const code of ["constructor", "toString", "__proto__"]) {
      const e = toSyncError({ code, message: "x" }, 400, online);
      expect(typeof e.code).toBe("string");
      expect(e.status).toBe(400);
    }
    expect(toSyncError({ code: "constructor" }, undefined, online).status).toBe(400);
  });

  it("never matches on message text", () => {
    const e = toSyncError(new AuthApiError("invalid_credentials otp_expired user_banned", 400, undefined), undefined, online);
    expect(e.code).toBe("invalid_input"); // decided by the status alone
  });
});

describe("toSyncError: connectivity", () => {
  it("maps a retryable fetch failure to network", () => {
    const e = toSyncError(new AuthRetryableFetchError("Failed to fetch", 0), undefined, online);
    expect([e.code, e.status]).toEqual(["network", 0]);
    // 502 to 504 are reported the same way by the client library.
    expect(toSyncError(new AuthRetryableFetchError("Bad gateway", 502), undefined, online).code).toBe("network");
  });

  it("maps request_timeout to network", () => {
    expect(toSyncError(authError("request_timeout", 504), undefined, online).code).toBe("network");
  });

  it("maps a thrown fetch TypeError to network", () => {
    expect(toSyncError(new TypeError("Failed to fetch"), undefined, online).code).toBe("network");
  });

  it("maps a PostgREST transport failure (status 0, empty code) to network", () => {
    const body = { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" };
    const e = toSyncError(body, 0, online);
    expect([e.code, e.status]).toEqual(["network", 0]);
  });

  it("says offline instead of network when the browser reports no connection", () => {
    const e = toSyncError(new AuthRetryableFetchError("Failed to fetch", 0), undefined, { online: false });
    expect([e.code, e.status]).toEqual(["offline", 0]);
    expect(toSyncError({ code: "", message: "x" }, 0, { online: false }).code).toBe("offline");
    // Being offline does not relabel an answer the server really gave.
    expect(toSyncError(authError("invalid_credentials"), undefined, { online: false }).code).toBe("invalid_credentials");
  });

  it("isConnectivityError is true only for network and offline", () => {
    expect(isConnectivityError(new SyncError(0, "network"))).toBe(true);
    expect(isConnectivityError(new SyncError(0, "offline"))).toBe(true);
    expect(isConnectivityError(new SyncError(500, "server_error"))).toBe(false);
    expect(isConnectivityError(new Error("x"))).toBe(false);
  });
});

describe("toSyncError: PostgREST and Postgres", () => {
  it("reads Scholea's custom RPC error: the code is the snake_case code, the status is the HTTP status", () => {
    // private.fail('last_owner', 409) arrives as this body with HTTP 409.
    const e = toSyncError(dataError("last_owner", "last_owner"), 409, online);
    expect([e.code, e.status]).toEqual(["last_owner", 409]);

    const table: Array<[string, number]> = [
      ["unauthenticated", 401],
      ["account_suspended", 403],
      ["password_reset_required", 403],
      ["forbidden", 403],
      ["forbidden_role", 403],
      ["not_found", 404],
      ["not_a_member", 404],
      ["invalid_input", 400],
      ["invalid_role", 400],
      ["conflict", 409],
      ["last_master_admin", 409],
      ["email_taken", 409],
    ];
    for (const [code, status] of table) {
      const mapped = toSyncError(dataError(code, code), status, online);
      expect([mapped.code, mapped.status]).toEqual([code, status]);
    }
  });

  it("keeps the details an RPC attached", () => {
    const e = toSyncError(dataError("invalid_input", "invalid_input", "title too long"), 400, online);
    expect((e.payload as SyncErrorDetail).details).toBe("title too long");
  });

  it("does not confuse a data-layer user_not_found with an ended session", () => {
    const e = toSyncError(dataError("user_not_found", "user_not_found"), 404, online);
    expect([e.code, e.status]).toEqual(["user_not_found", 404]);
  });

  it("reads a PTxxx sqlstate: status from the code, code from the message", () => {
    const e = toSyncError(dataError("PT403", "forbidden"), 403, online);
    expect([e.code, e.status]).toEqual(["forbidden", 403]);
    // Prose in the message is not a code: fall back to the status.
    const prose = toSyncError(dataError("PT404", "No such project."), undefined, online);
    expect([prose.code, prose.status]).toEqual(["not_found", 404]);
  });

  it("reads a plain raise (P0001) whose message is a snake_case code", () => {
    const e = toSyncError(dataError("P0001", "last_owner"), 400, online);
    expect([e.code, e.status]).toEqual(["last_owner", 400]);
    expect(toSyncError(dataError("P0001", "Something broke badly"), 400, online).code).toBe("invalid_input");
  });

  it("maps 42501 by who was asking: 401 without a user token, otherwise forbidden", () => {
    const denied = dataError("42501", "permission denied for table profiles");
    expect(toSyncError(denied, 403, online)).toMatchObject({ code: "forbidden", status: 403 });
    expect(toSyncError(denied, 401, online)).toMatchObject({ code: "unauthenticated", status: 401 });
  });

  it("maps PGRST116 (no row for .single()) to not_found", () => {
    expect(toSyncError(dataError("PGRST116", "JSON object requested, multiple (or no) rows returned"), 406, online).code).toBe("not_found");
  });

  it("maps an expired or refused token (PGRST301 to PGRST303) to unauthenticated", () => {
    for (const code of ["PGRST301", "PGRST302", "PGRST303"]) {
      expect(toSyncError(dataError(code, "JWT expired"), 401, online)).toMatchObject({ code: "unauthenticated", status: 401 });
    }
  });

  it("maps other engine codes by HTTP status only", () => {
    expect(toSyncError(dataError("23505", "duplicate key value"), 409, online).code).toBe("conflict");
    expect(toSyncError(dataError("PGRST202", "Could not find the function"), 404, online).code).toBe("not_found");
    expect(toSyncError(dataError("57014", "canceling statement due to statement timeout"), 500, online).code).toBe("server_error");
    expect(toSyncError(dataError("PGRST121", "could not parse"), 500, online).code).toBe("server_error");
  });
});

describe("toSyncError: Edge Function and unknown shapes", () => {
  it("reads the admin function's error body", () => {
    const e = toSyncError({ error: "last_master_admin", message: "Keep one master admin." }, 409, online);
    expect([e.code, e.status]).toEqual(["last_master_admin", 409]);
    expect(toSyncError({ error: "forbidden" }, 403, online).code).toBe("forbidden");
  });

  it("falls back to the HTTP status when there is no code", () => {
    const cases: Array<[number, string]> = [
      [401, "unauthenticated"],
      [403, "forbidden"],
      [404, "not_found"],
      [409, "conflict"],
      [429, "rate_limited"],
      [400, "invalid_input"],
      [500, "server_error"],
      [503, "server_error"],
    ];
    for (const [status, code] of cases) expect(toSyncError({}, status, online).code).toBe(code);
  });

  it("maps something unrecognisable to server_error", () => {
    for (const odd of [null, undefined, "boom", 42, new Error("boom")]) {
      const e = toSyncError(odd, undefined, online);
      expect([e.code, e.status]).toEqual(["server_error", 500]);
    }
  });
});

describe("ready-made errors", () => {
  it("not configured and unauthenticated", () => {
    expect(notConfiguredError()).toMatchObject({ code: "not_configured", status: 0 });
    expect(unauthenticatedError()).toMatchObject({ code: "unauthenticated", status: 401 });
  });
});
