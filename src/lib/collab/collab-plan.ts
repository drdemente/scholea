/**
 * The rules for comments and sign-offs on a project that is in an account.
 *
 * Three kinds of rows, three rules:
 * - `comments` and `reviews` hold what is shown: rows written on this device
 *   for a project kept on this device (`local`), or a copy of what the team
 *   has in the account (`server`, the mirror).
 * - the outbox holds what the person wrote for an account project and the
 *   account does not have yet.
 * - the mirror is written only by sync, the outbox only by what the person
 *   does. What is shown merges the two.
 *
 * Everything here is pure, with type-only imports, so the rules are
 * unit-tested without a database or a backend. `collab-sync.ts` carries them
 * out.
 */
import type { DeviceAccount, SessionPhase } from "@/lib/account/types";
import type { CollaboratorRole, Comment, OutboxItem, Review, ReviewStatus } from "@/lib/db/schema";
import type { Link } from "./links";
import type { ProjectRole } from "./sync";

// --- Limits ----------------------------------------------------------------------------

/** The account accepts comments up to this many characters. Checked before anything is queued. */
export const COMMENT_MAX = 5000;
/** And sign-off notes up to this many. */
export const NOTE_MAX = 2000;

/** Length as the account counts it: in whole characters, so an emoji is one. */
export function charCount(text: string): number {
  return Array.from(text).length;
}

/** A time from the backend as epoch milliseconds. It sends numbers; a numeric string or an ISO date is read too. Anything else is 0. */
export function toMs(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v !== "string") return 0;
  const text = v.trim();
  if (text === "") return 0;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? 0 : parsed;
}

// --- What the backend returns ------------------------------------------------------------

/** A comment as the account holds it. `author_id` is null once that account is gone. */
export interface ServerComment {
  id: string;
  step_id: string;
  author_id: string | null;
  author_name: string;
  text: string;
  created_at: number;
}

