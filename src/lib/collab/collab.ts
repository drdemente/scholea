/**
 * Local-first collaboration (§10): per-step comments, supervisor sign-offs, and
 * a "who did what" contribution ledger derived from the local audit log. Every
 * write is attributed and timestamped, online or off.
 *
 * A project kept on this device works as it always has: what is written is
 * stored here under the name and role chosen on this device. For a project in
 * an account (see `CollabMode`) a comment or sign-off is put in the outbox
 * under the account's name instead, and `collab-sync.ts` uploads it. The
 * research core never depends on that layer: writing only ever touches this
 * device.
 */
import {
  db,
  logAction,
  type AuditEntry,
  type CollabSyncState,
  type Comment,
  type OutboxItem,
  type Review,
  type ReviewStatus,
} from "@/lib/db/schema";
import { planComment, planSignOff, reviewKey, reviewOutboxUid, type CollabMode } from "./collab-plan";
import { actorName, useIdentity } from "./identity-store";
import { uuidV4 } from "./links";

const LOCAL: CollabMode = { kind: "local" };

let lastQueuedAt = 0;

/**
 * The time to stamp on something put in the outbox: now, but never the same
 * as, or before, the one before it. Uploads go in this order, so two things
 * written in the same instant still go up the way they were written.
 */
function nextQueuedAt(): number {
  lastQueuedAt = Math.max(Date.now(), lastQueuedAt + 1);
  return lastQueuedAt;
}

// --- Comments ----------------------------------------------------------------

/**
 * Add a comment to a step. Resolves false when nothing was written: the text
 * was empty, the project's account is not signed in, or the text is longer
 * than the account accepts. See `planComment`.
 */
export async function addComment(projectId: string, stepId: string, text: string, mode: CollabMode = LOCAL): Promise<boolean> {
  const account = mode.kind === "account";
  const plan = planComment({ projectId, stepId, text, mode, uid: account ? uuidV4() : "", now: account ? nextQueuedAt() : 0 });
  if (plan.to === "nowhere") return false;
  if (plan.to === "outbox") {
    await db.outbox.put(plan.item);
    await logAction(projectId, "comment.add", stepId, plan.actor);
    return true;
  }
  const { role } = useIdentity.getState();
  await db.comments.add({ projectId, stepId, author: actorName(), role, text: text.trim(), timestamp: Date.now(), origin: "local" });
  await logAction(projectId, "comment.add", stepId, actorName());
  return true;
}

export function listComments(projectId: string, stepId: string): Promise<Comment[]> {
  return db.comments.where({ projectId, stepId }).sortBy("timestamp");
}

export async function countComments(projectId: string, stepId: string): Promise<number> {
  return db.comments.where({ projectId, stepId }).count();
}

// --- Supervisor reviews / sign-offs ------------------------------------------

/**
 * Sign a step off, or ask for changes. Resolves false when nothing was
 * written: the project's account is not signed in, the person's role on an
 * account project does not allow it, or the note is too long for the account.
 * See `planSignOff`.
 */
export async function setReview(
  projectId: string,
  stepId: string,
  status: ReviewStatus,
  note?: string,
  mode: CollabMode = LOCAL,
): Promise<boolean> {
  const action = status === "approved" ? "review.approve" : "review.request_changes";
  if (mode.kind === "account") {
    const uid = reviewOutboxUid(projectId, stepId, mode.me.id);
    // Read and written together: what was on screen when the person signed is
    // kept with the sign-off, and one that was already waiting is replaced.
    const actor = await db.transaction("rw", db.reviews, db.outbox, async () => {
      const plan = planSignOff({
        projectId,
        stepId,
        status,
        note,
        mode,
        shown: await db.reviews.get(reviewKey(projectId, stepId)),
        waiting: await db.outbox.get(uid),
        now: nextQueuedAt(),
      });
      if (plan.to !== "outbox") return null;
      await db.outbox.put(plan.item);
      return plan.actor;
    });
    if (actor === null) return false;
    await logAction(projectId, action, stepId, actor);
    return true;
  }
  if (planSignOff({ projectId, stepId, status, note, mode, now: 0 }).to !== "device") return false;
  const review: Review = {
    id: reviewKey(projectId, stepId),
    projectId,
    stepId,
    status,
    reviewer: actorName(),
    note: note?.trim() || undefined,
    timestamp: Date.now(),
    origin: "local",
  };
  await db.reviews.put(review);
  await logAction(projectId, action, stepId, actorName());
  return true;
}

