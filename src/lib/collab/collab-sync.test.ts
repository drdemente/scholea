import { describe, expect, it } from "vitest";
import type { CollabMember, CollabSyncState, Comment, OutboxItem, Review } from "@/lib/db/schema";
import { SyncError } from "@/lib/supabase/errors";
import { OPEN_SYNC_MS, mirrorComment, mirrorReview, reviewKey, reviewOutboxUid, type Me, type ServerComment, type ServerReview } from "./collab-plan";
import { createCollabApi, createCollabSync, type CollabApi, type CollabChange, type CollabStore, type ProjectRows } from "./collab-sync";
import type { AccountLink, Link } from "./links";
import type { ProjectRole } from "./sync";

const ADA: Me = { id: "user-ada", name: "Ada Lovelace" };
const BOB: Me = { id: "user-bob", name: "Bob" };
/** A project on this device, and its copy in the account. */
const P = "proj-local";
const S = "proj_11111111-1111-4111-8111-111111111111";
const P2 = "proj-second";
const S2 = "proj_22222222-2222-4222-8222-222222222222";

const link = (over: Partial<AccountLink> = {}): AccountLink => ({ kind: "account", owner: ADA.id, serverId: S, rev: 1, created: true, role: "owner", ...over });
const offline = () => new SyncError(0, "network");

// --- A stand-in for the device's storage --------------------------------------------------
// It keeps the two promises the engine relies on: a change is applied whole or
// not at all, and a comment's account id (`uid`) is held by one row only.

function memoryStore() {
  let nextId = 1;
  let data = {
    comments: [] as Comment[],
    reviews: new Map<string, Review>(),
    outbox: new Map<string, OutboxItem>(),
    states: new Map<string, CollabSyncState>(),
  };
  const copy = <T>(v: T): T => structuredClone(v);
  /** Errors for the next calls of `apply`, in order. `null` lets one through. */
  const applyFailures: (Error | null)[] = [];
  const applied: CollabChange[] = [];
  /** The project of every read-decide-write step, in order. */
  const transacts: string[] = [];

  const rowsOf = (projectId: string): ProjectRows =>
    copy({
      comments: data.comments.filter((c) => c.projectId === projectId),
      reviews: [...data.reviews.values()].filter((r) => r.projectId === projectId),
      outbox: [...data.outbox.values()].filter((o) => o.projectId === projectId),
      state: data.states.get(projectId),
    });

  const store: CollabStore = {
    reviews: async (projectId) => rowsOf(projectId).reviews,
    outbox: async (projectId) => copy([...data.outbox.values()].filter((o) => projectId === undefined || o.projectId === projectId)),
    states: async () => copy([...data.states.values()]),
    // Read and written with nothing in between, as the real store does it.
    async transact(projectId, decide) {
      transacts.push(projectId);
      await Promise.resolve();
      const change = decide(rowsOf(projectId));
      if (change) await store.apply(change);
    },
    withLocalRows: async (projectIds) =>
      projectIds.filter(
        (id) =>
          data.comments.some((c) => c.projectId === id && c.origin !== "server") ||
          [...data.reviews.values()].some((r) => r.projectId === id && r.origin !== "server"),
      ),
    async apply(change) {
      const failure = applyFailures.shift();
      if (failure) throw failure;
      applied.push(copy(change));
      const next = copy(data);
      for (const row of change.putComments ?? []) {
        const held = row.uid ? next.comments.find((c) => c.uid === row.uid) : undefined;
        if (held && held.projectId === row.projectId) {
          Object.assign(held, { ...row, id: held.id });
          for (const key of Object.keys(held) as (keyof Comment)[]) if (!(key in row) && key !== "id") delete held[key];
          continue;
        }
        if (held) {
          next.comments = next.comments.filter((c) => c !== held);
          const state = next.states.get(held.projectId);
          if (state) next.states.set(held.projectId, { ...state, pulledAt: null, stamp: null });
        }
        next.comments.push({ ...row, id: nextId++ });
      }
      for (const { id, changes } of change.updateComments ?? []) {
        const row = next.comments.find((c) => c.id === id);
        if (!row) continue;
        for (const [key, value] of Object.entries(changes)) {
          if (value === undefined) delete (row as unknown as Record<string, unknown>)[key];
          else (row as unknown as Record<string, unknown>)[key] = value;
        }
      }
      next.comments = next.comments.filter((c) => !(change.deleteComments ?? []).includes(c.id as number));
      for (const r of change.putReviews ?? []) next.reviews.set(r.id, r);
      for (const id of change.deleteReviews ?? []) next.reviews.delete(id);
      for (const o of change.putOutbox ?? []) next.outbox.set(o.uid, o);
      for (const op of change.outbox ?? []) {
        const item = next.outbox.get(op.uid);
        if (!item) continue;
        if (item.queuedAt !== op.queuedAt) {
          if (op.otherwise) next.outbox.set(op.uid, { ...item, ...op.otherwise });
        } else if (op.then === "delete") {
          next.outbox.delete(op.uid);
        } else {
          next.outbox.set(op.uid, { ...item, ...op.then });
        }
      }
      if (change.putState) next.states.set(change.putState.projectId, change.putState);
      for (const id of change.deleteStates ?? []) next.states.delete(id);
      data = next;
    },
  };

  return {
    store,
    applyFailures,
    applied,
    transacts,
    /** Rows as stored, without the device's own row numbers. */
    comments: (projectId = P) => data.comments.filter((c) => c.projectId === projectId).map(({ id: _id, ...rest }) => rest),
    reviews: (projectId = P) => [...data.reviews.values()].filter((r) => r.projectId === projectId),
    outbox: () => [...data.outbox.values()],
    state: (projectId = P) => data.states.get(projectId),
    addComment(row: Comment) {
      data.comments.push({ ...row, id: nextId++ });
    },
    putReview(row: Review) {
      data.reviews.set(row.id, row);
    },
    queue(item: OutboxItem) {
      data.outbox.set(item.uid, item);
    },
    putState(state: CollabSyncState) {
      data.states.set(state.projectId, state);
    },
  };
}

// --- A stand-in for the backend, with the backend's rules -----------------------------------

function fakeBackend() {
  const s = {
    /** Whose session the calls are made with. */
    caller: ADA,
    /** That person's role on every project. */
    role: "owner" as ProjectRole,
    clock: 1_000_000,
    comments: new Map<string, ServerComment[]>(),
    reviews: new Map<string, ServerReview[]>(),
    members: [
      { id: ADA.id, name: ADA.name, email: "ada@example.test", role: "owner" },
      { id: BOB.id, name: BOB.name, email: "bob@example.test", role: "editor" },
    ] as CollabMember[],
    calls: [] as string[],
    /** Errors to throw instead of doing the call, per call name. */
    refuse: new Map<string, unknown[]>(),
    /** Errors to throw after the call did its work: the answer was lost. */
    lose: new Map<string, unknown[]>(),
    /** Calls that do not answer until released. See `hold`. */
    held: new Map<string, Promise<void>>(),
    onCall: null as null | ((name: string) => void),
  };
  /** Make the next calls of this name wait. Returns the release. */
  const hold = (name: string): (() => void) => {
    let release = () => {};
    s.held.set(name, new Promise<void>((resolve) => (release = resolve)));
    return () => {
      s.held.delete(name);
      release();
    };
  };
  const enter = (name: string, detail = "") => {
    s.calls.push(detail ? `${name} ${detail}` : name);
    s.onCall?.(name);
    const queue = s.refuse.get(name);
    if (queue?.length) throw queue.shift();
  };
  const leave = (name: string) => {
    const queue = s.lose.get(name);
    if (queue?.length) throw queue.shift();
  };
  const list = <T>(map: Map<string, T[]>, id: string): T[] => {
    if (!map.has(id)) map.set(id, []);
    return map.get(id) as T[];
  };

  const api: CollabApi = {
    async listComments(serverId) {
      enter("listComments");
      await s.held.get("listComments");
      return structuredClone(list(s.comments, serverId));
    },
    async addComment(serverId, stepId, text, id) {
      enter("addComment", id);
      const all = [...s.comments.values()].flat();
      const existing = all.find((c) => c.id === id);
      if (existing) {
        // The same id again: returned as it is when it is this person's comment in this project.
        if (existing.author_id !== s.caller.id || !list(s.comments, serverId).includes(existing)) throw new SyncError(409, "conflict");
        leave("addComment");
        return structuredClone(existing);
      }
      const comment: ServerComment = { id, step_id: stepId, author_id: s.caller.id, author_name: s.caller.name, text, created_at: (s.clock += 1000) };
      list(s.comments, serverId).push(comment);
      leave("addComment");
      return structuredClone(comment);
    },
    async listReviews(serverId) {
      enter("listReviews");
      await s.held.get("listReviews");
      return structuredClone(list(s.reviews, serverId));
    },
    async setReview(serverId, stepId, status, note) {
      enter("setReview", stepId);
      if (s.role !== "supervisor" && s.role !== "owner") throw new SyncError(403, "forbidden");
      const review: ServerReview = {
        step_id: stepId,
        status,
        reviewer_id: s.caller.id,
        reviewer_name: s.caller.name,
        note: note || null,
        created_at: (s.clock += 1000),
      };
      const reviews = list(s.reviews, serverId);
      const at = reviews.findIndex((r) => r.step_id === stepId);
      if (at >= 0) reviews[at] = review;
      else reviews.push(review);
      leave("setReview");
      return structuredClone(review);
    },
    async listMembers() {
      enter("listMembers");
      return structuredClone(s.members);
    },
  };
  return { api, server: s, hold };
}

