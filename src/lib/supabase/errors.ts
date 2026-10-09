/**
 * One place that turns whatever the backend layer throws or returns into a
 * `SyncError` with an HTTP status and a stable snake_case code. Callers and UI
 * copy switch on the code only.
 *
 * Matching is on the error's `code`, then its `name` and HTTP status. It is
 * never on message text, which is not a stable contract.
 *
 * Shapes handled:
 * - Supabase Auth errors (`AuthApiError` and friends): `{ name, status, code }`.
 * - PostgREST errors: `{ code, message, details, hint }` plus the HTTP status,
 *   which arrives beside the error and is passed as the second argument.
 *   Scholea's RPCs fail with a custom PostgREST error, so `code` is already
 *   the snake_case code (for example `last_owner` with status 409).
 * - The `admin` Edge Function's error body: `{ error: <code>, message? }`.
 * - Thrown fetch failures and anything unknown.
 */

export class SyncError extends Error {
  constructor(public status: number, public code: string, public payload?: unknown) {
    super(code);
    this.name = "SyncError";
  }
}

/** What `toSyncError` keeps from the original error, for logs and extra copy. */
export interface SyncErrorDetail {
  /** The code the backend used, when it differs from the mapped one. */
  original?: string;
  /** Raw server message. For diagnostics only: never match on it. */
  message?: string;
  details?: unknown;
  /** Why a password was refused (`length`, `characters`, `pwned`), when given. */
  reasons?: string[];
}

/** Supabase Auth code -> Scholea code. */
const AUTH_CODES: Record<string, string> = {
  invalid_credentials: "invalid_credentials",
  email_not_confirmed: "email_not_confirmed",
  user_already_exists: "email_taken",
  email_exists: "email_taken",
  weak_password: "weak_password",
  same_password: "same_password",
  otp_expired: "code_invalid",
  over_email_send_rate_limit: "email_rate_limited",
  over_request_rate_limit: "rate_limited",
  user_banned: "account_suspended",
  signup_disabled: "signup_disabled",
  email_provider_disabled: "signup_disabled",
  email_address_invalid: "invalid_input",
  validation_failed: "invalid_input",
  email_address_not_authorized: "email_undeliverable",
  reauthentication_needed: "reauth_needed",
  session_not_found: "unauthenticated",
  session_expired: "unauthenticated",
  bad_jwt: "unauthenticated",
  invalid_jwt: "unauthenticated",
  no_authorization: "unauthenticated",
  unexpected_failure: "server_error",
};

/** PostgREST and Postgres codes that have a fixed meaning for the client. */
const DATA_CODES: Record<string, string> = {
  PGRST116: "not_found", // .single() matched no row
  PGRST301: "unauthenticated", // token expired or malformed
  PGRST302: "unauthenticated", // anonymous access is off
  PGRST303: "unauthenticated", // token claims refused
};

/** Status used when a code is known but no HTTP status came with it. */
const DEFAULT_STATUS: Record<string, number> = {
  invalid_credentials: 400,
  email_not_confirmed: 400,
  email_taken: 409,
  weak_password: 422,
  same_password: 422,
  code_invalid: 403,
  email_rate_limited: 429,
  rate_limited: 429,
  account_suspended: 403,
  password_reset_required: 403,
  signup_disabled: 422,
  invalid_input: 400,
  email_undeliverable: 400,
  reauth_needed: 401,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  server_error: 500,
  network: 0,
  offline: 0,
  not_configured: 0,
};

const SNAKE_CODE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
/** `raise sqlstate 'PT403'`: PostgREST answers with that HTTP status. */
const PT_CODE = /^PT(\d{3})$/;
/** A raw SQLSTATE (`23505`, `42501`, `P0001`) or a PostgREST `PGRSTxxx` code. */
const ENGINE_CODE = /^([0-9A-Z]{5}|PGRST[0-9A-Z]+)$/;

interface Fields {
  code?: string;
  name?: string;
  status?: number;
  message?: string;
  details?: unknown;
  error?: string;
  reasons?: string[];
  auth: boolean;
}

/** Table lookup that cannot be fooled by a key such as `constructor`. */
function lookup<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function fields(e: unknown): Fields {
  if (typeof e !== "object" || e === null) return { auth: false };
  const o = e as Record<string, unknown>;
  const name = str(o.name);
  return {
    code: str(o.code),
    name,
    status: typeof o.status === "number" && Number.isFinite(o.status) ? o.status : undefined,
    message: str(o.message),
    details: o.details ?? undefined,
    error: str(o.error),
    reasons: Array.isArray(o.reasons) ? o.reasons.filter((r): r is string => typeof r === "string") : undefined,
    auth: o.__isAuthError === true || (name !== undefined && /^Auth[A-Za-z]*Error$/.test(name)),
  };
}

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function byStatus(status: number | undefined): string {
  if (status === undefined) return "server_error";
  if (status === 0) return "network";
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  if (status >= 400) return "invalid_input";
  return "server_error";
}

