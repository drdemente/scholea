/**
 * Syncs the comments and sign-offs of projects that are in the signed-in
 * person's account, so collaborators see each other's discussion. Part of the
 * account layer: it runs only while someone is signed in, and a build with no
 * backend never starts it or makes a request. Writing a comment or a sign-off
 * only ever touches this device (`collab.ts`); this file is what carries it to
 * the account and brings the team's side back.
 *
 * One pass per project, one at a time for that project:
 *
 *   1. adopt     what was written on this device before the project was in the
 *                account becomes uploads (once)
 *   2. reviews   read the team's sign-offs into the mirror
 *   3. flush     upload what is waiting, oldest first
 *   4. comments  read the team's comments into the mirror
 *   5. stamp     note how far this device has read
 *
 * The decisions are the pure rules in `collab-plan.ts`; this file reads,
 * asks them, and writes. After every wait a pass checks that the same person
 * is still signed in and the project is still theirs, and stops if not.
 *
 * Comments and sign-offs live in their own tables and cannot overwrite a
 * project's content, so a pass runs whether or not the project has edits
 * waiting to upload.
 *
 * `project-sync.ts` starts and stops this with the session and runs
 * `reconcileCollab` at the end of every sync.
 */
import { useMemo } from "react";
import { useSession } from "@/lib/account/session-store";
import { db, type CollabMember, type CollabSyncState, type Comment, type OutboxItem, type Review, type ReviewStatus } from "@/lib/db/schema";
import { useProject } from "@/lib/study/project-store";
import { SyncError, isConnectivityError } from "@/lib/supabase/errors";
import {
  OPEN_SYNC_MS,
  accountName,
  classifyPushError,
  collabMode,
  commentFromRow,
  isDue,
  isEmptyAdoption,
  isEmptyLocalise,
  mirrorComment,
  mirrorReview,
  planAdoption,
  planCommentPull,
  planFlush,
  planLocalise,
  planRehome,
  planReviewPull,
  reviewFromRow,
  reviewOutboxUid,
  serverReviewsOf,
  shouldPull,
  type CollabMode,
  type Me,
  type ServerComment,
  type ServerReview,
} from "./collab-plan";
import { getLink, listLinks, subscribeLinks, useLink, uuidV4, type AccountLink, type Link } from "./links";
import { callRpc, type RpcCaller } from "./sync";

// --- The calls -----------------------------------------------------------------------

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * A list the backend returned under `key`. An answer without one is an error,
 * never "nothing there": an empty list empties the mirror.
 */
function listOf(data: unknown, key: string): unknown[] {
  const list = record(data)?.[key];
  if (!Array.isArray(list)) throw new SyncError(500, "server_error");
  return list;
}

function memberFromRow(row: unknown): CollabMember | null {
  const r = record(row);
  if (!r || typeof r.user_id !== "string" || r.user_id === "") return null;
  return {
    id: r.user_id,
    name: typeof r.name === "string" ? r.name : "",
    email: typeof r.email === "string" ? r.email : "",
    role: typeof r.role === "string" ? r.role : "viewer",
  };
}

