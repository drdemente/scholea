/**
 * The failures the "admin" function answers with, and how a refusal from the
 * database or from Supabase Auth becomes one.
 *
 * Every failure leaves the function as JSON `{ error: <snake_case code>,
 * message? }` with a real HTTP status. Callers switch on the code. A message,
 * when there is one, is a fixed sentence written here: text that came from the
 * database or from Auth is never passed on, because it can contain an email
 * address.
 *
 * This module imports nothing, so it can be tested without a backend.
 */

/** A failure with the status and code the caller will see. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  /** Optional fixed sentence for the caller. Never text from another service. */
  readonly note: string | undefined;

  constructor(status: number, code: string, note?: string) {
    super(code);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.note = note;
  }
}

/** A step of the Auth admin API that did not succeed. Only the status and code are kept. */
export class AuthStepError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code || "auth_step_failed");
    this.name = "AuthStepError";
    this.status = status;
    this.code = code;
  }
}

const SNAKE_CODE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/** Table lookup that cannot be fooled by a key such as `constructor`. */
function lookup<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * A database function refused, or could not be called.
 *
 * Scholea's functions refuse through `private.fail(code, status)`, which the
 * Data API delivers as `error.code = '<snake_case code>'` with that HTTP
 * status. Those are passed on unchanged: the database is the authority on who
 * may do what, and this function adds nothing to its answer.
 */
export function fromRpc(error: { code?: unknown } | null | undefined, status: number): HttpError {
  const code = typeof error?.code === "string" ? error.code : "";
  if (SNAKE_CODE.test(code) && status >= 400 && status <= 499) return new HttpError(status, code);

  // The Data API itself refused the token (expired, malformed, claims refused),
  // or the caller is not a signed-in user at all.
  if (status === 401 || code === "PGRST301" || code === "PGRST302" || code === "PGRST303") {
    return new HttpError(401, "unauthenticated");
  }
  // Not granted: the token belongs to something other than a signed-in user.
  if (code === "42501") return new HttpError(403, "forbidden");
  // A value the database could not read as its type (SQLSTATE class 22).
  if (/^22[0-9A-Z]{3}$/.test(code)) return new HttpError(400, "invalid_input");

  return new HttpError(500, "server_error", "The database could not be reached. Try again.");
}

/** How one Auth error code is answered: `[status, code]`. */
export type AuthCodeMap = Record<string, readonly [number, string]>;

const AUTH_CODES: AuthCodeMap = {
  over_email_send_rate_limit: [429, "rate_limited"],
  over_request_rate_limit: [429, "rate_limited"],
  email_address_not_authorized: [502, "smtp_not_configured"],
};

/** Auth refused an address the database accepted: its own check is stricter. */
export const INVALID_ADDRESS: AuthCodeMap = {
  email_address_invalid: [400, "invalid_input"],
  validation_failed: [400, "invalid_input"],
};

const NOTES: Record<string, string> = {
  rate_limited: "Too many emails or requests in a short time. Wait a minute and try again.",
  smtp_not_configured: "The email service refused to send to this address. Check the project's email (SMTP) settings.",
  auth_sync_failed: "The account service did not finish this step. Run the same action again to complete it.",
};

/**
 * A step of the Auth admin API failed after the database step succeeded.
 * `extra` adds the codes that mean something specific for the action at hand.
 * Anything not listed is `auth_sync_failed` (502): the action is half applied,
 * always in its restrictive state, and repeating it completes it.
 */
export function fromAuth(error: unknown, extra: AuthCodeMap = {}): HttpError {
  const e = error instanceof AuthStepError ? error : new AuthStepError(0, "");
  const hit = lookup(extra, e.code) ?? lookup(AUTH_CODES, e.code) ??
    (e.status === 429 ? AUTH_CODES.over_request_rate_limit : undefined);
  const [status, code] = hit ?? [502, "auth_sync_failed"];
  return new HttpError(status, code, lookup(NOTES, code));
}