function harness(start: Me | null = ADA) {
  const mem = memoryStore();
  const { api, server, hold } = fakeBackend();
  const links = new Map<string, Link>([[P, link()]]);
  const linkListeners = new Set<() => void>();
  const editorListeners = new Set<() => void>();
  const dev = { online: true, now: 5_000_000, open: null as string | null, me: start as Me | null, rechecks: 0, ids: 0 };

  const engine = createCollabSync({
    api,
    store: mem.store,
    links: {
      get: (id) => links.get(id) ?? null,
      list: () => links,
      subscribe: (listener) => {
        linkListeners.add(listener);
        return () => linkListeners.delete(listener);
      },
    },
    session: { me: () => dev.me, recheck: () => void (dev.rechecks += 1) },
    editor: {
      currentId: () => dev.open,
      subscribe: (listener) => {
        editorListeners.add(listener);
        return () => editorListeners.delete(listener);
      },
    },
    device: { online: () => dev.online, now: () => dev.now },
    newId: () => `uuid-${++dev.ids}`,
  });
  if (start) engine.start(start.id);

  return {
    engine,
    mem,
    server,
    hold,
    dev,
    links,
    /** How many listeners the engine has left on the links and on the open project. */
    listening: () => linkListeners.size + editorListeners.size,
    setLink(id: string, value: Link | null) {
      if (value) links.set(id, value);
      else links.delete(id);
      for (const l of [...linkListeners]) l();
    },
    open(id: string | null) {
      dev.open = id;
      for (const l of [...editorListeners]) l();
    },
    /** Sign in as someone else on the same device. */
    switchTo(me: Me | null) {
      engine.stop();
      dev.me = me;
      server.caller = me ?? server.caller;
      if (me) engine.start(me.id);
    },
    /** The project list a sync has just read. */
    listed: (...rows: [string, number | null][]) => rows.map(([id, collab_updated_at]) => ({ id, collab_updated_at })),
    /** Wait for passes that were started without being awaited. */
    settle: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  };
}

const teamComment = (id: string, over: Partial<ServerComment> = {}): ServerComment => ({
  id,
  step_id: "step-1",
  author_id: BOB.id,
  author_name: "Bob",
  text: `text of ${id}`,
  created_at: 900_000,
  ...over,
});

const teamReview = (step: string, over: Partial<ServerReview> = {}): ServerReview => ({
  step_id: step,
  status: "approved",
  reviewer_id: BOB.id,
  reviewer_name: "Bob",
  note: null,
  created_at: 950_000,
  ...over,
});

const waitingComment = (uid: string, over: Partial<OutboxItem> = {}): OutboxItem => ({
  uid,
  kind: "comment",
  projectId: P,
  stepId: "step-1",
  queuedBy: ADA.id,
  queuedAt: 100,
  text: `unsent ${uid}`,
  attempts: 0,
  ...over,
});

const waitingReview = (over: Partial<OutboxItem> = {}): OutboxItem => ({
  uid: reviewOutboxUid(P, "step-1", ADA.id),
  kind: "review",
  projectId: P,
  stepId: "step-1",
  queuedBy: ADA.id,
  queuedAt: 100,
  status: "approved",
  baseAt: null,
  attempts: 0,
  ...over,
});