/** Decide the Scholea code and, where the code implies one, the HTTP status. */
function classify(f: Fields, http: number | undefined): { code: string; status?: number } {
  // A request that never got an answer. 502 to 504 are the gateway saying the
  // same thing, which Supabase Auth reports as a retryable fetch error.
  if (f.name === "AuthRetryableFetchError" || f.name === "FunctionsFetchError") return { code: "network", status: 0 };
  if (f.name === "TypeError" || f.name === "AbortError" || f.name === "TimeoutError") {
    if (http === undefined || http === 0) return { code: "network", status: 0 };
  }

  const code = f.code ?? (f.auth ? undefined : f.error);
  if (code !== undefined) {
    const pt = PT_CODE.exec(code);
    if (pt) {
      const status = Number(pt[1]);
      return { code: f.message && SNAKE_CODE.test(f.message) ? f.message : byStatus(status), status };
    }
    const data = lookup(DATA_CODES, code);
    if (data) return { code: data };
    if (code === "42501") {
      // Not allowed by a grant or a policy. PostgREST answers 401 when the
      // request carried no user token and 403 when it did.
      return http === 401 ? { code: "unauthenticated" } : { code: "forbidden", status: 403 };
    }
    if (code === "P0001" && f.message && SNAKE_CODE.test(f.message)) return { code: f.message };
    if (ENGINE_CODE.test(code)) return { code: byStatus(http) };

    if (code === "request_timeout") return { code: "network", status: 0 };
    if (http !== undefined && http >= 500) return { code: "server_error" };
    // "Require current password" is on and the one supplied was missing or wrong.
    if (code.startsWith("current_password")) return { code: "invalid_credentials" };
    if (code.startsWith("refresh_token_")) return { code: "unauthenticated" };
    // The account behind the session no longer exists.
    if (f.auth && code === "user_not_found") return { code: "unauthenticated" };
    const mapped = lookup(AUTH_CODES, code);
    if (mapped) return { code: mapped };
    if (SNAKE_CODE.test(code)) return { code };
  }

  if (f.name === "AuthSessionMissingError") return { code: "unauthenticated" };
  if (f.name === "AuthInvalidCredentialsError") return { code: "invalid_credentials" };
  if (f.name === "AuthWeakPasswordError") return { code: "weak_password" };
  return { code: byStatus(http) };
}

/**
 * Map anything the backend layer produced to a `SyncError`. Pass the HTTP status
 * when it arrives beside the error (PostgREST calls, Edge Function replies).
 * `online` exists for tests; it defaults to the browser's own report.
 */
export function toSyncError(e: unknown, status?: number, opts: { online?: boolean } = {}): SyncError {
  if (e instanceof SyncError) return e;
  const f = fields(e);
  const http = status ?? f.status;
  const result = classify(f, http);

  let code = result.code;
  if (code === "network" && !(opts.online ?? isOnline())) code = "offline";

  let finalStatus = result.status ?? http ?? lookup(DEFAULT_STATUS, code) ?? 400;
  // These codes mean one thing whatever the transport said.
  if (code === "unauthenticated") finalStatus = 401;
  if (code === "network" || code === "offline") finalStatus = 0;

  const original = f.code ?? f.error;
  const detail: SyncErrorDetail = {};
  if (original !== undefined && original !== code) detail.original = original;
  if (f.message !== undefined && f.message !== code) detail.message = f.message;
  if (f.details !== undefined && f.details !== null && f.details !== "") detail.details = f.details;
  if (f.reasons && f.reasons.length > 0) detail.reasons = f.reasons;
  return new SyncError(finalStatus, code, Object.keys(detail).length > 0 ? detail : undefined);
}

/** No backend is configured in this build. */
export function notConfiguredError(): SyncError {
  return new SyncError(0, "not_configured");
}

/** There is no signed-in session for a call that needs one. */
export function unauthenticatedError(): SyncError {
  return new SyncError(401, "unauthenticated");
}

/** True when the request never reached the backend, so trying again later may work. */
export function isConnectivityError(e: unknown): boolean {
  return e instanceof SyncError && (e.code === "network" || e.code === "offline");
}