export function createCollabApi(call: RpcCaller) {
  return {
    /** Every comment of the project, oldest first. Any member. */
    async listComments(serverId: string): Promise<ServerComment[]> {
      const rows = listOf(await call("list_project_comments", { p_project_id: serverId }), "comments");
      return rows.map(commentFromRow).filter((c): c is ServerComment => c !== null);
    },

    /**
     * Add a comment under an id made on this device. Safe to repeat: the same
     * id returns the comment that is already there. Any member.
     */
    async addComment(serverId: string, stepId: string, text: string, id: string): Promise<ServerComment> {
      const data = record(await call("add_project_comment", { p_project_id: serverId, p_step_id: stepId, p_text: text, p_id: id }));
      const comment = commentFromRow(data?.comment);
      if (!comment) throw new SyncError(500, "server_error");
      return comment;
    },

    /** The current sign-off of every step that has one. Any member. */
    async listReviews(serverId: string): Promise<ServerReview[]> {
      const rows = listOf(await call("list_project_reviews", { p_project_id: serverId }), "reviews");
      return rows.map(reviewFromRow).filter((r): r is ServerReview => r !== null);
    },

    /** Sign a step off or ask for changes, replacing the step's sign-off. Supervisors and owners only. */
    async setReview(serverId: string, stepId: string, status: ReviewStatus, note?: string): Promise<ServerReview> {
      const args: Record<string, unknown> = { p_project_id: serverId, p_step_id: stepId, p_status: status };
      if (note) args.p_note = note;
      const review = reviewFromRow(record(await call("set_project_review", args))?.review);
      if (!review) throw new SyncError(500, "server_error");
      return review;
    },

    /** The project's team, to show who wrote what. Any member. */
    async listMembers(serverId: string): Promise<CollabMember[]> {
      const rows = listOf(await call("list_project_members", { p_project_id: serverId }), "members");
      return rows.map(memberFromRow).filter((m): m is CollabMember => m !== null);
    },
  };
}

export type CollabApi = ReturnType<typeof createCollabApi>;

// --- What the engine needs from the device ---------------------------------------------
// Narrow views, so the engine can be driven in tests with plain objects.

/** A change to one waiting item, made only if it is still the version that was read. */
export interface OutboxOp {
  uid: string;
  /** The version the decision was made for. A sign-off made again since carries another time. */
  queuedAt: number;
  /** What to do with that version: remove it, or change these fields. */
  then: "delete" | Partial<OutboxItem>;
  /** What to change on a newer version, when one has taken its place. */
  otherwise?: Partial<OutboxItem>;
}

/** Changes that are made together or not at all. */
export interface CollabChange {
  /**
   * Comments to store. One with a `uid` replaces the row that has that `uid`.
   * If that row belongs to another project on this device (two copies of one
   * server project), it moves here and the other copy is marked unread, so it
   * reads its own again.
   */
  putComments?: Comment[];
  updateComments?: { id: number; changes: Partial<Comment> }[];
  deleteComments?: number[];
  putReviews?: Review[];
  deleteReviews?: string[];
  putOutbox?: OutboxItem[];
  outbox?: OutboxOp[];
  putState?: CollabSyncState;
  deleteStates?: string[];
}

/** Everything this layer keeps on the device for one project. */
export interface ProjectRows {
  comments: Comment[];
  reviews: Review[];
  outbox: OutboxItem[];
  state: CollabSyncState | undefined;
}

export interface CollabStore {
  reviews(projectId: string): Promise<Review[]>;
  /** What is waiting to upload: for one project, or on the whole device. */
  outbox(projectId?: string): Promise<OutboxItem[]>;
  states(): Promise<CollabSyncState[]>;
  /** Which of these projects hold comments or sign-offs that were written on this device. */
  withLocalRows(projectIds: readonly string[]): Promise<string[]>;
  apply(change: CollabChange): Promise<void>;
  /**
   * Read what is kept for one project and apply what `decide` makes of it, as
   * one step: nothing else, in this window or another, can write in between.
   * So a conversion that must happen once happens once, however many windows
   * are open. `decide` must not wait for anything. `null` changes nothing.
   */
  transact(projectId: string, decide: (rows: ProjectRows) => CollabChange | null): Promise<void>;
}

export interface CollabPorts {
  api: CollabApi;
  store: CollabStore;
  links: {
    get(localId: string): Link | null;
    list(): ReadonlyMap<string, Link>;
    subscribe(listener: () => void): () => void;
  };
  session: {
    /** The signed-in person, or `null`. */
    me(): Me | null;
    /** Ask the session to check the account again (the backend just refused it). */
    recheck(): void;
  };
  /** The project that is open in the runner. */
  editor: {
    currentId(): string | null;
    /** Called whenever another project is opened, or the open one is closed. */
    subscribe(listener: () => void): () => void;
  };
  device: { online(): boolean; now(): number };
  /** A fresh comment id (a UUID). */
  newId(): string;
}