describe("one pass", () => {
  it("brings a collaborator's comment and sign-off to this device", async () => {
    const h = harness();
    h.server.comments.set(S, [teamComment("c1")]);
    h.server.reviews.set(S, [teamReview("step-2", { note: "fine" })]);
    await h.engine.request(P);

    expect(h.mem.comments()).toEqual([mirrorComment(P, teamComment("c1"))]);
    expect(h.mem.reviews()).toEqual([mirrorReview(P, teamReview("step-2", { note: "fine" }))]);
    expect(h.mem.state()).toEqual({ projectId: P, pulledAt: 5_000_000, stamp: null, members: h.server.members });
  });

  it("reads sign-offs, uploads, then reads comments, in that order", async () => {
    const h = harness();
    h.mem.queue(waitingComment("u1"));
    await h.engine.request(P);
    expect(h.server.calls).toEqual(["listReviews", "addComment u1", "listComments", "listMembers"]);
  });

  it("uploads a waiting comment once, however often it runs", async () => {
    const h = harness();
    h.mem.queue(waitingComment("u1"));
    await h.engine.request(P);
    await h.engine.request(P);

    expect(h.server.calls.filter((c) => c.startsWith("addComment"))).toEqual(["addComment u1"]);
    expect(h.server.comments.get(S)).toHaveLength(1);
    expect(h.mem.outbox()).toEqual([]);
    // The account's name and time, not this device's.
    expect(h.mem.comments()).toEqual([
      { projectId: P, stepId: "step-1", author: "Ada Lovelace", text: "unsent u1", timestamp: 1_001_000, origin: "server", uid: "u1", authorId: ADA.id },
    ]);
  });

  it("does not post a comment twice when the answer to its upload was lost", async () => {
    const h = harness();
    h.mem.queue(waitingComment("u1"));
    h.server.lose.set("addComment", [offline()]);
    await h.engine.request(P);
    // It landed, but this device does not know: it is still waiting.
    expect(h.server.comments.get(S)).toHaveLength(1);
    expect(h.mem.outbox().map((o) => [o.uid, o.attempts, o.error])).toEqual([["u1", 0, undefined]]);
    expect(h.mem.comments()).toEqual([]);

    await h.engine.request(P);
    expect(h.server.calls.filter((c) => c.startsWith("addComment"))).toEqual(["addComment u1", "addComment u1"]);
    expect(h.server.comments.get(S)).toHaveLength(1);
    expect(h.mem.outbox()).toEqual([]);
    expect(h.mem.comments().map((c) => c.uid)).toEqual(["u1"]);
  });

  it("keeps one copy when the comment was read back before its upload was acknowledged", async () => {
    const h = harness();
    // The upload landed earlier and another pass already mirrored it.
    h.server.comments.set(S, [teamComment("u1", { author_id: ADA.id, author_name: "Ada Lovelace", text: "unsent u1" })]);
    h.mem.addComment(mirrorComment(P, teamComment("u1", { author_id: ADA.id, author_name: "Ada Lovelace", text: "unsent u1" })));
    h.mem.queue(waitingComment("u1"));
    await h.engine.request(P);
    expect(h.mem.comments().map((c) => c.uid)).toEqual(["u1"]);
    expect(h.mem.outbox()).toEqual([]);
    expect(h.server.comments.get(S)).toHaveLength(1);
  });

  it("uploads in the order things were written", async () => {
    const h = harness();
    h.mem.queue(waitingComment("u2", { queuedAt: 20 }));
    h.mem.queue(waitingComment("u1", { queuedAt: 10 }));
    h.mem.queue(waitingComment("u3", { queuedAt: 30 }));
    await h.engine.request(P);
    expect(h.server.comments.get(S)?.map((c) => c.id)).toEqual(["u1", "u2", "u3"]);
    expect(h.mem.comments().map((c) => c.uid)).toEqual(["u1", "u2", "u3"]);
  });

  it("uploads a supervisor's sign-off and mirrors what the account stamped", async () => {
    const h = harness();
    h.mem.queue(waitingReview({ note: "good" }));
    await h.engine.request(P);
    expect(h.server.reviews.get(S)).toEqual([
      { step_id: "step-1", status: "approved", reviewer_id: ADA.id, reviewer_name: "Ada Lovelace", note: "good", created_at: 1_001_000 },
    ]);
    expect(h.mem.outbox()).toEqual([]);
    expect(h.mem.reviews()).toEqual([
      { id: reviewKey(P, "step-1"), projectId: P, stepId: "step-1", status: "approved", reviewer: "Ada Lovelace", note: "good", timestamp: 1_001_000, origin: "server", reviewerId: ADA.id },
    ]);
  });

  it("marks an editor's sign-off as refused, and does not send it again", async () => {
    const h = harness();
    h.server.role = "editor";
    h.setLink(P, link({ role: "editor" }));
    h.mem.queue(waitingReview());
    await h.engine.request(P);
    expect(h.mem.outbox()).toEqual([waitingReview({ error: "forbidden", attempts: 1 })]);
    expect(h.server.reviews.get(S)).toEqual([]);

    await h.engine.request(P);
    expect(h.server.calls.filter((c) => c.startsWith("setReview"))).toHaveLength(1);
    // The rest of the pass still ran.
    expect(h.mem.state()?.pulledAt).toBe(5_000_000);
    expect(h.mem.state()?.error).toBeUndefined();
  });

  it("holds back a sign-off made offline when someone else has signed the step off since", async () => {
    const h = harness();
    h.mem.putReview(mirrorReview(P, teamReview("step-1", { created_at: 900_000 })));
    h.mem.queue(waitingReview({ status: "approved", baseAt: 900_000 }));
    h.server.reviews.set(S, [teamReview("step-1", { status: "changes", created_at: 990_000 })]);
    await h.engine.request(P);

    expect(h.server.calls.filter((c) => c.startsWith("setReview"))).toEqual([]);
    expect(h.mem.outbox()).toEqual([waitingReview({ status: "approved", baseAt: 900_000, error: "superseded" })]);
    // The other person's sign-off stands, here and in the account.
    expect(h.mem.reviews().map((r) => [r.status, r.reviewer, r.timestamp])).toEqual([["changes", "Bob", 990_000]]);
    expect(h.server.reviews.get(S)?.[0].status).toBe("changes");
  });

  it("sends a sign-off made on top of the one that is still there", async () => {
    const h = harness();
    h.server.reviews.set(S, [teamReview("step-1", { created_at: 900_000 })]);
    h.mem.queue(waitingReview({ status: "changes", baseAt: 900_000 }));
    await h.engine.request(P);
    expect(h.server.reviews.get(S)?.[0]).toMatchObject({ status: "changes", reviewer_id: ADA.id });
    expect(h.mem.outbox()).toEqual([]);
  });

  it("drops a waiting sign-off the account already has (the answer to its upload was lost)", async () => {
    const h = harness();
    h.mem.queue(waitingReview({ note: "good" }));
    h.server.lose.set("setReview", [offline()]);
    await h.engine.request(P);
    expect(h.mem.outbox()).toHaveLength(1);

    await h.engine.request(P);
    expect(h.server.calls.filter((c) => c.startsWith("setReview"))).toHaveLength(1);
    expect(h.mem.outbox()).toEqual([]);
    expect(h.mem.reviews().map((r) => [r.status, r.reviewer, r.note])).toEqual([["approved", "Ada Lovelace", "good"]]);
  });

  it("keeps a sign-off that was made again while the first was on its way, and sends it next", async () => {
    const h = harness();
    h.mem.queue(waitingReview({ status: "approved", queuedAt: 100 }));
    h.server.onCall = (name) => {
      if (name !== "setReview") return;
      h.server.onCall = null;
      // The person changes their mind before the first upload is answered.
      h.mem.queue(waitingReview({ status: "changes", queuedAt: 101, baseAt: null }));
    };
    await h.engine.request(P);
    // The second one was made on top of the first, which the account now has.
    expect(h.mem.outbox()).toEqual([waitingReview({ status: "changes", queuedAt: 101, baseAt: 1_001_000 })]);

    await h.engine.request(P);
    expect(h.server.reviews.get(S)?.[0].status).toBe("changes");
    expect(h.mem.outbox()).toEqual([]);
  });

  it("never guesses the verdict of a sign-off that lost it", async () => {
    const h = harness();
    h.mem.queue(waitingReview({ status: undefined }));
    await h.engine.request(P);
    expect(h.server.calls.filter((c) => c.startsWith("setReview"))).toEqual([]);
    expect(h.mem.outbox()[0]).toMatchObject({ error: "invalid_input" });
  });

  it("marks a comment the account will not take as refused and goes on with the rest", async () => {
    const h = harness();
    h.mem.queue(waitingComment("u1", { queuedAt: 10 }));
    h.mem.queue(waitingComment("u2", { queuedAt: 20 }));
    h.server.refuse.set("addComment", [new SyncError(400, "invalid_input")]);
    await h.engine.request(P);
    expect(h.mem.outbox()).toEqual([waitingComment("u1", { queuedAt: 10, error: "invalid_input", attempts: 1 })]);
    expect(h.server.comments.get(S)?.map((c) => c.id)).toEqual(["u2"]);
    expect(h.mem.state()?.pulledAt).toBe(5_000_000);
  });

  it("stops uploading at a busy server, so the order is kept, and counts the attempt", async () => {
    const h = harness();
    h.mem.queue(waitingComment("u1", { queuedAt: 10 }));
    h.mem.queue(waitingComment("u2", { queuedAt: 20 }));
    h.server.refuse.set("addComment", [new SyncError(503, "server_error")]);
    await h.engine.request(P);
    expect(h.server.calls.filter((c) => c.startsWith("addComment"))).toEqual(["addComment u1"]);
    expect(h.mem.outbox().map((o) => [o.uid, o.attempts, o.error])).toEqual([
      ["u1", 1, undefined],
      ["u2", 0, undefined],
    ]);
    expect(h.mem.state()).toMatchObject({ pulledAt: null, error: "server_error" });

    await h.engine.request(P);
    expect(h.server.comments.get(S)?.map((c) => c.id)).toEqual(["u1", "u2"]);
    expect(h.mem.state()).toEqual({ projectId: P, pulledAt: 5_000_000, stamp: null, members: h.server.members });
  });

  it("leaves everything as it is when the connection drops, without counting an attempt or recording an error", async () => {
    const h = harness();
    h.mem.queue(waitingComment("u1"));
    h.server.refuse.set("addComment", [offline()]);
    await h.engine.request(P);
    expect(h.mem.outbox()).toEqual([waitingComment("u1")]);
    expect(h.mem.state()).toEqual({ projectId: P, pulledAt: null, stamp: null });
    expect(h.dev.rechecks).toBe(0);
  });

  it("holds comments while the account is suspended, says why, and asks the session to look again", async () => {
    const h = harness();
    h.mem.putState({ projectId: P, pulledAt: 123, stamp: 7 });
    h.mem.queue(waitingComment("u1"));
    h.server.refuse.set("listReviews", [new SyncError(403, "account_suspended")]);
    await h.engine.request(P);
    expect(h.mem.outbox()).toEqual([waitingComment("u1")]);
    expect(h.mem.state()).toEqual({ projectId: P, pulledAt: 123, stamp: 7, error: "account_suspended" });
    expect(h.dev.rechecks).toBe(1);
    expect(h.server.calls).toEqual(["listReviews"]);
  });

  it("holds a comment, unmarked, when the account is refused at the moment of upload", async () => {
    const h = harness();
    h.mem.queue(waitingComment("u1"));
    h.server.refuse.set("addComment", [new SyncError(401, "unauthenticated")]);
    await h.engine.request(P);
    // Exactly as it was: nothing about the comment itself is wrong.
    expect(h.mem.outbox()).toEqual([waitingComment("u1")]);
    expect(h.mem.state()?.error).toBe("unauthenticated");
    expect(h.dev.rechecks).toBe(1);
  });

  it("clears a recorded error once a pass gets through", async () => {
    const h = harness();
    h.mem.putState({ projectId: P, pulledAt: 123, stamp: 7, error: "account_suspended" });
    await h.engine.request(P);
    expect(h.mem.state()).toEqual({ projectId: P, pulledAt: 5_000_000, stamp: 7, members: h.server.members });
  });

  it("removes from this device a comment that is gone from the account, and nothing written here", async () => {
    const h = harness();
    h.mem.addComment(mirrorComment(P, teamComment("gone")));
    h.mem.addComment(mirrorComment(P, teamComment("c1")));
    h.server.comments.set(S, [teamComment("c1", { author_name: "Robert" })]);
    await h.engine.request(P);
    expect(h.mem.comments()).toEqual([mirrorComment(P, teamComment("c1", { author_name: "Robert" }))]);
  });

  it("removes a comment that is gone from the account when that is the only change", async () => {
    const h = harness();
    h.mem.addComment(mirrorComment(P, teamComment("gone")));
    h.mem.addComment(mirrorComment(P, teamComment("c1")));
    h.server.comments.set(S, [teamComment("c1")]);
    await h.engine.request(P);
    expect(h.mem.comments().map((c) => c.uid)).toEqual(["c1"]);
  });

  it("takes over a changed name when that is the only change", async () => {
    const h = harness();
    h.mem.addComment(mirrorComment(P, teamComment("c1")));
    h.server.comments.set(S, [teamComment("c1", { author_name: "Robert" })]);
    await h.engine.request(P);
    expect(h.mem.comments().map((c) => [c.uid, c.author])).toEqual([["c1", "Robert"]]);
  });

  it("removes from this device a sign-off that is gone from the account", async () => {
    const h = harness();
    h.mem.putReview(mirrorReview(P, teamReview("step-1")));
    h.mem.putReview(mirrorReview(P, teamReview("step-2")));
    h.server.reviews.set(S, [teamReview("step-2")]);
    await h.engine.request(P);
    expect(h.mem.reviews().map((r) => r.stepId)).toEqual(["step-2"]);
  });

  it("writes nothing when the team's side has not changed, except how fresh it is", async () => {
    const h = harness();
    h.server.comments.set(S, [teamComment("c1")]);
    h.server.reviews.set(S, [teamReview("step-1")]);
    await h.engine.request(P);
    const writes = h.mem.applied.length;
    h.dev.now += 1000;
    await h.engine.request(P);
    expect(h.mem.applied.slice(writes)).toEqual([{ putState: { projectId: P, pulledAt: 5_001_000, stamp: null, members: h.server.members } }]);
  });

  it("keeps the last team list when the team cannot be read, and still finishes", async () => {
    const h = harness();
    const before: CollabMember[] = [{ id: "old", name: "Old", email: "old@example.test", role: "viewer" }];
    h.mem.putState({ projectId: P, pulledAt: 1, stamp: 2, members: before });
    h.server.refuse.set("listMembers", [new SyncError(500, "server_error")]);
    await h.engine.request(P);
    expect(h.mem.state()).toEqual({ projectId: P, pulledAt: 5_000_000, stamp: 2, members: before });
  });

  it("records that it touched the project before it writes anything else", async () => {
    const h = harness();
    h.server.refuse.set("listReviews", [offline()]);
    await h.engine.request(P);
    expect(h.mem.applied[0]).toEqual({ putState: { projectId: P, pulledAt: null, stamp: null } });
  });

  it("reports a storage failure as an error and tries again later", async () => {
    const h = harness();
    h.server.comments.set(S, [teamComment("c1")]);
    h.mem.putState({ projectId: P, pulledAt: 1, stamp: 2 });
    // Reading the reviews into the mirror is the first write of this pass. It fails.
    h.mem.applyFailures.push(new Error("QuotaExceededError"));
    await h.engine.request(P);
    expect(h.mem.state()).toEqual({ projectId: P, pulledAt: 1, stamp: 2, error: "storage_error" });
    expect(h.mem.comments()).toEqual([]);

    await h.engine.request(P);
    expect(h.mem.comments()).toHaveLength(1);
    expect(h.mem.state()?.error).toBeUndefined();
  });
});