export function getReview(projectId: string, stepId: string): Promise<Review | undefined> {
  return db.reviews.get(reviewKey(projectId, stepId));
}

export function listReviews(projectId: string): Promise<Review[]> {
  return db.reviews.where({ projectId }).toArray();
}

// --- Waiting to upload (account projects) --------------------------------------

/** The comments and sign-offs of a step that the account does not have yet, whoever wrote them. */
export function listUnsent(projectId: string, stepId: string): Promise<OutboxItem[]> {
  return db.outbox.where({ projectId, stepId }).toArray();
}

/** Give up on a comment or sign-off that has not been uploaded. It is gone for good. */
export async function discardUnsent(uid: string): Promise<void> {
  await db.outbox.delete(uid);
}

/** Let one that the account refused be tried again at the next sync. */
export async function retryUnsent(uid: string): Promise<void> {
  await db.outbox
    .where("uid")
    .equals(uid)
    .modify((item) => {
      delete item.error;
      item.attempts = 0;
    });
}

/** How far this device has read a project's team discussion, and who is on the team. */
export function getCollabSync(projectId: string): Promise<CollabSyncState | undefined> {
  return db.collabSync.get(projectId);
}

/**
 * Remove everything this layer keeps for a project: its comments, its
 * sign-offs, what was waiting to upload and its sync record. Run when the
 * project is deleted from this device, so nothing of it can turn up again
 * under a later project.
 */
export async function purgeProjectCollab(projectId: string): Promise<void> {
  await db.transaction("rw", [db.comments, db.reviews, db.outbox, db.collabSync], async () => {
    await db.comments.where("projectId").equals(projectId).delete();
    await db.reviews.where("projectId").equals(projectId).delete();
    await db.outbox.where("projectId").equals(projectId).delete();
    await db.collabSync.delete(projectId);
  });
}

// --- Contribution ledger -----------------------------------------------------

export async function listActivity(projectId: string): Promise<AuditEntry[]> {
  const all = await db.auditLog.where({ projectId }).toArray();
  return all.sort((a, b) => b.timestamp - a.timestamp);
}

export interface ContributorSummary {
  actor: string;
  count: number;
  lastAt: number;
}

/** Pure: collapse an activity feed into a per-contributor summary, busiest first. */
export function summarizeContributions(entries: AuditEntry[]): ContributorSummary[] {
  const byActor = new Map<string, ContributorSummary>();
  for (const e of entries) {
    const cur = byActor.get(e.actor) ?? { actor: e.actor, count: 0, lastAt: 0 };
    cur.count += 1;
    cur.lastAt = Math.max(cur.lastAt, e.timestamp);
    byActor.set(e.actor, cur);
  }
  return [...byActor.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}

const ACTION_LABEL: Record<string, string> = {
  "project.create": "created the project",
  "project.delete": "deleted the project",
  "step.complete": "completed a step",
  "comment.add": "commented",
  "review.approve": "approved a step",
  "review.request_changes": "requested changes",
  "search.run": "ran a search",
};

/** Human-readable phrasing for an audit action (falls back to the raw code). */
export function describeAction(action: string): string {
  return ACTION_LABEL[action] ?? action.replace(/[._]/g, " ");
}

/** Compact relative time for comments/activity ("just now", "5m ago", date). */
export function formatWhen(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}