/** How one pass ended. `skipped`: there was nothing to sync for this person, or they changed on the way. */
export type PassOutcome = "synced" | "offline" | "error" | "skipped";

/** Refusals that are about the account itself. The session is asked to look again. */
const ACCOUNT_REFUSALS = ["unauthenticated", "account_suspended", "password_reset_required"];

// --- Engine ------------------------------------------------------------------------------

export function createCollabSync(ports: CollabPorts) {
  const { api, store } = ports;

  /** Who this is running for. `null` while stopped. */
  let activeUser: string | null = null;
  /**
   * Goes up on every start and stop. A pass captures it when it begins and
   * checks it after every wait, so one that is still in flight when the person
   * changes gives up instead of acting for the next person.
   */
  let generation = 0;
  const alive = (gen: number) => gen === generation;

  /** The end of the last pass asked for, per project: passes of one project run one at a time. */
  const chains = new Map<string, Promise<unknown>>();
  /** A pass that has been asked for and has not started. Another request for the project joins it. */
  const waiting = new Map<string, { run: Promise<PassOutcome>; stamp?: number | null }>();
  /** When a pass last started, per project. */
  const lastPassAt = new Map<string, number>();
  let detachers: Array<() => void> = [];

  /** The link, if the project is in this account and the server has confirmed it. */
  function mine(localId: string, user: string): AccountLink | null {
    const link = ports.links.get(localId);
    return link?.kind === "account" && link.owner === user && link.created ? link : null;
  }

  /**
   * Upload what is waiting for one project, oldest first. Resolves false when
   * the person changed on the way. Throws `SyncError` when an upload has to
   * wait (no connection, a busy server, an account that cannot be used):
   * nothing after it goes up either, so the order is kept.
   */
  async function flush(localId: string, user: string, link: AccountLink, fresh: () => boolean): Promise<boolean> {
    const steps = planFlush(await store.outbox(localId), {
      userId: user,
      links: new Map([[localId, link]]),
      serverReviews: serverReviewsOf(await store.reviews(localId)),
    });

    for (const step of steps) {
      if (step.type === "skip") continue;
      if (!fresh()) return false;
      const { item } = step;
      const version = { uid: item.uid, queuedAt: item.queuedAt };

      if (step.type === "reject") {
        await store.apply({ outbox: [{ ...version, then: { error: step.error } }] });
        continue;
      }
      if (step.type === "settled") {
        await store.apply({ outbox: [{ ...version, then: "delete" }] });
        continue;
      }

      try {
        if (item.kind === "comment") {
          const saved = await api.addComment(step.serverId, item.stepId, item.text ?? "", item.uid);
          // The account has it: it leaves the outbox and joins the mirror, together.
          await store.apply({ putComments: [mirrorComment(localId, saved)], outbox: [{ ...version, then: "delete" }] });
        } else {
          // A sign-off without a verdict cannot be sent, and is never guessed.
          if (!item.status) throw new SyncError(400, "invalid_input");
          const saved = mirrorReview(localId, await api.setReview(step.serverId, item.stepId, item.status, item.note));
          // If the person signed off again while this was on its way, that
          // newer one was made on top of this one. It stays, and says so.
          await store.apply({ putReviews: [saved], outbox: [{ ...version, then: "delete", otherwise: { baseAt: saved.timestamp } }] });
        }
      } catch (e) {
        const err = e instanceof SyncError ? e : new SyncError(0, "storage_error");
        const verdict = classifyPushError(err);
        if (verdict === "reject") {
          await store.apply({ outbox: [{ ...version, then: { error: err.code, attempts: item.attempts + 1 } }] });
          continue;
        }
        // Only an answer from a server that was too busy counts as an attempt.
        // A request that never left does not, and neither does an account
        // that is refused: the item itself is untouched until it works again.
        if (verdict === "retry" && !isConnectivityError(err) && err.code !== "storage_error") {
          await store.apply({ outbox: [{ ...version, then: { attempts: item.attempts + 1 } }] }).catch(() => {});
        }
        throw err;
      }
    }
    return true;
  }

  async function pass(localId: string, gen: number, user: string, stamp: number | null | undefined): Promise<PassOutcome> {
    const link = mine(localId, user);
    const me = ports.session.me();
    if (!alive(gen) || !link || !me || me.id !== user) return "skipped";
    const serverId = link.serverId;
    /** False once the person changed, or the project stopped being theirs at that server copy. */
    const fresh = () => alive(gen) && mine(localId, user)?.serverId === serverId;
    lastPassAt.set(localId, ports.device.now());

    let before: CollabSyncState = { projectId: localId, pulledAt: null, stamp: null };
    try {
      // 1. Adopt what was written on this device before the project was in
      //    the account. Read, converted and stored as one step, so it happens
      //    once. A project this layer has touched also always has a record,
      //    so it can be found again if it later leaves the account.
      await store.transact(localId, (rows) => {
        if (!fresh()) return null;
        if (rows.state) before = rows.state;
        // What is already waiting is passed in: a sign-off made since the
        // project went into the account must not be overwritten by an older
        // one that was written on this device before.
        const adoption = planAdoption(rows.comments, rows.reviews, me, ports.newId, undefined, rows.outbox);
        const adopt = !isEmptyAdoption(adoption);
        if (rows.state && !adopt) return null;
        return {
          ...(rows.state ? {} : { putState: before }),
          ...(adopt ? { putOutbox: adoption.outbox, deleteComments: adoption.deleteCommentIds, deleteReviews: adoption.deleteReviewIds } : {}),
        };
      });
      if (!fresh()) return "skipped";

      // 2. The team's sign-offs. Read before uploading, so a sign-off made
      //    here is checked against what is there now.
      const teamReviews = await api.listReviews(serverId);
      await store.transact(localId, (rows) => {
        if (!fresh()) return null;
        const plan = planReviewPull(localId, rows.reviews, teamReviews);
        return plan.put.length + plan.removeIds.length > 0 ? { putReviews: plan.put, deleteReviews: plan.removeIds } : null;
      });
      if (!fresh()) return "skipped";

      // 3. Upload.
      if (!(await flush(localId, user, link, fresh))) return "skipped";

      // 4. The team's comments, which now include the ones just uploaded.
      const teamComments = await api.listComments(serverId);
      await store.transact(localId, (rows) => {
        if (!fresh()) return null;
        const plan = planCommentPull(localId, rows.comments, teamComments);
        return plan.add.length + plan.update.length + plan.removeIds.length > 0
          ? { putComments: plan.add, updateComments: plan.update, deleteComments: plan.removeIds }
          : null;
      });
      if (!fresh()) return "skipped";

      // The team itself, to show who wrote what. Not worth failing a pass for.
      let members = before.members;
      try {
        members = await api.listMembers(serverId);
      } catch {
        /* the last list is kept */
      }
      if (!fresh()) return "skipped";

      // 5. How far this device has read. The marker is the one the project
      //    list carried before this pass: anything written since, by this
      //    pass too, moves the account's marker on and is simply read again.
      await store.apply({
        putState: {
          projectId: localId,
          pulledAt: ports.device.now(),
          stamp: stamp !== undefined ? stamp : before.stamp,
          ...(members ? { members } : {}),
        },
      });
      return "synced";
    } catch (e) {
      if (!alive(gen)) return "skipped";
      const err = e instanceof SyncError ? e : new SyncError(0, "storage_error");
      if (isConnectivityError(err)) return "offline";
      // Kept for the screen: a suspended account is told why its comments wait.
      await store.apply({ putState: { ...before, error: err.code } }).catch(() => {});
      if (ACCOUNT_REFUSALS.includes(err.code)) ports.session.recheck();
      return "error";
    }
  }

  /** Ask for a pass of one project. Passes of a project run one after another; one that is still waiting serves every request made meanwhile. */
  function run(localId: string, stamp?: number | null): Promise<PassOutcome> {
    const user = activeUser;
    if (!user) return Promise.resolve("skipped");
    const gen = generation;

    const queued = waiting.get(localId);
    if (queued) {
      if (stamp !== undefined) queued.stamp = stamp;
      return queued.run;
    }

    const entry: { run: Promise<PassOutcome>; stamp?: number | null } = { run: Promise.resolve("skipped"), stamp };
    const previous = chains.get(localId) ?? Promise.resolve();
    entry.run = previous.then(() => {
      if (waiting.get(localId) === entry) waiting.delete(localId);
      return pass(localId, gen, user, entry.stamp).catch((): PassOutcome => "error");
    });
    waiting.set(localId, entry);
    chains.set(localId, entry.run);
    void entry.run.then(() => {
      if (chains.get(localId) === entry.run) chains.delete(localId);
    });
    return entry.run;
  }

  /**
   * Projects that left the account keep their discussion. A project this
   * layer has touched that is now kept on this device (its server copy went
   * away and sync kept a copy here) has the team's rows and the person's own
   * waiting ones turned into ordinary device rows.
   *
   * Only for a project that is positively marked as kept on this device. One
   * whose link merely cannot be read is left alone: turning a team's comments
   * into device rows of a project that is still in the account would upload
   * them again under this person's name.
   */
  async function localise(gen: number, user: string): Promise<void> {
    const [states, unsent] = await Promise.all([store.states(), store.outbox()]);
    const candidates = new Set([...states.map((s) => s.projectId), ...unsent.filter((o) => o.queuedBy === user).map((o) => o.projectId)]);
    const me = ports.session.me();
    const kept = (localId: string) => ports.links.get(localId)?.kind === "device";
    for (const localId of candidates) {
      // Read and converted as one step, so a waiting comment becomes one comment.
      await store.transact(localId, (rows) => {
        if (!alive(gen) || !kept(localId)) return null;
        const plan = planLocalise(rows.comments, rows.reviews, rows.outbox, me?.id === user ? me : null);
        if (isEmptyLocalise(plan) && !rows.state) return null;
        return {
          updateComments: plan.updateComments,
          putComments: plan.addComments,
          putReviews: plan.putReviews,
          outbox: plan.removeOutbox.map((o) => ({ uid: o.uid, queuedAt: o.queuedAt, then: "delete" as const })),
          deleteStates: [localId],
        };
      });
    }
  }

  /**
   * Waiting items of this person that sit on a copy another account has taken
   * over move to the person's own copy of the same project (`planRehome`).
   */
  async function rehome(gen: number, user: string): Promise<void> {
    const unsent = await store.outbox();
    for (const { item, to } of planRehome(unsent, ports.links.list(), user)) {
      if (!alive(gen)) return;
      const version = { uid: item.uid, queuedAt: item.queuedAt };
      if (item.kind === "comment") {
        await store.apply({ outbox: [{ ...version, then: { projectId: to } }] });
        continue;
      }
      // A sign-off is keyed by its project. One made on the person's own copy
      // since is their later word: it stays, and the older one goes.
      const uid = reviewOutboxUid(to, item.stepId, user);
      const later = unsent.some((o) => o.uid === uid);
      await store.apply({ ...(later ? {} : { putOutbox: [{ ...item, uid, projectId: to }] }), outbox: [{ ...version, then: "delete" }] });
    }
  }

  /**
   * Run at the end of every project sync, with the signed-in person's project
   * list as just read. Syncs the discussion of each project that needs it: it
   * has something to upload, it is the one on screen, or the account's marker
   * for it has moved. Never rejects.
   */
  async function reconcile(listed: readonly { id: string; collab_updated_at: number | null }[]): Promise<void> {
    const user = activeUser;
    if (!user) return;
    const gen = generation;
    try {
      await localise(gen, user);
      if (!alive(gen)) return;
      await rehome(gen, user);
      if (!alive(gen)) return;

      const stampOf = new Map(listed.map((p) => [p.id, p.collab_updated_at]));
      const targets: { localId: string; stamp: number | null }[] = [];
      for (const [localId, link] of ports.links.list()) {
        if (link.kind !== "account" || link.owner !== user || !link.created) continue;
        // Not in the list: the project is on its way out of the account.
        if (!stampOf.has(link.serverId)) continue;
        targets.push({ localId, stamp: stampOf.get(link.serverId) ?? null });
      }
      if (targets.length === 0) return;

      const [unsent, local, states] = await Promise.all([
        store.outbox(),
        store.withLocalRows(targets.map((t) => t.localId)),
        store.states(),
      ]);
      if (!alive(gen)) return;
      const hasUnsent = new Set(unsent.filter((o) => o.queuedBy === user && !o.error).map((o) => o.projectId));
      const hasLocal = new Set(local);
      const seen = new Map(states.map((s) => [s.projectId, s.stamp]));
      const open = ports.editor.currentId();

      for (const t of targets) {
        if (!alive(gen)) return;
        const due = shouldPull({
          hasUnsent: hasUnsent.has(t.localId),
          hasLocal: hasLocal.has(t.localId),
          isActive: t.localId === open,
          serverStamp: t.stamp,
          seenStamp: seen.get(t.localId) ?? null,
        });
        if (!due) continue;
        // The rest would fail the same way.
        if ((await run(t.localId, t.stamp)) === "offline") return;
      }
    } catch {
      /* this device's storage could not be read: tried again at the next sync */
    }
  }

  /**
   * Sync one project's discussion now: after the person wrote something, or
   * asked to look for new comments. Does nothing while stopped, while the
   * device is offline, or for a project that is not in the signed-in account.
   * Never rejects.
   */
  function request(localId: string): Promise<void> {
    const user = activeUser;
    if (!user || !ports.device.online()) return Promise.resolve();
    return run(localId).then(
      () => undefined,
      () => undefined,
    );
  }

  /** Start for a signed-in person. From then on the project on screen is kept fresh. */
  function start(user: string): void {
    if (activeUser === user) return;
    stop();
    generation += 1;
    activeUser = user;

    /** The open project, once it is known to be in this account. */
    let shown: string | null = null;
    const look = () => {
      const id = ports.editor.currentId();
      if (id === null || !mine(id, user)) {
        shown = null;
        return;
      }
      // Only when another project comes on screen, or the open one has just
      // gone into the account. Not on every later change of its link.
      if (shown === id) return;
      shown = id;
      if (ports.device.online() && isDue(ports.device.now(), lastPassAt.get(id), OPEN_SYNC_MS)) void run(id);
    };
    detachers = [ports.editor.subscribe(look), ports.links.subscribe(look)];
  }

  /** Stop. Nothing on the device is removed: what is waiting goes up the next time its author signs in. */
  function stop(): void {
    if (activeUser === null) return;
    generation += 1;
    activeUser = null;
    for (const off of detachers) off();
    detachers = [];
    waiting.clear();
    lastPassAt.clear();
  }

  return { reconcile, request, start, stop };
}