describe("taking a device project into the account", () => {
  const local = (id: number, over: Partial<Comment> = {}): Comment => ({
    projectId: P,
    stepId: "step-1",
    author: "Ada Lovelace",
    role: "researcher",
    text: `local ${id}`,
    timestamp: 100 * id,
    origin: "local",
    ...over,
  });

  it("keeps the newer waiting sign-off when a sign-off written on this device is taken into the account", async () => {
    const h = harness();
    // Approved while the project was kept on this device, under the name chosen here.
    h.mem.putReview({ id: reviewKey(P, "step-1"), projectId: P, stepId: "step-1", status: "approved", reviewer: "Dr Khan", timestamp: 300, origin: "local" });
    // The project went into the account, and offline, before any discussion sync ran,
    // the owner changed the verdict on that step. It is waiting to upload.
    h.mem.queue({
      uid: reviewOutboxUid(P, "step-1", ADA.id),
      kind: "review",
      projectId: P,
      stepId: "step-1",
      queuedBy: ADA.id,
      queuedAt: 900,
      status: "changes",
      note: "the search must be rerun",
      baseAt: null,
      attempts: 0,
    });

    await h.engine.request(P);

    expect(h.server.calls.filter((c) => c.startsWith("setReview"))).toHaveLength(1);
    expect(h.server.reviews.get(S)).toMatchObject([{ step_id: "step-1", status: "changes", note: "the search must be rerun", reviewer_id: ADA.id }]);
    expect(h.mem.outbox()).toEqual([]);
    expect(h.mem.reviews()).toMatchObject([{ status: "changes", note: "the search must be rerun", origin: "server" }]);
  });

  it("uploads what was written on this device once, in order, under the account", async () => {
    const h = harness();
    h.mem.addComment(local(2));
    h.mem.addComment(local(1));
    h.mem.putReview({ id: reviewKey(P, "step-1"), projectId: P, stepId: "step-1", status: "approved", reviewer: "Ada Lovelace", timestamp: 300, origin: "local" });

    await h.engine.request(P);
    await h.engine.request(P);

    // Read, converted and stored as one step: the change that queues the uploads removes the device rows.
    expect(h.mem.transacts[0]).toBe(P);
    const adoption = h.mem.applied.filter((c) => c.putOutbox);
    expect(adoption).toHaveLength(1);
    expect(adoption[0].putOutbox).toHaveLength(3);
    expect(adoption[0].deleteComments).toHaveLength(2);
    expect(adoption[0].deleteReviews).toEqual([reviewKey(P, "step-1")]);
    expect(adoption[0].putState).toEqual({ projectId: P, pulledAt: null, stamp: null });

    expect(h.server.comments.get(S)?.map((c) => [c.text, c.author_name])).toEqual([
      ["local 1", "Ada Lovelace"],
      ["local 2", "Ada Lovelace"],
    ]);
    expect(h.server.reviews.get(S)?.map((r) => [r.step_id, r.status, r.reviewer_id])).toEqual([["step-1", "approved", ADA.id]]);
    expect(h.server.calls.filter((c) => c.startsWith("addComment"))).toHaveLength(2);
    expect(h.server.calls.filter((c) => c.startsWith("setReview"))).toHaveLength(1);
    expect(h.mem.outbox()).toEqual([]);
    // What is left on the device is the account's copy, and only that.
    expect(h.mem.comments().map((c) => [c.text, c.origin])).toEqual([
      ["local 1", "server"],
      ["local 2", "server"],
    ]);
    expect(h.mem.reviews().map((r) => r.origin)).toEqual(["server"]);
  });

  it("converts the rows and queues the uploads together, so a failure in between loses nothing", async () => {
    const h = harness();
    h.mem.addComment(local(1));
    h.server.refuse.set("listReviews", [offline()]);
    await h.engine.request(P);
    // Offline right after converting: the comment is waiting, not gone, and not doubled.
    expect(h.mem.comments()).toEqual([]);
    expect(h.mem.outbox().map((o) => [o.uid, o.text, o.queuedBy])).toEqual([["uuid-1", "local 1", ADA.id]]);

    await h.engine.request(P);
    expect(h.server.comments.get(S)?.map((c) => c.id)).toEqual(["uuid-1"]);
  });

  it("says where a comment came from when it was typed under another name", async () => {
    const h = harness();
    h.mem.addComment(local(1, { author: "Dr Khan" }));
    await h.engine.request(P);
    expect(h.server.comments.get(S)?.[0].text).toMatch(/^\[Written on this device as "Dr Khan" on .+\] local 1$/);
    expect(h.server.comments.get(S)?.[0].author_id).toBe(ADA.id);
  });

  it("leaves the device rows alone when their conversion cannot be stored", async () => {
    const h = harness();
    h.mem.addComment(local(1));
    h.mem.putState({ projectId: P, pulledAt: null, stamp: null });
    h.mem.applyFailures.push(new Error("storage"));
    await h.engine.request(P);
    expect(h.mem.comments().map((c) => c.origin)).toEqual(["local"]);
    expect(h.mem.outbox()).toEqual([]);
    expect(h.server.calls).toEqual([]);
  });
});