/** A step's sign-off as the account holds it. A new one replaces the old one and carries a new time. */
export interface ServerReview {
  step_id: string;
  status: ReviewStatus;
  reviewer_id: string | null;
  reviewer_name: string;
  note: string | null;
  created_at: number;
}

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function idOrNull(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** A comment row, or `null` when it cannot be placed (no id or no step). */
export function commentFromRow(row: unknown): ServerComment | null {
  const r = record(row);
  if (!r) return null;
  const id = idOrNull(r.id);
  const step = idOrNull(r.step_id);
  if (!id || !step) return null;
  return {
    id,
    step_id: step,
    author_id: idOrNull(r.author_id),
    author_name: text(r.author_name),
    text: text(r.text),
    created_at: toMs(r.created_at),
  };
}

/** A sign-off row, or `null` when it has no step or a status this app does not know. */
export function reviewFromRow(row: unknown): ServerReview | null {
  const r = record(row);
  if (!r) return null;
  const step = idOrNull(r.step_id);
  if (!step || (r.status !== "approved" && r.status !== "changes")) return null;
  return {
    step_id: step,
    status: r.status,
    reviewer_id: idOrNull(r.reviewer_id),
    reviewer_name: text(r.reviewer_name),
    note: typeof r.note === "string" && r.note !== "" ? r.note : null,
    created_at: toMs(r.created_at),
  };
}

// --- Keys --------------------------------------------------------------------------------

/** The key of a step's sign-off on this device. The account's own key uses its project id and is ignored. */
export function reviewKey(projectId: string, stepId: string): string {
  return `${projectId}:${stepId}`;
}

/**
 * The outbox key of a sign-off: one per project, step and account, so signing
 * off a step again replaces what was waiting, and two accounts that use the
 * same device never replace each other's.
 */
export function reviewOutboxUid(projectId: string, stepId: string, accountId: string): string {
  return `${projectId}:${stepId}:${accountId}`;
}

function isMirror(row: { origin?: string }): boolean {
  return row.origin === "server";
}

/** The copy of a team comment that is kept on this device. */
export function mirrorComment(localProjectId: string, c: ServerComment): Comment {
  return {
    projectId: localProjectId,
    stepId: c.step_id,
    author: c.author_name,
    text: c.text,
    timestamp: c.created_at,
    origin: "server",
    uid: c.id,
    ...(c.author_id ? { authorId: c.author_id } : {}),
  };
}

/** The copy of a team sign-off that is kept on this device. */
export function mirrorReview(localProjectId: string, r: ServerReview): Review {
  return {
    id: reviewKey(localProjectId, r.step_id),
    projectId: localProjectId,
    stepId: r.step_id,
    status: r.status,
    reviewer: r.reviewer_name,
    ...(r.note ? { note: r.note } : {}),
    timestamp: r.created_at,
    origin: "server",
    ...(r.reviewer_id ? { reviewerId: r.reviewer_id } : {}),
  };
}

// --- Whose words these are ---------------------------------------------------------------

/** The signed-in person, as far as comments need to know them. */
export interface Me {
  id: string;
  name: string;
}

/** The name the account stamps on what a person writes: their name, or the start of their address when they gave none. */
export function accountName(person: { name: string; email: string }): string {
  return person.name.trim() || person.email.split("@")[0].trim() || "You";
}

/**
 * How a project's discussion works right now.
 *
 * - `local`: the project is kept on this device. Comments and sign-offs are
 *   written here under the name and role chosen on this device, as always.
 * - `account`: the project is in the signed-in person's account. What they
 *   write is queued and uploaded; their name and their right to sign off come
 *   from the account and their role on the project.
 * - `readonly`: the project is in an account that is not signed in. Nothing
 *   can be written, so nothing typed under a device name can ever land in a
 *   team's thread. `me` is the account whose projects the device still shows,
 *   when the project is theirs: what they left waiting stays visible to them.
 */
export type CollabMode =
  | { kind: "local" }
  | { kind: "account"; serverId: string; role: ProjectRole; me: Me }
  | { kind: "readonly"; reason: "signed-out" | "other-account"; me: Me | null };

export interface CollabSession {
  phase: SessionPhase;
  profile: { id: string; name: string; email: string } | null;
  deviceAccount: DeviceAccount | null;
}

export function collabMode(link: Link | null | undefined, session: CollabSession): CollabMode {
  if (link?.kind !== "account") return { kind: "local" };
  const profile = session.phase === "ready" ? session.profile : null;
  if (profile) {
    if (link.owner !== profile.id) return { kind: "readonly", reason: "other-account", me: null };
    return { kind: "account", serverId: link.serverId, role: link.role, me: { id: profile.id, name: accountName(profile) } };
  }
  const shown = session.deviceAccount;
  return {
    kind: "readonly",
    reason: "signed-out",
    me: shown && shown.id === link.owner ? { id: shown.id, name: accountName(shown) } : null,
  };
}

/** Who to show the waiting comments and sign-offs of: only ever their own author. */
export function viewerOf(mode: CollabMode): Me | null {
  return mode.kind === "local" ? null : mode.me;
}

export interface ReviewGate {
  /** Whether the sign-off area appears at all. */
  show: boolean;
  /** Whether the person may sign off. */
  allowed: boolean;
  /** Why not, when the area is shown without its controls. */
  reason?: "viewer" | "editor" | "readonly";
}

/**
 * Who may sign a step off. On a project kept on this device it is whoever
 * chose the supervisor role here, as always. On an account project only the
 * person's role on that project counts: the role chosen on this device has no
 * say, so nobody can make themselves a supervisor of someone else's project.
 */
export function reviewGate(mode: CollabMode, localRole: CollaboratorRole): ReviewGate {
  if (mode.kind === "local") {
    const supervisor = localRole === "supervisor";
    return { show: supervisor, allowed: supervisor };
  }
  if (mode.kind === "readonly") return { show: false, allowed: false, reason: "readonly" };
  if (mode.role === "supervisor" || mode.role === "owner") return { show: true, allowed: true };
  return { show: true, allowed: false, reason: mode.role };
}

// --- Writing ---------------------------------------------------------------------------------

/**
 * Where something the person wrote goes.
 *
 * - `nowhere`: it is refused (see `planComment` and `planSignOff`).
 * - `device`: into this device's comments or sign-offs, under the name chosen
 *   on this device, as it always has for a project kept here.
 * - `outbox`: it waits to be uploaded. `actor` is the name for this device's
 *   own activity log: the account's, not the device's.
 */
export type WritePlan = { to: "nowhere" } | { to: "device" } | { to: "outbox"; item: OutboxItem; actor: string };

/**
 * Where a new comment goes. Nothing is written for an empty text, while the
 * project's account is signed out, or for a text longer than the account
 * accepts: a comment that is queued must never be refused later for its
 * length. `uid` becomes the comment's id in the account, so an upload repeated
 * after a lost answer is not posted twice.
 */
export function planComment(input: { projectId: string; stepId: string; text: string; mode: CollabMode; uid: string; now: number }): WritePlan {
  const body = input.text.trim();
  if (body === "" || input.mode.kind === "readonly") return { to: "nowhere" };
  if (input.mode.kind === "local") return { to: "device" };
  if (charCount(body) > COMMENT_MAX) return { to: "nowhere" };
  const { me } = input.mode;
  return {
    to: "outbox",
    actor: me.name,
    item: { uid: input.uid, kind: "comment", projectId: input.projectId, stepId: input.stepId, queuedBy: me.id, queuedAt: input.now, text: body, attempts: 0 },
  };
}

/**
 * Where a sign-off goes. On an account project only a supervisor or the owner
 * may make one, whatever role was chosen on this device, and the note must fit
 * what the account accepts.
 *
 * `shown` is the step's sign-off as stored on this device, which is what the
 * person was looking at. If it is the team's, its time is kept with the new
 * sign-off (`baseAt`), so the upload can tell whether someone else has signed
 * the step off since. `waiting` is the person's own sign-off for the step that
 * has not been uploaded yet, if any: the new one replaces it and always
 * carries a later time, which is what tells the two apart.
 */
export function planSignOff(input: {
  projectId: string;
  stepId: string;
  status: ReviewStatus;
  note?: string;
  mode: CollabMode;
  shown?: Pick<Review, "origin" | "timestamp"> | null;
  waiting?: Pick<OutboxItem, "queuedAt"> | null;
  now: number;
}): WritePlan {
  const { mode } = input;
  if (mode.kind === "readonly") return { to: "nowhere" };
  if (mode.kind === "local") return { to: "device" };
  // Only the role on the project counts here, never the one chosen on this device.
  if (!reviewGate(mode, "researcher").allowed) return { to: "nowhere" };
  const words = input.note?.trim() ?? "";
  if (charCount(words) > NOTE_MAX) return { to: "nowhere" };
  return {
    to: "outbox",
    actor: mode.me.name,
    item: {
      uid: reviewOutboxUid(input.projectId, input.stepId, mode.me.id),
      kind: "review",
      projectId: input.projectId,
      stepId: input.stepId,
      queuedBy: mode.me.id,
      queuedAt: Math.max(input.now, (input.waiting?.queuedAt ?? -Infinity) + 1),
      status: input.status,
      ...(words ? { note: words } : {}),
      baseAt: input.shown?.origin === "server" ? input.shown.timestamp : null,
      attempts: 0,
    },
  };
}

// --- Reading the team's copy ---------------------------------------------------------------

export interface CommentPullPlan {
  /** New mirror rows, oldest first. */
  add: Comment[];
  /** Mirror rows whose content changed in the account (a renamed author, for one). */
  update: { id: number; changes: Partial<Comment> }[];
  /** Mirror rows that are no longer in the account. */
  removeIds: number[];
}

/**
 * Bring the mirror of a project's comments into line with the full list the
 * account just returned. Rows written on this device are never touched. Only
 * call this with a list that was read successfully and in full: whatever is
 * missing from it is removed from the mirror.
 */
export function planCommentPull(localProjectId: string, stored: readonly Comment[], server: readonly ServerComment[]): CommentPullPlan {
  const plan: CommentPullPlan = { add: [], update: [], removeIds: [] };
  const mirror = new Map<string, Comment & { id: number }>();
  for (const row of stored) {
    if (!isMirror(row) || row.id === undefined) continue;
    // A mirror row that cannot be matched to anything is not worth keeping.
    if (!row.uid || mirror.has(row.uid)) plan.removeIds.push(row.id);
    else mirror.set(row.uid, row as Comment & { id: number });
  }

  const seen = new Set<string>();
  for (const c of server) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const want = mirrorComment(localProjectId, c);
    const have = mirror.get(c.id);
    if (!have) {
      plan.add.push(want);
      continue;
    }
    const changes: Partial<Comment> = {};
    if (have.stepId !== want.stepId) changes.stepId = want.stepId;
    if (have.author !== want.author) changes.author = want.author;
    if (have.text !== want.text) changes.text = want.text;
    if (have.timestamp !== want.timestamp) changes.timestamp = want.timestamp;
    if ((have.authorId ?? null) !== (want.authorId ?? null)) changes.authorId = want.authorId;
    if (Object.keys(changes).length > 0) plan.update.push({ id: have.id, changes });
  }

  for (const [uid, row] of mirror) {
    if (!seen.has(uid)) plan.removeIds.push(row.id);
  }
  return plan;
}

