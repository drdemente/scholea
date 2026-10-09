/**
 * The six account actions of the "admin" function.
 *
 * Each action has the same order, and the order is the security design:
 *
 *   1. A database function is called AS THE CALLER. It checks the live
 *      session, the account status, the role, who may manage whom and the last
 *      master admin, and it does the database half of the action. Nothing in
 *      this file decides who may do what, and nothing here reads an identity or
 *      a role from the request body.
 *   2. Only when step 1 succeeded, the Auth admin API is asked to do the half
 *      only it can do: send an invitation, change an address, ban, soft delete.
 *
 * Database first means a half applied action is always in its restrictive
 * state (a suspended account is locked out before it is banned), and every
 * action can be repeated: the second run completes what the first left open.
 *
 * The two dependencies are passed in, so the order can be tested without a
 * backend. See index.ts for the real ones.
 */
import { type AuthCodeMap, AuthStepError, fromAuth, HttpError, INVALID_ADDRESS } from "./errors.ts";

/** Calls a database function as the caller. Throws `HttpError` when it refuses. */
export type Rpc = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** The Auth admin API, the only thing the secret key is used for. Throws `AuthStepError`. */
export interface AuthAdmin {
  /** Send an invitation code. Creates the account when the address has none. */
  invite(email: string, data?: Record<string, string>): Promise<{ id: string }>;
  setEmail(userId: string, email: string): Promise<void>;
  setBanned(userId: string, banned: boolean): Promise<void>;
  /** Soft delete: the row stays, the address is freed, sessions end. */
  softDelete(userId: string): Promise<void>;
}

export interface Deps {
  rpc: Rpc;
  auth: AuthAdmin;
}

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

export type Action = (deps: Deps, body: Record<string, unknown>) => Promise<Reply>;

// --- Reading the request body -------------------------------------------------
// Values are passed to the database as they came, or as null when they are not
// the expected kind of value. The database then answers in its fixed order:
// who is calling first, what was asked second. Nothing is refused here.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function uuid(v: unknown): string | null {
  return typeof v === "string" && UUID.test(v) ? v : null;
}

/** Left out means the admin surface; anything else is for the database to judge. */
function surface(v: unknown): string | null {
  return v === undefined ? "admin" : text(v);
}

// --- Reading what the database returned ----------------------------------------

function object(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new HttpError(500, "server_error", "The database returned an unexpected answer.");
  }
  return v as Record<string, unknown>;
}

function string(v: unknown): string {
  if (typeof v !== "string" || v === "") {
    throw new HttpError(500, "server_error", "The database returned an unexpected answer.");
  }
  return v;
}

/** The id the database just accepted. It checked the account exists, so this never fails. */
function accepted(userId: string | null): string {
  if (userId === null) throw new HttpError(500, "server_error");
  return userId;
}

/** Run one Auth step; a failure becomes the answer for this action. */
async function authStep<T>(step: () => Promise<T>, codes: AuthCodeMap = {}): Promise<T> {
  try {
    return await step();
  } catch (e) {
    // Status and code only: the text of an Auth error can name an email address.
    const what = e instanceof AuthStepError ? `status ${e.status}, code ${e.code || "none"}` : "unexpected error";
    console.error(`admin: Auth step failed (${what})`);
    throw fromAuth(e, codes);
  }
}

// --- Actions --------------------------------------------------------------------

/**
 * Invite somebody. Body: `{ email, role?, name?, institution?, surface? }`.
 * Answers 201 `{ user }`. The person receives a code by email and chooses their
 * own password; no password or link ever passes through here.
 *
 * The role does not travel through Auth. The database records it as an intent,
 * and its trigger on new Auth users gives the account that role and writes the
 * audit row in Auth's own transaction.
 */
const inviteUser: Action = async ({ rpc, auth }, body) => {
  const begun = object(await rpc("admin_begin_invite", {
    p_email: text(body.email),
    p_role: text(body.role),
    p_name: text(body.name),
    p_institution: text(body.institution),
    p_surface: surface(body.surface),
  }));
  const email = string(begun.email);
  const role = string(begun.role);

  const data: Record<string, string> = {};
  const name = text(body.name)?.trim();
  const institution = text(body.institution)?.trim();
  if (name) data.name = name;
  if (institution) data.institution = institution;

  const invited = await authStep(() => auth.invite(email, data), {
    email_exists: [409, "email_taken"],
    ...INVALID_ADDRESS,
  });

  // The account must be the one this invitation created: waiting for its code,
  // with the role that was asked for. Anything else means the address got an
  // account by another route in the meantime.
  let user: Record<string, unknown>;
  try {
    user = object(object(await rpc("admin_get_user", { p_user_id: invited.id })).user);
  } catch (e) {
    if (e instanceof HttpError && e.code === "not_found") throw new HttpError(409, "email_taken");
    throw e;
  }
  if (user.role !== role || user.mustResetPassword !== true) throw new HttpError(409, "email_taken");

  return { status: 201, body: { user } };
};