describe("who it runs for", () => {
  it("does nothing while nobody is signed in", async () => {
    const h = harness(null);
    h.mem.queue(waitingComment("u1"));
    await h.engine.request(P);
    await h.engine.reconcile(h.listed([S, 5]));
    expect(h.server.calls).toEqual([]);
    expect(h.mem.applied).toEqual([]);
  });

  it("never uploads what another account left waiting on the same device", async () => {
    const h = harness();
    h.mem.queue(waitingComment("u1"));
    // Ada signs out. Bob signs in and has taken over the copy of the shared project.
    h.switchTo(BOB);
    h.setLink(P, link({ owner: BOB.id, role: "editor" }));
    await h.engine.request(P);
    expect(h.server.calls.filter((c) => c.startsWith("addComment"))).toEqual([]);
    expect(h.mem.outbox()).toEqual([waitingComment("u1")]);

    // Ada signs back in: it goes up under her name.
    h.switchTo(ADA);
    h.setLink(P, link());
    await h.engine.request(P);
    expect(h.server.comments.get(S)?.map((c) => [c.id, c.author_id])).toEqual([["u1", ADA.id]]);
    expect(h.mem.outbox()).toEqual([]);
  });

  it("does nothing for a project of another account, one kept on this device, or one the server has not confirmed", async () => {
    const h = harness();
    for (const other of [link({ owner: BOB.id }), { kind: "device", asked: true } as Link, link({ created: false }), null]) {
      h.setLink(P, other);
      await h.engine.request(P);
    }
    await h.settle();
    expect(h.server.calls).toEqual([]);
  });

  it("does nothing while the device is offline", async () => {
    const h = harness();
    h.dev.online = false;
    await h.engine.request(P);
    expect(h.server.calls).toEqual([]);
  });

  it("gives up, without writing or uploading, when the person signs out part-way", async () => {
    const h = harness();
    h.server.comments.set(S, [teamComment("c1")]);
    h.server.reviews.set(S, [teamReview("step-1")]);
    h.mem.queue(waitingComment("u1"));
    h.server.onCall = (name) => {
      if (name === "listReviews") h.engine.stop();
    };
    await h.engine.request(P);
    expect(h.server.calls).toEqual(["listReviews"]);
    expect(h.mem.reviews()).toEqual([]);
    expect(h.mem.comments()).toEqual([]);
    expect(h.mem.outbox()).toEqual([waitingComment("u1")]);
  });

  it("writes nothing for a person who signed out before the pass got to the device's rows", async () => {
    const h = harness();
    h.mem.addComment({ projectId: P, stepId: "step-1", author: "Ada Lovelace", role: "researcher", text: "from before", timestamp: 5, origin: "local" });
    const real = h.mem.store.transact;
    h.mem.store.transact = async (id, decide) => {
      h.engine.stop();
      return real(id, decide);
    };
    await h.engine.request(P);
    expect(h.mem.applied).toEqual([]);
    expect(h.mem.comments().map((c) => c.origin)).toEqual(["local"]);
    expect(h.server.calls).toEqual([]);
  });

  it("does not write the team's comments for a person who signed out while they were being read", async () => {
    const h = harness();
    h.server.comments.set(S, [teamComment("c1")]);
    h.server.onCall = (name) => {
      if (name === "listComments") h.engine.stop();
    };
    await h.engine.request(P);
    expect(h.mem.comments()).toEqual([]);
    expect(h.server.calls).toEqual(["listReviews", "listComments"]);
    expect(h.mem.state()).toEqual({ projectId: P, pulledAt: null, stamp: null });
  });

  it("does not note a read as finished for a person who signed out at its very end", async () => {
    const h = harness();
    h.mem.putState({ projectId: P, pulledAt: 1, stamp: 2 });
    h.server.onCall = (name) => {
      if (name === "listMembers") h.engine.stop();
    };
    await h.engine.request(P);
    expect(h.mem.state()).toEqual({ projectId: P, pulledAt: 1, stamp: 2 });
  });

  it("records no error and asks nothing of the session when a pass fails after the person signed out", async () => {
    const h = harness();
    h.mem.putState({ projectId: P, pulledAt: 1, stamp: 2 });
    h.server.onCall = (name) => {
      if (name === "listReviews") h.engine.stop();
    };
    h.server.refuse.set("listReviews", [new SyncError(403, "account_suspended")]);
    await h.engine.request(P);
    expect(h.mem.state()).toEqual({ projectId: P, pulledAt: 1, stamp: 2 });
    expect(h.dev.rechecks).toBe(0);
  });

  it("asks the account nothing more once the person has signed out, even with nothing waiting", async () => {
    const h = harness();
    h.server.comments.set(S, [teamComment("c1")]);
    h.server.onCall = (name) => {
      if (name === "listReviews") h.engine.stop();
    };
    await h.engine.request(P);
    expect(h.server.calls).toEqual(["listReviews"]);
  });

  it("gives up when the project stops being this person's part-way", async () => {
    const h = harness();
    h.mem.queue(waitingComment("u1"));
    h.server.onCall = (name) => {
      if (name === "listReviews") h.links.set(P, { kind: "device", asked: true });
    };
    await h.engine.request(P);
    expect(h.server.calls).toEqual(["listReviews"]);
    expect(h.mem.outbox()).toEqual([waitingComment("u1")]);
  });

  it("still records an upload that finished after the person signed out", async () => {
    const h = harness();
    h.mem.queue(waitingComment("u1", { queuedAt: 10 }));
    h.mem.queue(waitingComment("u2", { queuedAt: 20 }));
    h.server.onCall = (name) => {
      if (name === "addComment") h.engine.stop();
    };
    await h.engine.request(P);
    // The first was already on its way and landed: it must not go up again later. The second never left.
    expect(h.server.comments.get(S)?.map((c) => c.id)).toEqual(["u1"]);
    expect(h.mem.outbox().map((o) => o.uid)).toEqual(["u2"]);
    expect(h.mem.comments().map((c) => c.uid)).toEqual(["u1"]);
    // And the pass ended there.
    expect(h.server.calls).toEqual(["listReviews", "addComment u1"]);
  });

  it("does not run for a session that is not the account sync was started for", async () => {
    const h = harness();
    h.dev.me = BOB;
    h.mem.queue(waitingComment("u1"));
    await h.engine.request(P);
    expect(h.server.calls).toEqual([]);
  });
});