export interface ReviewPullPlan {
  /** Mirror rows to write, new or changed. */
  put: Review[];
  /** Mirror rows whose sign-off is no longer in the account. */
  removeIds: string[];
}

/** The same for sign-offs: one per step, keyed by this device's project id. */
export function planReviewPull(localProjectId: string, stored: readonly Review[], server: readonly ServerReview[]): ReviewPullPlan {
  const plan: ReviewPullPlan = { put: [], removeIds: [] };
  const byId = new Map(stored.map((r) => [r.id, r]));
  const seen = new Set<string>();

  for (const r of server) {
    const want = mirrorReview(localProjectId, r);
    if (seen.has(want.id)) continue;
    seen.add(want.id);
    const have = byId.get(want.id);
    // Written on this device and not handed to the account yet: left alone.
    if (have && !isMirror(have)) continue;
    const same =
      have !== undefined &&
      have.status === want.status &&
      have.reviewer === want.reviewer &&
      (have.note ?? "") === (want.note ?? "") &&
      have.timestamp === want.timestamp &&
      (have.reviewerId ?? null) === (want.reviewerId ?? null);
    if (!same) plan.put.push(want);
  }

  for (const row of stored) {
    if (isMirror(row) && !seen.has(row.id)) plan.removeIds.push(row.id);
  }
  return plan;
}

