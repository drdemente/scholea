/**
 * Helpers for the end-to-end tests of the LOCAL Supabase stack: the real Auth
 * service, the real Data API, the real mail catcher and the locally served
 * Edge Function "admin".
 *
 * Run them with `pnpm test:supabase` from the repository root, with the stack
 * started (`supabase start`, see supabase/config.toml). That script reads the
 * local URLs and keys from `supabase status -o env`; nothing is stored in the
 * repository. Accounts use @example.test addresses and passwords generated at
 * run time, and every account a run creates is removed when the run ends.
 *
 * Requests are plain `fetch` calls, so each test shows the exact request and
 * answer the app's client library exchanges with the backend.
 */
import { createHash } from "node:crypto";
import { Client } from "@db/postgres";

// --- Where the stack is ---------------------------------------------------------

function need(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(
      `${name} is not set. Start the local stack (supabase start) and run these tests with "pnpm test:supabase".`,
    );
  }
  return value;
}

export const API_URL = need("API_URL").replace(/\/+$/, "");
/** Sent as `apikey` by every client. Not a credential. */
export const PUBLISHABLE_KEY = need("PUBLISHABLE_KEY");
/** Only for what a client can never do: preparing an invitation in the Auth tests, and proving the function refuses it as a caller. */
export const SECRET_KEY = need("SECRET_KEY");
export const MAILPIT_URL = need("MAILPIT_URL").replace(/\/+$/, "");
const DB_URL = need("DB_URL");

// These tests create accounts and promote a master admin. Never against anything but this machine.
for (const [name, value] of [["API_URL", API_URL], ["MAILPIT_URL", MAILPIT_URL], ["DB_URL", DB_URL]]) {
  const host = new URL(value).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`${name} points at ${host}. These tests run against the local stack only.`);
  }
}

/** The subjects configured in supabase/config.toml, one per kind of email. */
export const SUBJECT = {
  confirmation: "Your Scholea confirmation code",
  recovery: "Your Scholea password reset code",
  invite: "Your Scholea invitation code",
  signIn: "Your Scholea sign-in code",
  emailChange: "Confirm your new Scholea email address",
  passwordChanged: "Your Scholea password was changed",
} as const;

// --- Small things -----------------------------------------------------------------

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function randomText(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A new random password. None is ever written down. */
export const newPassword = () => randomText(18);

const RUN = randomText(5).toLowerCase().replace(/[^a-z0-9]/g, "x");
let addressCount = 0;

/** A fresh address for this run. The label only makes failures readable. */
export function newAddress(label: string): string {
  addressCount += 1;
  return `${label}-${RUN}-${addressCount}@example.test`;
}

/** An 8 digit code that is not `code`. */
export function wrongCode(code: string): string {
  return code === "00000000" ? "00000001" : "00000000";
}

// --- HTTP ---------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
export interface Reply<T = any> {
  status: number;
  body: T;
  headers: Headers;
  /** The answer exactly as it was sent. */
  text: string;
}

interface RequestOptions {
  /** The API key; the publishable key unless a test says otherwise. Null sends none. */
  key?: string | null;
  /** The caller's token. Left out, the API key is sent in its place, as the client library does. Null sends no Authorization at all. */
  token?: string | null;
  body?: unknown;
  /** Sent as written, without JSON encoding. */
  rawBody?: string;
  headers?: Record<string, string>;
}

export async function request(method: string, url: string, options: RequestOptions = {}): Promise<Reply> {
  const key = options.key === undefined ? PUBLISHABLE_KEY : options.key;
  const token = options.token === undefined ? key : options.token;
  const headers: Record<string, string> = { ...options.headers };
  if (key !== null) headers.apikey = key;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, headers: res.headers, text };
}

/** Supabase Auth, as a client reaches it. */
export const auth = (method: string, path: string, options: RequestOptions = {}) =>
  request(method, `${API_URL}/auth/v1${path}`, options);