describe("after every project sync", () => {
  it("syncs a project whose marker has moved and records the marker it was read up to", async () => {
    const h = harness();
    h.server.comments.set(S, [teamComment("c1")]);
    await h.engine.reconcile(h.listed([S, 42]));
    expect(h.mem.comments()).toHaveLength(1);
    expect(h.mem.state()).toMatchObject({ stamp: 42, pulledAt: 5_000_000 });
  });

  it("leaves a project alone when nothing is waiting, it is not on screen and its marker has not moved", async () => {
    const h = harness();
    h.mem.putState({ projectId: P, pulledAt: 1, stamp: 42 });
    await h.engine.reconcile(h.listed([S, 42]));
    expect(h.server.calls).toEqual([]);
  });

  it("leaves a project alone that has never had a comment or sign-off", async () => {
    const h = harness();
    await h.engine.reconcile(h.listed([S, null]));
    expect(h.server.calls).toEqual([]);
  });

  it("syncs the project on screen every time", async () => {
    const h = harness();
    h.mem.putState({ projectId: P, pulledAt: 1, stamp: 42 });
    h.dev.open = P;
    await h.engine.reconcile(h.listed([S, 42]));
    expect(h.server.calls).toContain("listComments");
  });

  it("syncs a project with something waiting, but not one whose only waiting item was refused", async () => {
    const h = harness();
    h.mem.putState({ projectId: P, pulledAt: 1, stamp: 42 });
    h.mem.queue(waitingComment("u1", { error: "forbidden" }));
    await h.engine.reconcile(h.listed([S, 42]));
    expect(h.server.calls).toEqual([]);

    h.mem.queue(waitingComment("u2"));
    await h.engine.reconcile(h.listed([S, 42]));
    expect(h.server.comments.get(S)?.map((c) => c.id)).toEqual(["u2"]);
  });

  it("syncs a project that has just gone into the account with comments written on this device", async () => {
    const h = harness();
    h.mem.addComment({ projectId: P, stepId: "step-1", author: "Ada Lovelace", role: "researcher", text: "from before", timestamp: 5, origin: "local" });
    await h.engine.reconcile(h.listed([S, null]));
    expect(h.server.comments.get(S)?.map((c) => c.text)).toEqual(["from before"]);
  });

  it("reads once more after uploading, because its own upload moved the marker", async () => {
    const h = harness();
    h.mem.queue(waitingComment("u1"));
    await h.engine.reconcile(h.listed([S, 42]));
    // The account's marker is now past 42. The next sync sees that and reads again; after that it rests.
    h.server.calls.length = 0;
    await h.engine.reconcile(h.listed([S, 43]));
    expect(h.server.calls).toEqual(["listReviews", "listComments", "listMembers"]);
    h.server.calls.length = 0;
    await h.engine.reconcile(h.listed([S, 43]));
    expect(h.server.calls).toEqual([]);
  });

  it("records that the account has no marker when a project sync says so", async () => {
    const h = harness();
    h.mem.putState({ projectId: P, pulledAt: 1, stamp: 42 });
    await h.engine.reconcile(h.listed([S, null]));
    expect(h.mem.state()).toMatchObject({ stamp: null, pulledAt: 5_000_000 });
  });

  it("keeps the marker it had when asked to sync outside a project sync", async () => {
    const h = harness();
    h.mem.putState({ projectId: P, pulledAt: 1, stamp: 42 });
    await h.engine.request(P);
    expect(h.mem.state()).toMatchObject({ stamp: 42, pulledAt: 5_000_000 });
  });

  it("skips projects that are not in the list, belong to another account, or are not confirmed", async () => {
    const h = harness();
    h.setLink("p-gone", link({ serverId: "proj_gone" }));
    h.setLink("p-bob", link({ owner: BOB.id, serverId: S2 }));
    h.setLink("p-new", link({ created: false, serverId: "proj_new" }));
    h.setLink("p-device", { kind: "device", asked: false });
    h.links.delete(P);
    await h.engine.reconcile(h.listed([S2, 9], ["proj_new", 9]));
    expect(h.server.calls).toEqual([]);
    // Not even when one of them is on screen or has something waiting.
    h.dev.open = "p-gone";
    h.mem.queue(waitingComment("u1", { projectId: "p-gone" }));
    await h.engine.reconcile(h.listed([S2, 9], ["proj_new", 9]));
    expect(h.server.calls).toEqual([]);
  });

  it("stops at the first project that cannot be reached", async () => {
    const h = harness();
    h.setLink(P2, link({ serverId: S2 }));
    h.server.refuse.set("listReviews", [offline()]);
    await h.engine.reconcile(h.listed([S, 1], [S2, 1]));
    expect(h.server.calls).toEqual(["listReviews"]);
  });

  it("goes on to the next project after one that failed for another reason", async () => {
    const h = harness();
    h.setLink(P2, link({ serverId: S2 }));
    h.server.refuse.set("listReviews", [new SyncError(404, "not_found")]);
    await h.engine.reconcile(h.listed([S, 1], [S2, 1]));
    expect(h.mem.state(P)).toMatchObject({ error: "not_found" });
    expect(h.mem.state(P2)).toMatchObject({ pulledAt: 5_000_000, stamp: 1 });
    // Not a matter of the account: the session is not asked to look again.
    expect(h.dev.rechecks).toBe(0);
  });

  it("never rejects, even when the device's storage cannot be read", async () => {
    const h = harness();
    h.mem.store.states = async () => {
      throw new Error("blocked");
    };
    await expect(h.engine.reconcile(h.listed([S, 1]))).resolves.toBeUndefined();
  });
});

describe("a project that left the account", () => {
  const detached = () => {
    const h = harness();
    h.mem.putState({ projectId: P, pulledAt: 1, stamp: 42, members: [] });
    h.mem.addComment(mirrorComment(P, teamComment("c1")));
    h.mem.putReview(mirrorReview(P, teamReview("step-2")));
    h.mem.queue(waitingComment("u1", { queuedAt: 10_000_000 }));
    h.mem.queue(waitingComment("u-bob", { queuedBy: BOB.id }));
    // Its owner deleted it, or this person was removed: sync kept the copy on this device.
    h.setLink(P, { kind: "device", asked: true });
    return h;
  };

  it("keeps its discussion as ordinary rows of the copy on this device", async () => {
    const h = detached();
    await h.engine.reconcile(h.listed());
    expect(h.server.calls).toEqual([]);
    expect(h.mem.comments()).toEqual([
      { projectId: P, stepId: "step-1", author: "Bob", text: "text of c1", timestamp: 900_000, origin: "local" },
      { projectId: P, stepId: "step-1", author: "Ada Lovelace", text: "unsent u1", timestamp: 10_000_000, origin: "local" },
    ]);
    expect(h.mem.reviews()).toEqual([
      { id: reviewKey(P, "step-2"), projectId: P, stepId: "step-2", status: "approved", reviewer: "Bob", timestamp: 950_000, origin: "local" },
    ]);
    expect(h.mem.state()).toBeUndefined();
    // What another account left waiting is not this person's to turn into a comment.
    expect(h.mem.outbox().map((o) => o.uid)).toEqual(["u-bob"]);
  });

  it("does it once", async () => {
    const h = detached();
    await h.engine.reconcile(h.listed());
    const writes = h.mem.applied.length;
    await h.engine.reconcile(h.listed());
    expect(h.mem.applied).toHaveLength(writes);
  });

  it("leaves a project alone that is still in an account, whoever's", async () => {
    const h = detached();
    h.setLink(P, link({ owner: BOB.id }));
    await h.engine.reconcile(h.listed());
    expect(h.mem.comments().map((c) => c.origin)).toEqual(["server"]);
    expect(h.mem.state()).toBeDefined();
  });

  it("leaves a project alone whose link cannot be read: only one that is marked as kept on this device is converted", async () => {
    const h = detached();
    h.setLink(P, null);
    await h.engine.reconcile(h.listed());
    expect(h.mem.comments().map((c) => c.origin)).toEqual(["server"]);
    expect(h.mem.outbox().map((o) => o.uid).sort()).toEqual(["u-bob", "u1"]);
    expect(h.mem.state()).toBeDefined();
  });

  it("leaves it alone when the person changes while it is being looked at", async () => {
    const h = detached();
    const real = h.mem.store.transact;
    h.mem.store.transact = async (id, decide) => {
      h.engine.stop();
      return real(id, decide);
    };
    await h.engine.reconcile(h.listed());
    expect(h.mem.comments().map((c) => c.origin)).toEqual(["server"]);
    expect(h.mem.state()).toBeDefined();
  });

  it("finds a project that only has the person's waiting items, and nothing else on record", async () => {
    const h = harness();
    h.mem.queue(waitingComment("u1", { queuedAt: 10 }));
    h.setLink(P, { kind: "device", asked: true });
    await h.engine.reconcile(h.listed());
    expect(h.mem.outbox()).toEqual([]);
    expect(h.mem.comments()).toEqual([{ projectId: P, stepId: "step-1", author: "Ada Lovelace", text: "unsent u1", timestamp: 10, origin: "local" }]);
  });

  it("only ever turns the waiting items of the person it runs for into comments", async () => {
    const h = detached();
    // The session says somebody else than the account sync was started for.
    h.dev.me = BOB;
    await h.engine.reconcile(h.listed());
    expect(h.mem.outbox().map((o) => o.uid).sort()).toEqual(["u-bob", "u1"]);
    // The team's rows are still kept with the copy.
    expect(h.mem.comments().map((c) => [c.text, c.origin])).toEqual([["text of c1", "local"]]);
    const writes = h.mem.applied.length;
    await h.engine.reconcile(h.listed());
    expect(h.mem.applied).toHaveLength(writes);
  });

  it("leaves the person's waiting items on their other projects alone", async () => {
    const h = detached();
    h.setLink(P2, link({ serverId: S2 }));
    h.mem.queue(waitingComment("u-other", { projectId: P2 }));
    h.server.refuse.set("listReviews", [offline()]);
    await h.engine.reconcile(h.listed([S2, 1]));
    expect(h.mem.outbox().map((o) => [o.uid, o.projectId]).sort()).toEqual([
      ["u-bob", P],
      ["u-other", P2],
    ]);
    expect(h.mem.comments(P2)).toEqual([]);
  });

  it("frees the account ids of its comments, so a fresh download of the project can use them", async () => {
    const h = detached();
    await h.engine.reconcile(h.listed());
    // Invited again: the project comes down as a second copy and mirrors the same comment.
    h.setLink(P2, link());
    h.server.comments.set(S, [teamComment("c1")]);
    await h.engine.reconcile(h.listed([S, 50]));
    expect(h.mem.comments(P2).map((c) => [c.uid, c.origin])).toEqual([["c1", "server"]]);
    expect(h.mem.comments(P).map((c) => [c.text, c.origin])).toEqual([
      ["text of c1", "local"],
      ["unsent u1", "local"],
    ]);
  });
});