// --- What is shown -------------------------------------------------------------------------

/**
 * - `local`: written on this device, for a project kept on this device.
 * - `synced`: the team has it.
 * - `pending`: the person's own, waiting to upload.
 * - `failed`: the person's own, refused by the account.
 */
export type ThreadState = "local" | "synced" | "pending" | "failed";

export interface ThreadItem {
  /** Stable while a comment goes from waiting to uploaded. */
  key: string;
  state: ThreadState;
  author: string;
  /** The account that wrote it, where one did. */
  authorId?: string;
  /** The role its author chose on this device. Only rows written here have one. */
  role?: CollaboratorRole;
  text: string;
  timestamp: number;
  /** For a waiting or refused comment: what "Try again" and "Discard" act on. */
  uid?: string;
  /** Why the account refused it. */
  error?: string;
}

/**
 * One thread from the stored comments of a step and what is still waiting to
 * upload. Waiting comments come last, show only to the account that wrote
 * them, and are left out once the mirror has them (the upload landed but its
 * answer was lost).
 */
export function mergeThread(stored: readonly Comment[], unsent: readonly OutboxItem[], me: Me | null): ThreadItem[] {
  const rows = [...stored].sort((a, b) => a.timestamp - b.timestamp || (a.id ?? 0) - (b.id ?? 0));
  const mirrored = new Set<string>();
  const items: ThreadItem[] = rows.map((c) => {
    const synced = isMirror(c);
    if (synced && c.uid) mirrored.add(c.uid);
    return {
      key: c.uid ?? `row-${c.id}`,
      state: synced ? "synced" : "local",
      author: c.author,
      ...(c.authorId ? { authorId: c.authorId } : {}),
      ...(c.role ? { role: c.role } : {}),
      text: c.text,
      timestamp: c.timestamp,
    };
  });
  if (!me) return items;

  const waiting = unsent
    .filter((o) => o.kind === "comment" && o.queuedBy === me.id && !mirrored.has(o.uid))
    .sort((a, b) => a.queuedAt - b.queuedAt || a.uid.localeCompare(b.uid));
  for (const o of waiting) {
    items.push({
      key: o.uid,
      state: o.error ? "failed" : "pending",
      author: me.name,
      authorId: me.id,
      text: o.text ?? "",
      timestamp: o.queuedAt,
      uid: o.uid,
      ...(o.error ? { error: o.error } : {}),
    });
  }
  return items;
}

export interface ReviewView {
  /** The sign-off to show for the step. `pending` is the person's own, not uploaded yet. */
  current: {
    status: ReviewStatus;
    reviewer: string;
    reviewerId?: string;
    note?: string;
    timestamp: number;
    state: "local" | "synced" | "pending";
  } | null;
  /** The person's own sign-off that the account refused or that was held back. */
  failed: { uid: string; error: string; status: ReviewStatus; note?: string } | null;
}

/**
 * The sign-off a step shows. The person's own waiting sign-off comes first:
 * it is what they just did. One that was refused or held back does not hide
 * the team's: that one stands, with a warning beside it.
 */