// --- The app's own engine ------------------------------------------------------------------

const tables = [db.comments, db.reviews, db.outbox, db.collabSync];

/** Carry out a change. Runs inside a transaction over `tables`. */
async function write(change: CollabChange): Promise<void> {
  for (const row of change.putComments ?? []) {
    const held = row.uid ? await db.comments.where("uid").equals(row.uid).first() : undefined;
    if (held?.id !== undefined && held.projectId === row.projectId) {
      await db.comments.put({ ...row, id: held.id });
      continue;
    }
    if (held?.id !== undefined) {
      // Another copy of the same server project on this device has it.
      // `uid` is unique, so it moves, and that copy reads its own again.
      await db.comments.delete(held.id);
      await db.collabSync.where("projectId").equals(held.projectId).modify({ pulledAt: null, stamp: null });
    }
    await db.comments.add(row);
  }
  for (const { id, changes } of change.updateComments ?? []) await db.comments.update(id, changes);
  if (change.deleteComments?.length) await db.comments.bulkDelete(change.deleteComments);
  if (change.putReviews?.length) await db.reviews.bulkPut(change.putReviews);
  if (change.deleteReviews?.length) await db.reviews.bulkDelete(change.deleteReviews);
  if (change.putOutbox?.length) await db.outbox.bulkPut(change.putOutbox);
  for (const op of change.outbox ?? []) {
    const item = await db.outbox.get(op.uid);
    if (!item) continue;
    if (item.queuedAt !== op.queuedAt) {
      if (op.otherwise) await db.outbox.update(op.uid, op.otherwise);
    } else if (op.then === "delete") {
      await db.outbox.delete(op.uid);
    } else {
      await db.outbox.update(op.uid, op.then);
    }
  }
  if (change.putState) await db.collabSync.put(change.putState);
  if (change.deleteStates?.length) await db.collabSync.bulkDelete(change.deleteStates);
}