describe("two copies of one server project on a device", () => {
  it("lets the signed-in person's copy hold the comments and marks the other copy to read its own again", async () => {
    const h = harness();
    // Ada's copy, read up to marker 7. Bob has his own copy of the same project and is signed in.
    h.mem.addComment(mirrorComment(P, teamComment("c1")));
    h.mem.putState({ projectId: P, pulledAt: 1, stamp: 7 });
    h.switchTo(BOB);
    h.setLink(P2, link({ owner: BOB.id, role: "editor" }));
    h.server.comments.set(S, [teamComment("c1")]);
    await h.engine.request(P2);

    expect(h.mem.comments(P2).map((c) => c.uid)).toEqual(["c1"]);
    expect(h.mem.comments(P)).toEqual([]);
    expect(h.mem.state(P)).toEqual({ projectId: P, pulledAt: null, stamp: null });

    // Ada signs back in: her copy reads again, because its marker was cleared.
    h.switchTo(ADA);
    await h.engine.reconcile(h.listed([S, 7]));
    expect(h.mem.comments(P).map((c) => c.uid)).toEqual(["c1"]);
  });
});

describe("a copy that another account took over", () => {
  // Ada wrote on P while offline. Bob, a member of the same project, then took
  // the copy over, and Ada was later given a copy of her own (P2).
  const takenOver = () => {
    const h = harness();
    h.setLink(P, link({ owner: BOB.id, role: "editor" }));
    h.setLink(P2, link());
    return h;
  };

  it("moves the person's waiting comment to their own copy and uploads it from there", async () => {
    const h = takenOver();
    h.mem.queue(waitingComment("u1"));
    await h.engine.reconcile(h.listed([S, 5]));
    expect(h.server.comments.get(S)?.map((c) => [c.id, c.author_id])).toEqual([["u1", ADA.id]]);
    expect(h.mem.outbox()).toEqual([]);
    expect(h.mem.comments(P2).map((c) => c.uid)).toEqual(["u1"]);
  });

  it("moves a waiting sign-off under the key of the person's own copy", async () => {
    const h = takenOver();
    h.mem.queue(waitingReview({ note: "moved" }));
    h.server.refuse.set("listReviews", [offline()]);
    await h.engine.reconcile(h.listed([S, 5]));
    expect(h.mem.outbox()).toEqual([waitingReview({ note: "moved", projectId: P2, uid: reviewOutboxUid(P2, "step-1", ADA.id) })]);
  });

  it("lets a sign-off already waiting on the person's own copy stand, and drops the older one", async () => {
    const h = takenOver();
    const later = waitingReview({ projectId: P2, uid: reviewOutboxUid(P2, "step-1", ADA.id), status: "changes", queuedAt: 200 });
    h.mem.queue(waitingReview());
    h.mem.queue(later);
    h.server.refuse.set("listReviews", [offline()]);
    await h.engine.reconcile(h.listed([S, 5]));
    expect(h.mem.outbox()).toEqual([later]);
  });

  it("leaves what the other account wrote on that copy where it is", async () => {
    const h = takenOver();
    h.mem.queue(waitingComment("u-bob", { queuedBy: BOB.id }));
    await h.engine.reconcile(h.listed([S, 5]));
    expect(h.mem.outbox()).toEqual([waitingComment("u-bob", { queuedBy: BOB.id })]);
  });
});

describe("keeping the project on screen fresh", () => {
  it("syncs a project when it is opened, at most once in a while", async () => {
    const h = harness();
    h.open(P);
    await h.settle();
    expect(h.server.calls).toEqual(["listReviews", "listComments", "listMembers"]);

    h.server.calls.length = 0;
    h.open(null);
    h.dev.now += OPEN_SYNC_MS - 1;
    h.open(P);
    await h.settle();
    expect(h.server.calls).toEqual([]);

    h.open(null);
    h.dev.now += 1;
    h.open(P);
    await h.settle();
    expect(h.server.calls).toEqual(["listReviews", "listComments", "listMembers"]);
  });

  it("syncs the open project the moment it goes into the account, and not on later changes of its link", async () => {
    const h = harness();
    h.setLink(P, { kind: "device", asked: false });
    h.open(P);
    await h.settle();
    expect(h.server.calls).toEqual([]);

    h.setLink(P, link({ created: false }));
    await h.settle();
    expect(h.server.calls).toEqual([]);

    h.setLink(P, link());
    await h.settle();
    expect(h.server.calls).toEqual(["listReviews", "listComments", "listMembers"]);

    h.server.calls.length = 0;
    h.dev.now += OPEN_SYNC_MS * 2;
    h.setLink(P, link({ rev: 2 }));
    await h.settle();
    expect(h.server.calls).toEqual([]);
  });

  it("does not sync an opened project while offline, or one that is not in this account", async () => {
    const h = harness();
    h.dev.online = false;
    h.open(P);
    h.dev.online = true;
    h.setLink(P2, link({ owner: BOB.id, serverId: S2 }));
    h.open(P2);
    await h.settle();
    expect(h.server.calls).toEqual([]);
  });

  it("stops watching when it is stopped", async () => {
    const h = harness();
    expect(h.listening()).toBe(2);
    h.engine.stop();
    expect(h.listening()).toBe(0);
    h.open(P);
    h.setLink(P, link({ rev: 3 }));
    await h.settle();
    expect(h.server.calls).toEqual([]);
  });
});