export function effectiveReview(stored: Review | null | undefined, unsent: readonly OutboxItem[], me: Me | null): ReviewView | null {
  const mine = me ? unsent.find((o) => o.kind === "review" && o.queuedBy === me.id && o.status !== undefined) : undefined;
  if (me && mine && mine.status && !mine.error) {
    return {
      current: {
        status: mine.status,
        reviewer: me.name,
        reviewerId: me.id,
        ...(mine.note ? { note: mine.note } : {}),
        timestamp: mine.queuedAt,
        state: "pending",
      },
      failed: null,
    };
  }
  const current: ReviewView["current"] = stored
    ? {
        status: stored.status,
        reviewer: stored.reviewer,
        ...(stored.reviewerId ? { reviewerId: stored.reviewerId } : {}),
        ...(stored.note ? { note: stored.note } : {}),
        timestamp: stored.timestamp,
        state: isMirror(stored) ? "synced" : "local",
      }
    : null;
  const failed: ReviewView["failed"] =
    mine && mine.status && mine.error
      ? { uid: mine.uid, error: mine.error, status: mine.status, ...(mine.note ? { note: mine.note } : {}) }
      : null;
  return current || failed ? { current, failed } : null;
}

// --- Uploading -----------------------------------------------------------------------------

export type FlushStep =
  /** Upload it to this server project. */
  | { type: "send"; item: OutboxItem; serverId: string }
  /** Leave it where it is. It is never dropped. */
  | { type: "skip"; item: OutboxItem; reason: "other-account" | "no-link" | "failed" }
  /** Do not upload it, and tell the person why. */
  | { type: "reject"; item: OutboxItem; error: "superseded" | "superseded_own" }
  /** The account already has exactly this (the upload landed, its answer was lost). */
  | { type: "settled"; item: OutboxItem };

export interface FlushInput {
  /** The signed-in account. Only what it wrote itself is sent. */
  userId: string;
  /** The links of the projects concerned, by this device's project id. */
  links: ReadonlyMap<string, Link>;
  /** The team's current sign-offs as just read, by `reviewKey`. */
  serverReviews: ReadonlyMap<string, Pick<Review, "timestamp" | "status" | "note" | "reviewerId">>;
  /** Also try what the account refused before. */
  force?: boolean;
}

/** The mirrored sign-offs of a project, keyed for `planFlush`. */
export function serverReviewsOf(reviews: readonly Review[]): Map<string, Review> {
  return new Map(reviews.filter(isMirror).map((r) => [r.id, r]));
}

/**
 * Decide, in order of writing, what to do with each waiting comment and
 * sign-off.
 *
 * Only the account that wrote an item uploads it: if someone queues a comment,
 * signs out, and another person signs in on the same device, that comment must
 * not go up under the second person's name.
 *
 * A sign-off is an attestation. One made offline days ago must not silently
 * replace a newer one from someone else, so it is held back when the team's
 * sign-off for that step is no longer the one that was on screen when it was
 * made (`baseAt`). The person is asked to look and sign off again.
 */
export function planFlush(items: readonly OutboxItem[], input: FlushInput): FlushStep[] {
  const ordered = [...items].sort(
    (a, b) => a.queuedAt - b.queuedAt || (a.kind === b.kind ? 0 : a.kind === "comment" ? -1 : 1) || a.uid.localeCompare(b.uid),
  );
  return ordered.map((item): FlushStep => {
    if (item.queuedBy !== input.userId) return { type: "skip", item, reason: "other-account" };
    const link = input.links.get(item.projectId);
    if (link?.kind !== "account" || link.owner !== input.userId || !link.created) return { type: "skip", item, reason: "no-link" };
    if (item.error && !input.force) return { type: "skip", item, reason: "failed" };
    if (item.kind === "comment") return { type: "send", item, serverId: link.serverId };

    const theirs = input.serverReviews.get(reviewKey(item.projectId, item.stepId));
    if ((theirs?.timestamp ?? null) === (item.baseAt ?? null)) return { type: "send", item, serverId: link.serverId };
    // The step's sign-off changed since this one was made. If the newer one is
    // the person's own, it came from another device or from an upload whose
    // answer was lost.
    if (theirs === undefined || theirs.reviewerId !== input.userId) return { type: "reject", item, error: "superseded" };
    if (theirs.status === item.status && (theirs.note ?? "") === (item.note ?? "")) return { type: "settled", item };
    return { type: "reject", item, error: "superseded_own" };
  });
}