/** Comments and sign-offs in Dexie. */
export const dexieCollabStore: CollabStore = {
  reviews: (projectId) => db.reviews.where("projectId").equals(projectId).toArray(),
  outbox: (projectId) => (projectId === undefined ? db.outbox.toArray() : db.outbox.where("projectId").equals(projectId).toArray()),
  states: () => db.collabSync.toArray(),

  async withLocalRows(projectIds) {
    const found = new Set<string>();
    if (projectIds.length === 0) return [];
    const ids = [...projectIds];
    await db.comments
      .where("projectId")
      .anyOf(ids)
      .each((c) => {
        if (c.origin !== "server") found.add(c.projectId);
      });
    await db.reviews
      .where("projectId")
      .anyOf(ids)
      .each((r) => {
        if (r.origin !== "server") found.add(r.projectId);
      });
    return [...found];
  },

  apply: (change) => db.transaction("rw", tables, () => write(change)),

  transact: (projectId, decide) =>
    db.transaction("rw", tables, async () => {
      const change = decide({
        comments: await db.comments.where("projectId").equals(projectId).toArray(),
        reviews: await db.reviews.where("projectId").equals(projectId).toArray(),
        outbox: await db.outbox.where("projectId").equals(projectId).toArray(),
        state: await db.collabSync.get(projectId),
      });
      if (change) await write(change);
    }),
};