/**
 * Send the invitation code again. Body: `{ userId, surface? }`. Answers 200
 * `{ ok: true }`. Only for an account that is still waiting for its code.
 */
const resendInvite: Action = async ({ rpc, auth }, body) => {
  const checked = object(await rpc("admin_check_user_action", {
    p_user_id: uuid(body.userId),
    p_action: "resend_invite",
    p_surface: surface(body.surface),
  }));
  const email = string(object(checked.user).email);

  // The code was used between the check and now: nothing is pending any more.
  await authStep(() => auth.invite(email), { email_exists: [409, "not_pending"] });
  return { status: 200, body: { ok: true } };
};

/**
 * Change an account's email address. Body: `{ userId, email }`. Answers 200
 * `{ user }`. The change takes effect at once and the person stays signed in.
 * The database trigger writes the audit row, naming the administrator, when
 * Auth makes the change.
 *
 * Nobody has shown that they can read the new mailbox, so the answer carries
 * `emailConfirmed: false`: until the person types a code sent to the new
 * address (a password reset code will do), the database shows them no project
 * invitation for it. Auth sends no notice to either address for a change made
 * here. The administrator has to tell the person.
 */
const updateEmail: Action = async ({ rpc, auth }, body) => {
  const userId = uuid(body.userId);
  const begun = object(await rpc("admin_begin_email_change", {
    p_user_id: userId,
    p_new_email: text(body.email),
  }));

  if (begun.changed === true) {
    const email = string(begun.email);
    await authStep(() => auth.setEmail(accepted(userId), email), {
      email_exists: [409, "email_taken"],
      // Auth reports an address taken in the same instant as a unique violation.
      "23505": [409, "email_taken"],
      ...INVALID_ADDRESS,
    });
  }

  const got = object(await rpc("admin_get_user", { p_user_id: userId }));
  return { status: 200, body: { user: object(got.user) } };
};

/**
 * Suspend an account. Body: `{ userId, surface? }`. Answers 200
 * `{ ok: true, revokedSessions }`. The database step ends every session, so the
 * person's very next request is refused; the ban then stops new sign-ins.
 */
const suspendUser: Action = async ({ rpc, auth }, body) => {
  const userId = uuid(body.userId);
  const done = object(await rpc("admin_set_user_status", {
    p_user_id: userId,
    p_status: "suspended",
    p_surface: surface(body.surface),
  }));

  await authStep(() => auth.setBanned(accepted(userId), true));
  return { status: 200, body: { ok: true, revokedSessions: Number(done.revokedSessions ?? 0) } };
};

/**
 * Lift a suspension. Body: `{ userId, surface? }`. Answers 200 `{ ok: true }`.
 * The ban is lifted before the status changes, so a failure in between leaves
 * the account suspended.
 */
const activateUser: Action = async ({ rpc, auth }, body) => {
  const userId = uuid(body.userId);
  const where = surface(body.surface);
  await rpc("admin_check_user_action", { p_user_id: userId, p_action: "activate", p_surface: where });

  await authStep(() => auth.setBanned(accepted(userId), false));

  await rpc("admin_set_user_status", { p_user_id: userId, p_status: "active", p_surface: where });
  return { status: 200, body: { ok: true } };
};

/**
 * Delete an account, keeping its row so audit entries and comments that mention
 * it stay meaningful. Body: `{ userId, surface? }`. Answers 200 `{ ok: true }`.
 * Not reversible. The address becomes free for a new account.
 */
const deleteUser: Action = async ({ rpc, auth }, body) => {
  const userId = uuid(body.userId);
  // Also succeeds for an account that is already deleted, so a repeat can
  // finish a delete whose Auth step failed.
  await rpc("admin_soft_delete_user", { p_user_id: userId, p_surface: surface(body.surface) });

  await authStep(async () => {
    try {
      await auth.softDelete(accepted(userId));
    } catch (e) {
      // Auth no longer has the account: that is the state this step is for.
      if (!(e instanceof AuthStepError && e.code === "user_not_found")) throw e;
    }
  });
  return { status: 200, body: { ok: true } };
};

const ACTIONS: Record<string, Action> = {
  invite_user: inviteUser,
  resend_invite: resendInvite,
  update_email: updateEmail,
  suspend_user: suspendUser,
  activate_user: activateUser,
  delete_user: deleteUser,
};

/** The action with this name, or undefined. Revoking sessions is a plain database function, not an action. */
export function findAction(name: unknown): Action | undefined {
  return typeof name === "string" && Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : undefined;
}