/** A database function, called with the caller's token. */
export const rpc = (name: string, args: Record<string, unknown>, token: string | null | undefined, options: RequestOptions = {}) =>
  request("POST", `${API_URL}/rest/v1/rpc/${name}`, { ...options, token, body: args });

/**
 * A table read through the Data API, for example `projects?select=id`. No
 * client may read a table, so the tests use this to prove a read is refused.
 * `prefer` is the `Prefer` header, for example `count=planned`.
 */
export const table = (query: string, token: string, prefer?: string) =>
  request("GET", `${API_URL}/rest/v1/${query}`, { token, headers: prefer ? { Prefer: prefer } : undefined });

/** The ten tables of the backend. None of them is readable through the Data API. */
export const TABLES = [
  "profiles",
  "audit_log",
  "instance_settings",
  "projects",
  "project_members",
  "project_invitations",
  "project_comments",
  "project_reviews",
  "step_ownership",
  "project_activity",
] as const;

const FUNCTION_URL = `${API_URL}/functions/v1/admin`;

/** Every answer the admin function gave during this run, to check at the end that none carried a secret. */
export const functionAnswers: string[] = [];

/** The Edge Function "admin", the way `supabase.functions.invoke('admin', { body })` calls it. */
export async function adminFn(body: unknown, token: string | null | undefined, options: RequestOptions = {}): Promise<Reply> {
  const reply = await request("POST", FUNCTION_URL, { ...options, token, body });
  functionAnswers.push(reply.text);
  return reply;
}

export const adminFnRaw = (method: string, options: RequestOptions = {}) => request(method, FUNCTION_URL, options);

/**
 * Wait until the function answers. Its first request after the stack starts
 * downloads the function's dependencies, which can take a while on a cold
 * machine (CI).
 */
export async function functionReady(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let status = 0;
    try {
      status = (await adminFnRaw("OPTIONS", { key: null, token: null })).status;
    } catch {
      // The gateway is not up yet.
    }
    if (status === 404) {
      throw new Error(
        "The local stack is not serving the admin function. It is picked up when the stack starts: run supabase stop, then supabase start.",
      );
    }
    if (status >= 200 && status < 500) return;
    if (Date.now() > deadline) throw new Error(`The admin function did not start (last status ${status}).`);
    await sleep(1000);
  }
}

// --- The mail catcher ---------------------------------------------------------------

export interface Mail {
  id: string;
  subject: string;
  text: string;
  html: string;
  /** The one line of the text that is 6 to 10 digits, or null for a notice without a code. */
  code: string | null;
}

interface MailSummary {
  ID: string;
  Created: string;
  Subject: string;
  To: { Address: string }[] | null;
}

const readMail = new Set<string>();
const usedAddresses = new Set<string>();

/** Every message addressed to exactly this address, oldest first. */
async function inbox(address: string): Promise<MailSummary[]> {
  usedAddresses.add(address);
  const res = await fetch(`${MAILPIT_URL}/api/v1/search?limit=200&query=${encodeURIComponent(`to:"${address}"`)}`);
  const found = await res.json() as { messages?: MailSummary[] };
  return (found.messages ?? [])
    .filter((m) => (m.To ?? []).some((to) => to.Address.toLowerCase() === address.toLowerCase()))
    .sort((a, b) => Date.parse(a.Created) - Date.parse(b.Created));
}

/** Messages to this address that no earlier `nextMail` call returned. */
export async function unreadMail(address: string): Promise<MailSummary[]> {
  return (await inbox(address)).filter((m) => !readMail.has(m.ID));
}

/** How many messages this address has received so far. */
export async function mailCount(address: string): Promise<number> {
  return (await inbox(address)).length;
}

/**
 * The oldest message to this address that has not been read yet, which must
 * carry this subject. Waits for it to arrive.
 */