/** Refusals that are about the account, not about the item: it waits until the account works again. */
const HOLD_CODES = ["unauthenticated", "account_suspended", "password_reset_required", "not_configured"];

/**
 * What a failed upload means for the item.
 *
 * - `retry`: the request did not get through, or the server was busy. Sent again later.
 * - `hold`: the account cannot be used right now. The item waits, unchanged.
 * - `reject`: the account will not take this item. Not sent again until the person asks.
 */
export function classifyPushError(e: { status: number; code: string }): "retry" | "hold" | "reject" {
  if (HOLD_CODES.includes(e.code) || e.status === 401) return "hold";
  if (e.status === 408 || e.status === 429 || e.status >= 500) return "retry";
  if (e.status >= 400) return "reject";
  // No answer at all (status 0: no connection, or the request never left).
  return "retry";
}

/** Whether an item that was refused or held back can simply be sent again. A sign-off that was overtaken is made again instead. */
export function canRetry(error: string): boolean {
  return error !== "superseded" && error !== "superseded_own";
}

// --- Taking a project into an account, and keeping a copy when it leaves -------------------

export interface AdoptionPlan {
  outbox: OutboxItem[];
  deleteCommentIds: number[];
  deleteReviewIds: string[];
}

/** "7 Oct 2026" */
function defaultDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function clip(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/** Cut a text into parts of at most `first`, then `rest`, whole characters. */
function parts(value: string, first: number, rest: number): string[] {
  const chars = Array.from(value);
  const out: string[] = [chars.slice(0, first).join("")];
  for (let at = first; at < chars.length; at += rest) out.push(chars.slice(at, at + rest).join(""));
  return out;
}

/**
 * Turn what was written on this device for a project into uploads, now that
 * the project is in `me`'s account ("Add to my account"). Every comment and
 * sign-off written here becomes a waiting upload under that account, in the
 * order it was written, and the device rows are listed for removal. Apply the
 * plan in one transaction: it then happens once, and a second run finds
 * nothing left to convert. Copies of team rows are not touched.
 *
 * The account stamps its own name and the upload time on everything. So that
 * a comment typed here as "Dr Khan" does not silently become the uploader's
 * own words, a row whose name differs from the account's says where it came
 * from.
 *
 * `waiting` is what is already waiting to upload for the project. A step the
 * account has a waiting sign-off for keeps that one: it was made after the
 * project went into the account, so it is the later word, and the sign-off
 * written on this device before that is only removed.
 */
export function planAdoption(
  comments: readonly Comment[],
  reviews: readonly Review[],
  me: Me,
  newId: () => string,
  formatDay: (ms: number) => string = defaultDay,
  waiting: readonly OutboxItem[] = [],
): AdoptionPlan {
  const plan: AdoptionPlan = { outbox: [], deleteCommentIds: [], deleteReviewIds: [] };
  const signedOff = new Set(waiting.filter((o) => o.kind === "review" && o.queuedBy === me.id).map((o) => o.uid));
  const sameName = (name: string) => name.trim() === "" || name.trim() === me.name.trim();
  // Strictly increasing, so the uploads keep the order the rows were written in.
  let last = -Infinity;
  const at = (timestamp: number) => (last = Math.max(timestamp, last + 1));

  const local = comments
    .filter((c) => !isMirror(c) && c.id !== undefined)
    .sort((a, b) => a.timestamp - b.timestamp || (a.id ?? 0) - (b.id ?? 0));
  for (const c of local) {
    const prefix = sameName(c.author) ? "" : `[Written on this device as "${clip(c.author.trim(), 80)}" on ${formatDay(c.timestamp)}] `;
    // An older comment may be longer than the account accepts. It goes up in parts, nothing is cut off.
    const [head, ...tail] = parts(c.text, COMMENT_MAX - charCount(prefix), COMMENT_MAX);
    for (const body of [prefix + head, ...tail]) {
      plan.outbox.push({
        uid: newId(),
        kind: "comment",
        projectId: c.projectId,
        stepId: c.stepId,
        queuedBy: me.id,
        queuedAt: at(c.timestamp),
        text: body,
        attempts: 0,
      });
    }
    plan.deleteCommentIds.push(c.id as number);
  }

  for (const r of reviews.filter((x) => !isMirror(x)).sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))) {
    plan.deleteReviewIds.push(r.id);
    if (signedOff.has(reviewOutboxUid(r.projectId, r.stepId, me.id))) continue;
    const prefix = sameName(r.reviewer) ? "" : `Recorded on this device as "${clip(r.reviewer.trim(), 80)}" on ${formatDay(r.timestamp)}.`;
    const own = (r.note ?? "").trim();
    const note = clip([prefix, own].filter((s) => s !== "").join(" "), NOTE_MAX);
    plan.outbox.push({
      uid: reviewOutboxUid(r.projectId, r.stepId, me.id),
      kind: "review",
      projectId: r.projectId,
      stepId: r.stepId,
      queuedBy: me.id,
      queuedAt: at(r.timestamp),
      status: r.status,
      ...(note ? { note } : {}),
      // Made before the project had a team: there was no sign-off to look at.
      baseAt: null,
      attempts: 0,
    });
  }
  return plan;
}