describe("one pass at a time per project", () => {
  it("runs passes of one project one after another, and lets one waiting pass serve every request made meanwhile", async () => {
    const h = harness();
    let running = 0;
    let most = 0;
    h.server.onCall = (name) => {
      if (name === "listReviews") most = Math.max(most, (running += 1));
      if (name === "listMembers") running -= 1;
    };
    const release = h.hold("listReviews");
    // Two asked for in the same breath are one pass.
    const first = [h.engine.request(P), h.engine.request(P)];
    await h.settle();
    expect(h.server.calls).toEqual(["listReviews"]);
    // Three more while it runs: they share the next one.
    const more = [h.engine.request(P), h.engine.request(P), h.engine.request(P)];
    await h.settle();
    expect(h.server.calls).toEqual(["listReviews"]);
    release();
    await Promise.all([...first, ...more]);
    expect(most).toBe(1);
    expect(h.server.calls.filter((c) => c === "listReviews")).toHaveLength(2);
  });

  it("gives a waiting pass the marker of a project sync that joins it", async () => {
    const h = harness();
    const release = h.hold("listReviews");
    const running = h.engine.request(P);
    await h.settle();
    // Asked for after a write, without a marker. Then a project sync comes by with one.
    const waiting = h.engine.request(P);
    const joined = h.engine.reconcile(h.listed([S, 77]));
    await h.settle();
    release();
    await Promise.all([running, waiting, joined]);
    expect(h.server.calls.filter((c) => c === "listReviews")).toHaveLength(2);
    expect(h.mem.state()).toMatchObject({ stamp: 77 });
  });

  it("does not hand a pass that was waiting for one person to the next", async () => {
    const h = harness();
    const release = h.hold("listReviews");
    const running = h.engine.request(P);
    await h.settle();
    const waiting = h.engine.request(P);
    // Ada signs out with a pass still waiting. Bob signs in, takes the copy over, and writes.
    h.switchTo(BOB);
    h.setLink(P, link({ owner: BOB.id, role: "editor" }));
    h.mem.queue(waitingComment("u-bob", { queuedBy: BOB.id }));
    const bobs = h.engine.request(P);
    release();
    await Promise.all([running, waiting, bobs]);
    expect(h.server.comments.get(S)?.map((c) => [c.id, c.author_id])).toEqual([["u-bob", BOB.id]]);
  });

  it("is not put off its stride by being started again for the same person", async () => {
    const h = harness();
    h.server.comments.set(S, [teamComment("c1")]);
    const release = h.hold("listReviews");
    const running = h.engine.request(P);
    await h.settle();
    h.engine.start(ADA.id);
    release();
    await running;
    expect(h.mem.comments().map((c) => c.uid)).toEqual(["c1"]);
    // And it did not start watching twice.
    expect(h.listening()).toBe(2);
  });

  it("starts a new pass for something written after the last one began", async () => {
    const h = harness();
    h.mem.queue(waitingComment("u1", { queuedAt: 10 }));
    h.server.onCall = (name) => {
      if (name !== "listComments") return;
      h.server.onCall = null;
      // Written while the first pass was already past its upload step.
      h.mem.queue(waitingComment("u2", { queuedAt: 20 }));
      void h.engine.request(P);
    };
    await h.engine.request(P);
    await h.settle();
    expect(h.server.comments.get(S)?.map((c) => c.id)).toEqual(["u1", "u2"]);
    expect(h.mem.outbox()).toEqual([]);
  });

  it("lets different projects sync at the same time", async () => {
    const h = harness();
    h.setLink(P2, link({ serverId: S2 }));
    h.server.comments.set(S, [teamComment("c1")]);
    h.server.comments.set(S2, [teamComment("c2")]);
    await Promise.all([h.engine.request(P), h.engine.request(P2)]);
    expect(h.mem.comments(P).map((c) => c.uid)).toEqual(["c1"]);
    expect(h.mem.comments(P2).map((c) => c.uid)).toEqual(["c2"]);
  });

  it("does not let a pass asked for by one person run for the next", async () => {
    const h = harness();
    h.mem.queue(waitingComment("u1"));
    const first = h.engine.request(P);
    const second = h.engine.request(P);
    h.switchTo(BOB);
    await Promise.all([first, second]);
    expect(h.server.calls.filter((c) => c.startsWith("addComment"))).toEqual([]);
  });
});

describe("the calls", () => {
  const caller = (answers: Record<string, unknown>) => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    const call = async <T>(fn: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push([fn, args]);
      const answer = answers[fn];
      if (answer instanceof Error) throw answer;
      return answer as T;
    };
    return { api: createCollabApi(call), calls };
  };

  it("reads the comments of a project, dropping rows it cannot place", async () => {
    const { api, calls } = caller({
      list_project_comments: {
        comments: [{ id: "c1", project_id: S, step_id: "step-1", author_id: "u", author_name: "Bob", text: "hi", created_at: 5 }, { text: "no id" }],
      },
    });
    expect(await api.listComments(S)).toEqual([{ id: "c1", step_id: "step-1", author_id: "u", author_name: "Bob", text: "hi", created_at: 5 }]);
    expect(calls).toEqual([["list_project_comments", { p_project_id: S }]]);
  });

  it("refuses an answer that is not a list, rather than taking it for an empty one", async () => {
    for (const answer of [null, {}, { comments: null }, { comments: "none" }, []]) {
      await expect(caller({ list_project_comments: answer }).api.listComments(S)).rejects.toMatchObject({ code: "server_error" });
      await expect(caller({ list_project_reviews: answer }).api.listReviews(S)).rejects.toMatchObject({ code: "server_error" });
      await expect(caller({ list_project_members: answer }).api.listMembers(S)).rejects.toMatchObject({ code: "server_error" });
    }
  });

  it("uploads a comment under the id made on this device", async () => {
    const { api, calls } = caller({
      add_project_comment: { comment: { id: "u1", step_id: "step-1", author_id: "u", author_name: "Ada", text: "hi", created_at: 9 } },
    });
    expect(await api.addComment(S, "step-1", "hi", "u1")).toMatchObject({ id: "u1", created_at: 9 });
    expect(calls).toEqual([["add_project_comment", { p_project_id: S, p_step_id: "step-1", p_text: "hi", p_id: "u1" }]]);
  });

  it("treats an upload whose answer cannot be read as not done yet", async () => {
    await expect(caller({ add_project_comment: {} }).api.addComment(S, "s", "hi", "u1")).rejects.toMatchObject({ status: 500, code: "server_error" });
    await expect(caller({ set_project_review: { review: { step_id: "s" } } }).api.setReview(S, "s", "approved")).rejects.toMatchObject({ code: "server_error" });
  });

  it("sends a sign-off with its note, and without one when there is none", async () => {
    const review = { review: { id: `${S}:s`, step_id: "s", status: "changes", reviewer_id: "u", reviewer_name: "Ada", note: "redo", created_at: 3 } };
    const withNote = caller({ set_project_review: review });
    expect(await withNote.api.setReview(S, "s", "changes", "redo")).toEqual({ step_id: "s", status: "changes", reviewer_id: "u", reviewer_name: "Ada", note: "redo", created_at: 3 });
    expect(withNote.calls).toEqual([["set_project_review", { p_project_id: S, p_step_id: "s", p_status: "changes", p_note: "redo" }]]);
    const without = caller({ set_project_review: review });
    await without.api.setReview(S, "s", "changes", "");
    expect(without.calls[0][1]).toEqual({ p_project_id: S, p_step_id: "s", p_status: "changes" });
  });

  it("reads the team, with an unreadable role as the least one", async () => {
    const { api } = caller({
      list_project_members: { members: [{ user_id: "u1", name: "Ada", email: "a@example.test", role: "owner" }, { user_id: "u2" }, { name: "nobody" }] },
    });
    expect(await api.listMembers(S)).toEqual([
      { id: "u1", name: "Ada", email: "a@example.test", role: "owner" },
      { id: "u2", name: "", email: "", role: "viewer" },
    ]);
  });

  it("passes a refusal from the backend on as it is", async () => {
    const refusal = new SyncError(403, "forbidden");
    await expect(caller({ set_project_review: refusal }).api.setReview(S, "s", "approved")).rejects.toBe(refusal);
  });
});