export async function nextMail(address: string, subject: string, timeoutMs = 15_000): Promise<Mail> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [first] = await unreadMail(address);
    if (first) {
      readMail.add(first.ID);
      if (first.Subject !== subject) {
        throw new Error(`Expected "${subject}" for ${address}, the next message is "${first.Subject}".`);
      }
      const res = await fetch(`${MAILPIT_URL}/api/v1/message/${first.ID}`);
      const message = await res.json() as { Text?: string; HTML?: string };
      const text = message.Text ?? "";
      const codes = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[0-9]{6,10}$/.test(line));
      if (codes.length > 1) throw new Error(`"${subject}" for ${address} carries more than one code.`);
      return { id: first.ID, subject: first.Subject, text, html: message.HTML ?? "", code: codes[0] ?? null };
    }
    if (Date.now() > deadline) throw new Error(`No "${subject}" arrived for ${address}.`);
    await sleep(150);
  }
}

/** The code in the next unread message, which must carry this subject. */
export async function nextCode(address: string, subject: string): Promise<string> {
  const mail = await nextMail(address, subject);
  if (!mail.code) throw new Error(`"${subject}" for ${address} carries no code.`);
  return mail.code;
}

// --- The database, as its owner ---------------------------------------------------
// Only for what the instance owner does from the SQL editor (promoting the first
// master admin), for reading facts no client may read, and for tidying up.

export async function sql<T = Record<string, unknown>>(query: string, args: unknown[] = []): Promise<T[]> {
  const client = new Client(DB_URL);
  await client.connect();
  try {
    return (await client.queryObject<T>({ text: query, args })).rows;
  } finally {
    await client.end();
  }
}

/** `select private.bootstrap_master_admin(email, force)`, as the owner runs it. */
export async function bootstrapMasterAdmin(email: string, force = false): Promise<Record<string, unknown>> {
  const [row] = await sql<{ result: Record<string, unknown> }>(
    "select private.bootstrap_master_admin($1, $2) as result",
    [email, force],
  );
  return row.result;
}

/** Master admins that count for the last-master guard: active, confirmed, password set. */
export async function usableMasterAdmins(): Promise<number> {
  const [row] = await sql<{ n: number }>(
    `select count(*)::int as n from public.profiles
      where role = 'master_admin' and status = 'active' and not must_set_password and email_confirmed_at is not null`,
  );
  return row.n;
}

export interface AuditRow {
  action: string;
  actor_id: string | null;
  actor_email: string | null;
  target_id: string | null;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
}

/** The audit rows about one account, oldest first. */
export const auditOf = (userId: string) =>
  sql<AuditRow>(
    `select action, actor_id::text as actor_id, actor_email, target_id, before_data, after_data
       from public.audit_log where target_type = 'user' and target_id = $1 order by created_at, id`,
    [userId],
  );

// --- Accounts -----------------------------------------------------------------------

export interface Account {
  id: string;
  email: string;
  password: string;
  /** Access token of the newest session this helper opened. */
  token: string;
  refreshToken: string;
}

const createdUsers = new Set<string>();
const createdProjects = new Set<string>();

/** Remember an account so it is removed when the run ends. */
export function track(userId: string): string {
  createdUsers.add(userId);
  return userId;
}

export const signUp = (email: string, password: string, data?: Record<string, unknown>) =>
  auth("POST", "/signup", { body: data ? { email, password, data } : { email, password } });

export const verifyCode = (type: "email" | "recovery" | "invite" | "email_change", email: string, token: string) =>
  auth("POST", "/verify", { body: { type, email, token } });

/**
 * How Auth looks a one-time code up: by a hash of the address the code was
 * SENT to and the code. Anybody who has read the email can compute it, and
 * Auth accepts the hash in place of address and code, also after the account's
 * address has changed.
 */
export const codeHash = (sentTo: string, code: string) => createHash("sha224").update(sentTo + code).digest("hex");