/** Whether an adoption plan has anything to do. */
export function isEmptyAdoption(plan: AdoptionPlan): boolean {
  return plan.outbox.length + plan.deleteCommentIds.length + plan.deleteReviewIds.length === 0;
}

export interface LocalisePlan {
  /** Team comments that become part of the copy kept on this device. */
  updateComments: { id: number; changes: Partial<Comment> }[];
  /** The person's own waiting comments, now simply comments on that copy. */
  addComments: Comment[];
  putReviews: Review[];
  /** Waiting uploads that have nowhere to go any more. */
  removeOutbox: OutboxItem[];
}

/**
 * The reverse of adoption. A project whose server copy went away (its owner
 * deleted it, or the person left or was removed) is kept as a copy on this
 * device only. Its discussion is kept with it: the team's comments and
 * sign-offs as they last were, and what the person had written but not yet
 * uploaded. All of it becomes ordinary device rows, which sync never touches
 * again, so nothing is lost if the project is later downloaded afresh or put
 * into an account as a new project. What other accounts left waiting stays
 * where it is.
 */
export function planLocalise(comments: readonly Comment[], reviews: readonly Review[], unsent: readonly OutboxItem[], me: Me | null): LocalisePlan {
  const plan: LocalisePlan = { updateComments: [], addComments: [], putReviews: [], removeOutbox: [] };
  for (const c of comments) {
    if (isMirror(c) && c.id !== undefined) plan.updateComments.push({ id: c.id, changes: { origin: "local", uid: undefined, authorId: undefined } });
  }
  const kept = new Map<string, Review>();
  for (const r of reviews) {
    if (!isMirror(r)) continue;
    const { reviewerId: _reviewerId, ...rest } = r;
    kept.set(r.id, { ...rest, origin: "local" });
  }
  if (me) {
    const mine = unsent.filter((o) => o.queuedBy === me.id).sort((a, b) => a.queuedAt - b.queuedAt || a.uid.localeCompare(b.uid));
    for (const o of mine) {
      plan.removeOutbox.push(o);
      if (o.kind === "comment") {
        if (o.text) plan.addComments.push({ projectId: o.projectId, stepId: o.stepId, author: me.name, text: o.text, timestamp: o.queuedAt, origin: "local" });
      } else if (o.status && !o.error) {
        // A sign-off that was held back or refused never stood. One that was only waiting does.
        const id = reviewKey(o.projectId, o.stepId);
        kept.set(id, {
          id,
          projectId: o.projectId,
          stepId: o.stepId,
          status: o.status,
          reviewer: me.name,
          ...(o.note ? { note: o.note } : {}),
          timestamp: o.queuedAt,
          origin: "local",
        });
      }
    }
  }
  plan.putReviews = [...kept.values()];
  return plan;
}

/** Whether a localise plan has anything to do. */
export function isEmptyLocalise(plan: LocalisePlan): boolean {
  return plan.updateComments.length + plan.addComments.length + plan.putReviews.length + plan.removeOutbox.length === 0;
}

/**
 * Waiting items of the signed-in person that sit on a copy of a project which
 * now belongs to another account on this device, while they have a copy of
 * that same server project of their own. Two members of one project who share
 * a device can end up like this: the second took over the first one's copy,
 * and the first later got a fresh one. The items move to the person's own
 * copy. Left where they are, nobody would ever see or upload them.
 */