const engine = createCollabSync({
  api: createCollabApi(callRpc),
  store: dexieCollabStore,
  links: { get: getLink, list: listLinks, subscribe: subscribeLinks },
  session: {
    me: () => {
      const s = useSession.getState();
      return s.phase === "ready" && s.profile ? { id: s.profile.id, name: accountName(s.profile) } : null;
    },
    recheck: () => {
      void useSession
        .getState()
        .refreshProfile()
        .catch(() => {});
    },
  },
  editor: {
    currentId: () => useProject.getState().project?.id ?? null,
    subscribe: (listener) =>
      useProject.subscribe((state, prev) => {
        if (state.project?.id !== prev.project?.id) listener();
      }),
  },
  device: {
    online: () => typeof navigator === "undefined" || navigator.onLine !== false,
    now: () => Date.now(),
  },
  newId: uuidV4,
});

/** See `createCollabSync`. Called by `project-sync.ts` at the end of every sync. */
export const reconcileCollab = engine.reconcile;
/** Sync one project's discussion now. A no-op while nobody is signed in. Never rejects. */
export const requestCollabSync = engine.request;
/** Called by `project-sync.ts` when sync starts for a person, and when it stops. */
export const startCollabSync = engine.start;
export const stopCollabSync = engine.stop;

/** How the discussion of a project works for whoever is looking at it now. See `CollabMode`. */
export function useCollabMode(projectId: string): CollabMode {
  const link = useLink(projectId);
  const phase = useSession((s) => s.phase);
  const profile = useSession((s) => s.profile);
  const deviceAccount = useSession((s) => s.deviceAccount);
  return useMemo(() => collabMode(link, { phase, profile, deviceAccount }), [link, phase, profile, deviceAccount]);
}