/** Redeem a one-time code by its hash alone, as Auth allows. */
export const verifyCodeHash = (type: "email" | "recovery" | "invite", tokenHash: string) =>
  auth("POST", "/verify", { body: { type, token_hash: tokenHash } });

/**
 * The person proves they can read the mailbox of their account's address: ask
 * for a password reset code, read it from the mail, type it. Returns the
 * session the code gives. The password is left as it is.
 */
export async function proveAddress(email: string): Promise<{ token: string }> {
  await sleep(1100); // Auth sends one email per address per second on the local stack.
  const asked = await auth("POST", "/recover", { body: { email } });
  if (asked.status !== 200) throw new Error(`Reset code for ${email} was not sent: ${asked.status} ${asked.text}`);
  const verified = await verifyCode("recovery", email, await nextCode(email, SUBJECT.recovery));
  if (verified.status !== 200) throw new Error(`Reset code for ${email} was refused: ${verified.status} ${verified.text}`);
  return { token: verified.body.access_token };
}

export const signIn = (email: string, password: string) =>
  auth("POST", "/token?grant_type=password", { body: { email, password } });

/** Sign in and keep the new session on the account. Fails the test when sign-in is refused. */
export async function signInAs(account: Account): Promise<string> {
  const reply = await signIn(account.email, account.password);
  if (reply.status !== 200) throw new Error(`Sign-in of ${account.email} failed: ${reply.status} ${reply.text}`);
  account.token = reply.body.access_token;
  account.refreshToken = reply.body.refresh_token;
  return account.token;
}

/** Sign up, read the emailed code, confirm. The account is signed in. */
export async function newAccount(label: string, name?: string): Promise<Account> {
  const email = newAddress(label);
  const password = newPassword();
  const created = await signUp(email, password, name ? { name } : undefined);
  if (created.status !== 200) throw new Error(`Sign-up of ${email} failed: ${created.status} ${created.text}`);
  const code = await nextCode(email, SUBJECT.confirmation);
  const verified = await verifyCode("email", email, code);
  if (verified.status !== 200) throw new Error(`Confirming ${email} failed: ${verified.status} ${verified.text}`);
  return {
    id: track(verified.body.user.id),
    email,
    password,
    token: verified.body.access_token,
    refreshToken: verified.body.refresh_token,
  };
}

/** A new project owned by the account, so it has data of its own to read. */
export async function newProject(owner: Account, title: string): Promise<string> {
  const id = `proj_${crypto.randomUUID()}`;
  const reply = await rpc("create_project", { p_id: id, p_title: title, p_study_type: "systematic-review" }, owner.token);
  if (reply.status !== 200) throw new Error(`create_project failed: ${reply.status} ${reply.text}`);
  createdProjects.add(id);
  return id;
}

/**
 * Remove what this run created: its projects, its accounts and its mail. The
 * audit log keeps its rows, as it must.
 *
 * Done as the database owner. The first statement marks the accounts as not
 * having set a password: such an account does not count as a usable master
 * admin, so the guard that protects the last master admin lets it go. That is
 * how a run that promoted a master admin can leave the database as it found it.
 */
export async function removeEverything(): Promise<void> {
  const users = [...createdUsers];
  const projects = [...createdProjects];
  if (projects.length > 0) await sql("delete from public.projects where id = any($1::text[])", [projects]);
  if (users.length > 0) {
    await sql("update public.profiles set must_set_password = true where id = any($1::uuid[])", [users]);
    await sql("delete from auth.users where id = any($1::uuid[])", [users]);
  }
  createdUsers.clear();
  createdProjects.clear();

  const ids: string[] = [];
  for (const address of usedAddresses) ids.push(...(await inbox(address)).map((m) => m.ID));
  if (ids.length > 0) {
    const res = await fetch(`${MAILPIT_URL}/api/v1/messages`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ IDs: ids }),
    });
    await res.body?.cancel();
  }
  usedAddresses.clear();
}