export function planRehome(items: readonly OutboxItem[], links: ReadonlyMap<string, Link>, userId: string): { item: OutboxItem; to: string }[] {
  const own = new Map<string, string>();
  for (const [localId, link] of links) {
    if (link.kind === "account" && link.owner === userId) own.set(link.serverId, localId);
  }
  const moves: { item: OutboxItem; to: string }[] = [];
  for (const item of items) {
    if (item.queuedBy !== userId) continue;
    const link = links.get(item.projectId);
    if (link?.kind !== "account" || link.owner === userId) continue;
    const to = own.get(link.serverId);
    if (to !== undefined) moves.push({ item, to });
  }
  return moves;
}

// --- When to look ---------------------------------------------------------------------------

/**
 * Whether a project's comments and sign-offs need a sync now: there is
 * something to upload (waiting items, or device rows of a project that has
 * just gone into the account), it is the project on screen, or the account's
 * change marker is not the one this device last read up to.
 */
export function shouldPull(input: {
  hasUnsent: boolean;
  hasLocal?: boolean;
  isActive: boolean;
  serverStamp: number | null;
  seenStamp: number | null;
}): boolean {
  return input.hasUnsent || input.hasLocal === true || input.isActive || input.serverStamp !== input.seenStamp;
}

/** A project opened again is checked for new comments at most this often. */
export const OPEN_SYNC_MS = 30_000;
/** And "Refresh" works at most this often. */
export const REFRESH_SYNC_MS = 10_000;

export function isDue(now: number, lastAt: number | undefined, minGap: number): boolean {
  return lastAt === undefined || now - lastAt >= minGap;
}

// --- Words ------------------------------------------------------------------------------------

export const UNSENT_REVIEW_HINT = "Your sign-off is saved on this device and has not been uploaded yet.";
export const READONLY_NOTE = "Sign in to the account this project belongs to if you want to comment.";
export const HELD_NOTE = "Your account is suspended, so new comments stay on this device until it is reactivated.";

/** Under a comment that is waiting to upload. */
export function pendingHint(offline: boolean): string {
  return offline ? "Not uploaded yet. It will send when you are back online." : "Not uploaded yet.";
}

const COMMENT_REASON: Record<string, string> = {
  forbidden: "you no longer have permission to comment on this project.",
  not_found: "this project is no longer shared with you.",
  invalid_input: "the comment is too long (5,000 characters at most).",
};

const REVIEW_REASON: Record<string, string> = {
  forbidden: "only a project supervisor or the owner can sign off a step.",
  not_found: "this project is no longer shared with you.",
  invalid_input: "the note is too long (2,000 characters at most).",
};

const OTHER_REASON = "the server did not accept it.";

/** What to say about a comment or sign-off of the person's own that did not upload. */
export function describeUnsentError(kind: OutboxItem["kind"], error: string): string {
  if (kind === "comment") return `Could not upload: ${Object.hasOwn(COMMENT_REASON, error) ? COMMENT_REASON[error] : OTHER_REASON}`;
  if (error === "superseded") {
    return "Your sign-off was not uploaded because someone else signed off this step while you were offline. Check theirs, then sign off again if it still applies.";
  }
  if (error === "superseded_own") {
    return "Your sign-off was not uploaded because you signed off this step somewhere else in the meantime. Check that one, then sign off again if it still applies.";
  }
  return `Could not upload your sign-off: ${Object.hasOwn(REVIEW_REASON, error) ? REVIEW_REASON[error] : OTHER_REASON}`;
}

/** Shown in place of the sign-off buttons to a member who may not sign off. */
export function gateNote(reason: "viewer" | "editor"): string {
  const role = reason === "viewer" ? "a Viewer" : "an Editor";
  return `Only a project supervisor or the owner can sign off a step. You are ${role} on this project. The owner can change your role in Share.`;
}

/** The line under an account project's discussion that says how fresh it is. */
export function teamSyncLine(input: { pulledAt: number | null; offline: boolean }, when: (ms: number) => string): string {
  if (input.pulledAt === null) return "Not synced with your team yet.";
  if (input.offline) return `Offline. Showing what was last synced (${when(input.pulledAt)}).`;
  return `Synced with your team ${when(input.pulledAt)}.`;
}

/**
 * The same, without the time: what a screen reader is told when the state
 * changes. The time in the visible line moves on by itself, and announcing
 * every "2m ago" would talk over someone who is typing a comment.
 */
export function teamSyncAnnouncement(input: { pulledAt: number | null; offline: boolean }): string {
  if (input.pulledAt === null) return "Not synced with your team yet.";
  return input.offline ? "Offline. Showing what was last synced." : "Synced with your team.";
}
