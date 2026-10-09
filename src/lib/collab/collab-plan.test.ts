import { describe, expect, it } from "vitest";
import type { Comment, OutboxItem, Review } from "@/lib/db/schema";
import {
  COMMENT_MAX,
  HELD_NOTE,
  NOTE_MAX,
  OPEN_SYNC_MS,
  READONLY_NOTE,
  UNSENT_REVIEW_HINT,
  accountName,
  canRetry,
  charCount,
  classifyPushError,
  collabMode,
  commentFromRow,
  describeUnsentError,
  effectiveReview,
  gateNote,
  isDue,
  isEmptyLocalise,
  mergeThread,
  mirrorComment,
  mirrorReview,
  pendingHint,
  planAdoption,
  planComment,
  planCommentPull,
  planFlush,
  planLocalise,
  planRehome,
  planReviewPull,
  planSignOff,
  reviewFromRow,
  reviewGate,
  reviewKey,
  reviewOutboxUid,
  serverReviewsOf,
  shouldPull,
  teamSyncAnnouncement,
  teamSyncLine,
  toMs,
  viewerOf,
  type CollabMode,
  type CollabSession,
  type Me,
  type ServerComment,
  type ServerReview,
} from "./collab-plan";
import type { AccountLink, Link } from "./links";
import type { ProjectRole } from "./sync";

const ADA: Me = { id: "user-ada", name: "Ada Lovelace" };
const BOB: Me = { id: "user-bob", name: "Bob" };
const P = "proj-local";
const S = "proj_11111111-1111-4111-8111-111111111111";

const link = (over: Partial<AccountLink> = {}): AccountLink => ({
  kind: "account",
  owner: ADA.id,
  serverId: S,
  rev: 1,
  created: true,
  role: "owner",
  ...over,
});

const serverComment = (id: string, over: Partial<ServerComment> = {}): ServerComment => ({
  id,
  step_id: "step-1",
  author_id: BOB.id,
  author_name: "Bob",
  text: `text of ${id}`,
  created_at: 1000,
  ...over,
});

const serverReview = (step: string, over: Partial<ServerReview> = {}): ServerReview => ({
  step_id: step,
  status: "approved",
  reviewer_id: BOB.id,
  reviewer_name: "Bob",
  note: null,
  created_at: 5000,
  ...over,
});

/** A comment written on this device. */
const localComment = (id: number, over: Partial<Comment> = {}): Comment => ({
  id,
  projectId: P,
  stepId: "step-1",
  author: "Ada Lovelace",
  role: "researcher",
  text: `local ${id}`,
  timestamp: 100 * id,
  origin: "local",
  ...over,
});

/** A stored copy of a team comment. */
const mirrored = (id: number, c: ServerComment): Comment => ({ ...mirrorComment(P, c), id });

const unsentComment = (uid: string, over: Partial<OutboxItem> = {}): OutboxItem => ({
  uid,
  kind: "comment",
  projectId: P,
  stepId: "step-1",
  queuedBy: ADA.id,
  queuedAt: 9000,
  text: `unsent ${uid}`,
  attempts: 0,
  ...over,
});

const unsentReview = (over: Partial<OutboxItem> = {}): OutboxItem => ({
  uid: reviewOutboxUid(P, "step-1", ADA.id),
  kind: "review",
  projectId: P,
  stepId: "step-1",
  queuedBy: ADA.id,
  queuedAt: 9000,
  status: "approved",
  baseAt: null,
  attempts: 0,
  ...over,
});

describe("toMs", () => {
  it("passes a number through and reads a numeric string", () => {
    expect(toMs(1730000000000)).toBe(1730000000000);
    expect(toMs("1730000000000")).toBe(1730000000000);
    expect(toMs(" 12.5 ")).toBe(12.5);
  });

  it("reads an ISO date", () => {
    expect(toMs("2026-10-08T10:00:00.000Z")).toBe(Date.UTC(2026, 9, 8, 10));
  });

  it("is 0 for anything it cannot read", () => {
    for (const v of [null, undefined, "", "soon", Number.NaN, Number.POSITIVE_INFINITY, {}, []]) expect(toMs(v)).toBe(0);
  });
});

describe("limits", () => {
  it("are the ones the backend enforces", () => {
    expect(COMMENT_MAX).toBe(5000);
    expect(NOTE_MAX).toBe(2000);
  });
});

describe("charCount", () => {
  it("counts whole characters, as the account does", () => {
    expect(charCount("abc")).toBe(3);
    expect(charCount("a😀")).toBe(2);
    expect("a😀".length).toBe(3);
  });
});

describe("reading what the backend returns", () => {
  it("reads a comment with an epoch or an ISO time", () => {
    const row = { id: "c1", project_id: S, step_id: "step-1", author_id: "u1", author_name: "Bob", text: "hi", created_at: 1234 };
    expect(commentFromRow(row)).toEqual({ id: "c1", step_id: "step-1", author_id: "u1", author_name: "Bob", text: "hi", created_at: 1234 });
    expect(commentFromRow({ ...row, created_at: "2026-10-08T10:00:00Z" })?.created_at).toBe(Date.UTC(2026, 9, 8, 10));
  });

  it("keeps a comment whose author's account is gone, with no author id", () => {
    expect(commentFromRow({ id: "c1", step_id: "s", author_id: null, author_name: "Deleted user", text: "x", created_at: 1 })?.author_id).toBeNull();
  });

  it("drops a comment that cannot be placed", () => {
    expect(commentFromRow(null)).toBeNull();
    expect(commentFromRow([])).toBeNull();
    expect(commentFromRow({ step_id: "s", text: "x" })).toBeNull();
    expect(commentFromRow({ id: "", step_id: "s" })).toBeNull();
    expect(commentFromRow({ id: "c1", text: "x" })).toBeNull();
  });

  it("reads a sign-off, and an empty note as none", () => {
    const row = { id: `${S}:step-1`, project_id: S, step_id: "step-1", status: "changes", reviewer_id: "u1", reviewer_name: "Bob", note: "", created_at: 77 };
    expect(reviewFromRow(row)).toEqual({ step_id: "step-1", status: "changes", reviewer_id: "u1", reviewer_name: "Bob", note: null, created_at: 77 });
    expect(reviewFromRow({ ...row, note: "see table 2" })?.note).toBe("see table 2");
  });

  it("drops a sign-off with no step or a status it does not know", () => {
    expect(reviewFromRow({ step_id: "", status: "approved" })).toBeNull();
    expect(reviewFromRow({ step_id: "s", status: "maybe" })).toBeNull();
    expect(reviewFromRow("approved")).toBeNull();
  });
});

describe("keys and mirror rows", () => {
  it("keys a sign-off by this device's project id and the step", () => {
    expect(reviewKey(P, "step-1")).toBe("proj-local:step-1");
  });

  it("gives each account its own waiting sign-off for a step", () => {
    expect(reviewOutboxUid(P, "step-1", ADA.id)).not.toBe(reviewOutboxUid(P, "step-1", BOB.id));
    expect(reviewOutboxUid(P, "step-1", ADA.id)).toBe(reviewOutboxUid(P, "step-1", ADA.id));
  });

  it("copies a team comment under this device's project id, with the account's id, name and time", () => {
    expect(mirrorComment(P, serverComment("c1", { created_at: 42 }))).toEqual({
      projectId: P,
      stepId: "step-1",
      author: "Bob",
      text: "text of c1",
      timestamp: 42,
      origin: "server",
      uid: "c1",
      authorId: BOB.id,
    });
    expect(mirrorComment(P, serverComment("c1", { author_id: null }))).not.toHaveProperty("authorId");
  });

  it("copies a team sign-off under this device's key, ignoring the account's own", () => {
    expect(mirrorReview(P, serverReview("step-2", { note: "ok", created_at: 9 }))).toEqual({
      id: "proj-local:step-2",
      projectId: P,
      stepId: "step-2",
      status: "approved",
      reviewer: "Bob",
      note: "ok",
      timestamp: 9,
      origin: "server",
      reviewerId: BOB.id,
    });
    expect(mirrorReview(P, serverReview("step-2"))).not.toHaveProperty("note");
  });
});

describe("collabMode", () => {
  const ready = (id: string, name = "Ada Lovelace", email = "ada@example.test"): CollabSession => ({
    phase: "ready",
    profile: { id, name, email },
    deviceAccount: { id, name, email },
  });
  const anon: CollabSession = { phase: "anon", profile: null, deviceAccount: null };

  it("is local for a project with no link or a device link, signed in or not", () => {
    for (const l of [null, undefined, { kind: "device", asked: false } as Link, { kind: "device", asked: true } as Link]) {
      expect(collabMode(l, anon)).toEqual({ kind: "local" });
      expect(collabMode(l, ready(ADA.id))).toEqual({ kind: "local" });
    }
  });

  it("is the account's for a project in the signed-in person's account, with their role on it", () => {
    expect(collabMode(link({ role: "supervisor" }), ready(ADA.id))).toEqual({ kind: "account", serverId: S, role: "supervisor", me: ADA });
  });

  it("takes the name from the account, never from the device identity", () => {
    const mode = collabMode(link(), ready(ADA.id, "  ", "ada.l@example.test"));
    expect(mode).toMatchObject({ kind: "account", me: { id: ADA.id, name: "ada.l" } });
  });

  it("is read-only for an account project while signed out, so a device name can never land in a team thread", () => {
    expect(collabMode(link(), anon)).toEqual({ kind: "readonly", reason: "signed-out", me: null });
    expect(collabMode(link(), { phase: "loading", profile: null, deviceAccount: null })).toMatchObject({ kind: "readonly", reason: "signed-out" });
    expect(collabMode(link(), { phase: "unconfigured", profile: null, deviceAccount: null })).toMatchObject({ kind: "readonly" });
  });

  it("still knows whose waiting comments to show after a sign-out nobody asked for", () => {
    const expired: CollabSession = { phase: "anon", profile: null, deviceAccount: { id: ADA.id, name: "Ada Lovelace", email: "ada@example.test" } };
    expect(collabMode(link(), expired)).toEqual({ kind: "readonly", reason: "signed-out", me: ADA });
    expect(collabMode(link({ owner: BOB.id }), expired)).toEqual({ kind: "readonly", reason: "signed-out", me: null });
  });

  it("is read-only for a project of another account", () => {
    expect(collabMode(link({ owner: BOB.id }), ready(ADA.id))).toEqual({ kind: "readonly", reason: "other-account", me: null });
  });

  it("does not trust a profile left over from a session that is not ready", () => {
    const stale: CollabSession = { phase: "anon", profile: { id: ADA.id, name: "Ada", email: "a@example.test" }, deviceAccount: null };
    expect(collabMode(link(), stale).kind).toBe("readonly");
  });

  it("shows waiting items to nobody on a device project, and to their author otherwise", () => {
    expect(viewerOf({ kind: "local" })).toBeNull();
    expect(viewerOf({ kind: "account", serverId: S, role: "editor", me: ADA })).toBe(ADA);
    expect(viewerOf({ kind: "readonly", reason: "signed-out", me: ADA })).toBe(ADA);
    expect(viewerOf({ kind: "readonly", reason: "other-account", me: null })).toBeNull();
  });
});

describe("accountName", () => {
  it("is the name, or the start of the address, as the account stamps it", () => {
    expect(accountName({ name: " Ada ", email: "ada@example.test" })).toBe("Ada");
    expect(accountName({ name: "", email: "ada.l@example.test" })).toBe("ada.l");
    expect(accountName({ name: "", email: "" })).toBe("You");
  });
});

describe("reviewGate", () => {
  const account = (role: ProjectRole): CollabMode => ({ kind: "account", serverId: S, role, me: ADA });

  it("on a device project follows the role chosen on this device, as it always has", () => {
    expect(reviewGate({ kind: "local" }, "researcher")).toEqual({ show: false, allowed: false });
    expect(reviewGate({ kind: "local" }, "supervisor")).toEqual({ show: true, allowed: true });
  });

  it("on an account project lets a supervisor or the owner sign off", () => {
    expect(reviewGate(account("supervisor"), "researcher")).toEqual({ show: true, allowed: true });
    expect(reviewGate(account("owner"), "researcher")).toEqual({ show: true, allowed: true });
  });

  it("on an account project refuses a viewer or an editor, and says which they are", () => {
    expect(reviewGate(account("viewer"), "researcher")).toEqual({ show: true, allowed: false, reason: "viewer" });
    expect(reviewGate(account("editor"), "researcher")).toEqual({ show: true, allowed: false, reason: "editor" });
  });

  it("ignores the device role on an account project: nobody makes themselves a supervisor", () => {
    expect(reviewGate(account("editor"), "supervisor")).toEqual({ show: true, allowed: false, reason: "editor" });
    expect(reviewGate(account("viewer"), "supervisor").allowed).toBe(false);
  });

  it("shows nothing to sign with while the project's account is signed out", () => {
    expect(reviewGate({ kind: "readonly", reason: "signed-out", me: null }, "supervisor")).toEqual({ show: false, allowed: false, reason: "readonly" });
  });
});

describe("planComment", () => {
  const account = (role: ProjectRole = "viewer"): CollabMode => ({ kind: "account", serverId: S, role, me: ADA });
  const input = (text: string, mode: CollabMode) => ({ projectId: P, stepId: "step-1", text, mode, uid: "uuid-1", now: 777 });

  it("writes to the device for a project kept on this device, as it always has", () => {
    expect(planComment(input("hello", { kind: "local" }))).toEqual({ to: "device" });
  });

  it("queues an account project's comment under the account, with the id made on this device", () => {
    expect(planComment(input("  hello team  ", account()))).toEqual({
      to: "outbox",
      actor: "Ada Lovelace",
      item: { uid: "uuid-1", kind: "comment", projectId: P, stepId: "step-1", queuedBy: ADA.id, queuedAt: 777, text: "hello team", attempts: 0 },
    });
  });

  it("lets every member comment, a viewer too", () => {
    for (const role of ["viewer", "editor", "supervisor", "owner"] as const) expect(planComment(input("hi", account(role))).to).toBe("outbox");
  });

  it("writes nothing for an empty text, anywhere", () => {
    for (const mode of [{ kind: "local" } as CollabMode, account()]) {
      expect(planComment(input("", mode))).toEqual({ to: "nowhere" });
      expect(planComment(input("  \n ", mode))).toEqual({ to: "nowhere" });
    }
  });

  it("refuses while the project's account is signed out, whoever is looking", () => {
    expect(planComment(input("hello", { kind: "readonly", reason: "signed-out", me: ADA }))).toEqual({ to: "nowhere" });
    expect(planComment(input("hello", { kind: "readonly", reason: "other-account", me: null }))).toEqual({ to: "nowhere" });
  });

  it("refuses a comment longer than the account accepts, counted the way the account counts", () => {
    expect(planComment(input("x".repeat(COMMENT_MAX), account())).to).toBe("outbox");
    expect(planComment(input("x".repeat(COMMENT_MAX + 1), account()))).toEqual({ to: "nowhere" });
    // Spaces around it do not count, and an emoji is one character.
    expect(planComment(input(` ${"x".repeat(COMMENT_MAX)} `, account())).to).toBe("outbox");
    expect(planComment(input("😀".repeat(COMMENT_MAX), account())).to).toBe("outbox");
  });

  it("puts no limit on a project kept on this device", () => {
    expect(planComment(input("x".repeat(COMMENT_MAX + 1), { kind: "local" }))).toEqual({ to: "device" });
  });
});

describe("planSignOff", () => {
  const account = (role: ProjectRole): CollabMode => ({ kind: "account", serverId: S, role, me: ADA });
  const input = (mode: CollabMode, over: Partial<Parameters<typeof planSignOff>[0]> = {}) => ({
    projectId: P,
    stepId: "step-1",
    status: "approved" as const,
    mode,
    now: 500,
    ...over,
  });

  it("writes to the device for a project kept on this device", () => {
    expect(planSignOff(input({ kind: "local" }))).toEqual({ to: "device" });
    expect(planSignOff(input({ kind: "local" }, { note: "n".repeat(NOTE_MAX + 1) }))).toEqual({ to: "device" });
  });

  it("queues an owner's or a supervisor's sign-off under the account, one per step", () => {
    for (const role of ["owner", "supervisor"] as const) {
      expect(planSignOff(input(account(role), { status: "changes", note: "  redo  " }))).toEqual({
        to: "outbox",
        actor: "Ada Lovelace",
        item: {
          uid: reviewOutboxUid(P, "step-1", ADA.id),
          kind: "review",
          projectId: P,
          stepId: "step-1",
          queuedBy: ADA.id,
          queuedAt: 500,
          status: "changes",
          note: "redo",
          baseAt: null,
          attempts: 0,
        },
      });
    }
  });

  it("leaves the note out when there is none", () => {
    const plan = planSignOff(input(account("owner"), { note: "   " }));
    expect(plan.to === "outbox" && "note" in plan.item).toBe(false);
  });

  it("refuses a viewer and an editor: only the role on the project counts", () => {
    expect(planSignOff(input(account("viewer")))).toEqual({ to: "nowhere" });
    expect(planSignOff(input(account("editor")))).toEqual({ to: "nowhere" });
  });

  it("refuses while the project's account is signed out", () => {
    expect(planSignOff(input({ kind: "readonly", reason: "signed-out", me: ADA }))).toEqual({ to: "nowhere" });
  });

  it("refuses a note longer than the account accepts", () => {
    expect(planSignOff(input(account("owner"), { note: "n".repeat(NOTE_MAX) })).to).toBe("outbox");
    expect(planSignOff(input(account("owner"), { note: "n".repeat(NOTE_MAX + 1) }))).toEqual({ to: "nowhere" });
  });

  it("remembers the team's sign-off that was on screen, and nothing for one written on this device", () => {
    const base = (shown: Parameters<typeof planSignOff>[0]["shown"]) => {
      const plan = planSignOff(input(account("owner"), { shown }));
      return plan.to === "outbox" ? plan.item.baseAt : "refused";
    };
    expect(base({ origin: "server", timestamp: 4242 })).toBe(4242);
    expect(base({ origin: "local", timestamp: 4242 })).toBeNull();
    expect(base({ timestamp: 4242 })).toBeNull();
    expect(base(null)).toBeNull();
    expect(base(undefined)).toBeNull();
  });

  it("always carries a later time than the waiting sign-off it replaces", () => {
    const at = (now: number, waitingAt?: number) => {
      const plan = planSignOff(input(account("owner"), { now, waiting: waitingAt === undefined ? null : { queuedAt: waitingAt } }));
      return plan.to === "outbox" ? plan.item.queuedAt : -1;
    };
    expect(at(500)).toBe(500);
    expect(at(500, 100)).toBe(500);
    expect(at(500, 500)).toBe(501);
    // The clock went back since the first one was made.
    expect(at(500, 900)).toBe(901);
  });
});

describe("planCommentPull", () => {
  it("adds a comment the device does not have yet", () => {
    const plan = planCommentPull(P, [], [serverComment("c1")]);
    expect(plan).toEqual({ add: [mirrorComment(P, serverComment("c1"))], update: [], removeIds: [] });
  });

  it("does nothing for a comment it already has, unchanged", () => {
    const c = serverComment("c1");
    expect(planCommentPull(P, [mirrored(7, c)], [c])).toEqual({ add: [], update: [], removeIds: [] });
  });

  it("updates a row whose author was renamed in the account", () => {
    const plan = planCommentPull(P, [mirrored(7, serverComment("c1"))], [serverComment("c1", { author_name: "Robert" })]);
    expect(plan).toEqual({ add: [], update: [{ id: 7, changes: { author: "Robert" } }], removeIds: [] });
  });

  it("updates every field that changed, and clears the author id when the account is gone", () => {
    const plan = planCommentPull(P, [mirrored(7, serverComment("c1"))], [
      serverComment("c1", { author_name: "Deleted user", author_id: null, text: "edited", created_at: 2000, step_id: "step-2" }),
    ]);
    expect(plan.update).toEqual([
      { id: 7, changes: { stepId: "step-2", author: "Deleted user", text: "edited", timestamp: 2000, authorId: undefined } },
    ]);
    expect(Object.keys(plan.update[0].changes)).toContain("authorId");
  });

  it("removes a mirror row that is no longer in the account", () => {
    const plan = planCommentPull(P, [mirrored(7, serverComment("c1")), mirrored(8, serverComment("c2"))], [serverComment("c2")]);
    expect(plan).toEqual({ add: [], update: [], removeIds: [7] });
  });

  it("empties the mirror when the account has no comments", () => {
    expect(planCommentPull(P, [mirrored(7, serverComment("c1"))], []).removeIds).toEqual([7]);
  });

  it("never touches a row written on this device, with or without an origin", () => {
    const legacy: Comment = { id: 2, projectId: P, stepId: "step-1", author: "Ada", role: "researcher", text: "old", timestamp: 5 };
    const plan = planCommentPull(P, [localComment(1), legacy], [serverComment("c1")]);
    expect(plan.removeIds).toEqual([]);
    expect(plan.update).toEqual([]);
    expect(plan.add).toHaveLength(1);
  });

  it("adds a comment once when the payload repeats its id", () => {
    const plan = planCommentPull(P, [], [serverComment("c1"), serverComment("c1", { text: "again" }), serverComment("c2")]);
    expect(plan.add.map((c) => [c.uid, c.text])).toEqual([
      ["c1", "text of c1"],
      ["c2", "text of c2"],
    ]);
  });

  it("keeps the account's order, oldest first, for what it adds", () => {
    const plan = planCommentPull(P, [], [serverComment("c1", { created_at: 1 }), serverComment("c2", { created_at: 2 }), serverComment("c3", { created_at: 3 })]);
    expect(plan.add.map((c) => c.uid)).toEqual(["c1", "c2", "c3"]);
  });

  it("drops every mirror row that carries no id from the account", () => {
    const broken = (id: number): Comment => ({ id, projectId: P, stepId: "step-1", author: "x", text: "x", timestamp: 1, origin: "server" });
    expect(planCommentPull(P, [broken(3), broken(4)], [serverComment("c1")]).removeIds.sort()).toEqual([3, 4]);
  });

  it("drops a mirror row that carries no id from the account, or a second one for the same id", () => {
    const broken: Comment = { id: 3, projectId: P, stepId: "step-1", author: "x", text: "x", timestamp: 1, origin: "server" };
    const twin = mirrored(9, serverComment("c1"));
    const plan = planCommentPull(P, [mirrored(7, serverComment("c1")), broken, twin], [serverComment("c1")]);
    expect(plan.removeIds.sort()).toEqual([3, 9]);
    expect(plan.add).toEqual([]);
  });
});

describe("planReviewPull", () => {
  it("stores a sign-off the device does not have", () => {
    expect(planReviewPull(P, [], [serverReview("step-1")])).toEqual({ put: [mirrorReview(P, serverReview("step-1"))], removeIds: [] });
  });

  it("does nothing for one it already has, unchanged", () => {
    const r = serverReview("step-1", { note: "fine" });
    expect(planReviewPull(P, [mirrorReview(P, r)], [r])).toEqual({ put: [], removeIds: [] });
  });

  it("replaces one that changed: a new verdict, reviewer, note or time", () => {
    const have = mirrorReview(P, serverReview("step-1"));
    for (const change of [{ status: "changes" as const }, { reviewer_name: "Robert" }, { note: "redo" }, { created_at: 6000 }, { reviewer_id: null }]) {
      expect(planReviewPull(P, [have], [serverReview("step-1", change)]).put).toHaveLength(1);
    }
  });

  it("removes a mirrored sign-off that is no longer in the account", () => {
    const plan = planReviewPull(P, [mirrorReview(P, serverReview("step-1")), mirrorReview(P, serverReview("step-2"))], [serverReview("step-2")]);
    expect(plan).toEqual({ put: [], removeIds: ["proj-local:step-1"] });
  });

  it("never touches a sign-off written on this device, even for the same step", () => {
    const local: Review = { id: reviewKey(P, "step-1"), projectId: P, stepId: "step-1", status: "changes", reviewer: "Dr Khan", timestamp: 1, origin: "local" };
    const legacy: Review = { id: reviewKey(P, "step-3"), projectId: P, stepId: "step-3", status: "approved", reviewer: "Dr Khan", timestamp: 1 };
    expect(planReviewPull(P, [local, legacy], [serverReview("step-1")])).toEqual({ put: [], removeIds: [] });
  });

  it("takes the first when the payload repeats a step", () => {
    const plan = planReviewPull(P, [], [serverReview("step-1", { status: "changes" }), serverReview("step-1")]);
    expect(plan.put.map((r) => r.status)).toEqual(["changes"]);
  });
});

describe("mergeThread", () => {
  it("shows stored comments oldest first, saying which are the team's", () => {
    const thread = mergeThread([mirrored(2, serverComment("c1", { created_at: 300 })), localComment(1, { role: "supervisor" })], [], null);
    expect(thread).toEqual([
      { key: "row-1", state: "local", author: "Ada Lovelace", role: "supervisor", text: "local 1", timestamp: 100 },
      { key: "c1", state: "synced", author: "Bob", authorId: BOB.id, text: "text of c1", timestamp: 300 },
    ]);
  });

  it("puts what is waiting after what is stored, in the order it was written", () => {
    const thread = mergeThread(
      [mirrored(1, serverComment("c1", { created_at: 99_999 }))],
      [unsentComment("u2", { queuedAt: 20 }), unsentComment("u1", { queuedAt: 10 })],
      ADA,
    );
    expect(thread.map((t) => [t.key, t.state])).toEqual([
      ["c1", "synced"],
      ["u1", "pending"],
      ["u2", "pending"],
    ]);
    expect(thread[1]).toEqual({ key: "u1", state: "pending", author: "Ada Lovelace", authorId: ADA.id, text: "unsent u1", timestamp: 10, uid: "u1" });
  });

  it("hides a waiting comment the mirror already has (the upload landed, its answer was lost)", () => {
    const thread = mergeThread([mirrored(1, serverComment("u1"))], [unsentComment("u1")], ADA);
    expect(thread.map((t) => [t.key, t.state])).toEqual([["u1", "synced"]]);
  });

  it("keeps the same key when a comment goes from waiting to uploaded", () => {
    const before = mergeThread([], [unsentComment("u1")], ADA)[0].key;
    const after = mergeThread([mirrored(4, serverComment("u1"))], [], ADA)[0].key;
    expect(after).toBe(before);
  });

  it("does not show another account's waiting comments", () => {
    expect(mergeThread([], [unsentComment("u1", { queuedBy: BOB.id })], ADA)).toEqual([]);
  });

  it("shows no waiting comments at all on a device project", () => {
    expect(mergeThread([localComment(1)], [unsentComment("u1")], null).map((t) => t.key)).toEqual(["row-1"]);
  });

  it("marks a refused comment as failed, with the reason", () => {
    const [item] = mergeThread([], [unsentComment("u1", { error: "forbidden" })], ADA);
    expect(item).toMatchObject({ state: "failed", error: "forbidden", uid: "u1" });
  });

  it("leaves sign-offs out of the thread", () => {
    expect(mergeThread([], [unsentReview()], ADA)).toEqual([]);
  });
});

describe("effectiveReview", () => {
  const team = mirrorReview(P, serverReview("step-1", { status: "changes", note: "redo" }));

  it("is nothing when the step has no sign-off", () => {
    expect(effectiveReview(null, [], ADA)).toBeNull();
    expect(effectiveReview(undefined, [unsentComment("u1")], ADA)).toBeNull();
  });

  it("shows the team's sign-off", () => {
    expect(effectiveReview(team, [], ADA)).toEqual({
      current: { status: "changes", reviewer: "Bob", reviewerId: BOB.id, note: "redo", timestamp: 5000, state: "synced" },
      failed: null,
    });
  });

  it("shows a sign-off written on this device as it always was", () => {
    const local: Review = { id: reviewKey(P, "step-1"), projectId: P, stepId: "step-1", status: "approved", reviewer: "Dr Khan", timestamp: 3 };
    expect(effectiveReview(local, [], null)?.current).toEqual({ status: "approved", reviewer: "Dr Khan", timestamp: 3, state: "local" });
  });

  it("shows the person's own waiting sign-off first: it is what they just did", () => {
    expect(effectiveReview(team, [unsentReview({ note: "good" })], ADA)).toEqual({
      current: { status: "approved", reviewer: "Ada Lovelace", reviewerId: ADA.id, note: "good", timestamp: 9000, state: "pending" },
      failed: null,
    });
  });

  it("finds the waiting sign-off among the person's waiting comments", () => {
    const view = effectiveReview(null, [unsentComment("u1"), unsentReview(), unsentComment("u2")], ADA);
    expect(view?.current).toMatchObject({ status: "approved", state: "pending" });
  });

  it("keeps the team's sign-off in place and adds a warning when the person's own was held back", () => {
    const view = effectiveReview(team, [unsentReview({ error: "superseded" })], ADA);
    expect(view?.current).toMatchObject({ status: "changes", reviewer: "Bob", state: "synced" });
    expect(view?.failed).toEqual({ uid: reviewOutboxUid(P, "step-1", ADA.id), error: "superseded", status: "approved" });
  });

  it("shows only the warning when nothing else stands", () => {
    expect(effectiveReview(null, [unsentReview({ error: "forbidden" })], ADA)).toEqual({
      current: null,
      failed: { uid: reviewOutboxUid(P, "step-1", ADA.id), error: "forbidden", status: "approved" },
    });
  });

  it("does not show another account's waiting sign-off", () => {
    expect(effectiveReview(team, [unsentReview({ queuedBy: BOB.id })], ADA)?.current).toMatchObject({ reviewer: "Bob", state: "synced" });
    expect(effectiveReview(null, [unsentReview({ queuedBy: BOB.id })], ADA)).toBeNull();
    expect(effectiveReview(null, [unsentReview()], null)).toBeNull();
  });
});

describe("planFlush", () => {
  const links = new Map<string, Link>([[P, link()]]);
  const none = new Map<string, Review>();
  const input = { userId: ADA.id, links, serverReviews: none };

  it("sends in the order things were written", () => {
    const steps = planFlush([unsentComment("u3", { queuedAt: 30 }), unsentComment("u1", { queuedAt: 10 }), unsentComment("u2", { queuedAt: 20 })], input);
    expect(steps.map((s) => [s.type, s.item.uid])).toEqual([
      ["send", "u1"],
      ["send", "u2"],
      ["send", "u3"],
    ]);
    expect(steps[0]).toMatchObject({ type: "send", serverId: S });
  });

  it("sends only what the signed-in account wrote itself", () => {
    const steps = planFlush([unsentComment("u1", { queuedBy: BOB.id }), unsentComment("u2")], input);
    expect(steps).toEqual([
      { type: "skip", item: unsentComment("u1", { queuedBy: BOB.id }), reason: "other-account" },
      { type: "send", item: unsentComment("u2"), serverId: S },
    ]);
  });

  it("skips, and never drops, an item whose project has no account link", () => {
    const item = unsentComment("u1", { projectId: "proj-other" });
    for (const other of [undefined, { kind: "device", asked: true } as Link]) {
      const l = new Map<string, Link>(other ? [["proj-other", other]] : []);
      expect(planFlush([item], { ...input, links: l })).toEqual([{ type: "skip", item, reason: "no-link" }]);
    }
  });

  it("skips an item whose project now belongs to another account, or is not confirmed on the server yet", () => {
    const item = unsentComment("u1");
    expect(planFlush([item], { ...input, links: new Map([[P, link({ owner: BOB.id })]]) })[0]).toMatchObject({ type: "skip", reason: "no-link" });
    expect(planFlush([item], { ...input, links: new Map([[P, link({ created: false })]]) })[0]).toMatchObject({ type: "skip", reason: "no-link" });
  });

  it("skips what the account refused before, unless forced", () => {
    const item = unsentComment("u1", { error: "forbidden" });
    expect(planFlush([item], input)).toEqual([{ type: "skip", item, reason: "failed" }]);
    expect(planFlush([item], { ...input, force: true })).toEqual([{ type: "send", item, serverId: S }]);
  });

  it("sends a sign-off when the step has none and had none when it was made", () => {
    expect(planFlush([unsentReview({ baseAt: null })], input)[0]).toMatchObject({ type: "send", serverId: S });
    expect(planFlush([unsentReview({ baseAt: undefined })], input)[0]).toMatchObject({ type: "send" });
  });

  it("sends a sign-off when the team's is still the one that was on screen", () => {
    const serverReviews = serverReviewsOf([mirrorReview(P, serverReview("step-1", { created_at: 5000 }))]);
    expect(planFlush([unsentReview({ baseAt: 5000 })], { ...input, serverReviews })[0]).toMatchObject({ type: "send" });
  });

  it("holds a sign-off back when someone else signed the step off in the meantime", () => {
    const serverReviews = serverReviewsOf([mirrorReview(P, serverReview("step-1", { created_at: 7000 }))]);
    const item = unsentReview({ baseAt: 5000 });
    expect(planFlush([item], { ...input, serverReviews })).toEqual([{ type: "reject", item, error: "superseded" }]);
    // The same when there was none on screen and now there is one.
    expect(planFlush([unsentReview({ baseAt: null })], { ...input, serverReviews })[0]).toMatchObject({ type: "reject", error: "superseded" });
  });

  it("holds it back too when the one that was on screen has gone", () => {
    expect(planFlush([unsentReview({ baseAt: 5000 })], input)[0]).toMatchObject({ type: "reject", error: "superseded" });
  });

  it("stays held when forced: the person has to sign off again", () => {
    const serverReviews = serverReviewsOf([mirrorReview(P, serverReview("step-1", { created_at: 7000 }))]);
    const item = unsentReview({ baseAt: 5000, error: "superseded" });
    expect(planFlush([item], { ...input, serverReviews, force: true })[0]).toMatchObject({ type: "reject", error: "superseded" });
  });

  it("drops a sign-off the account already has from this person (its answer was lost)", () => {
    const mine = serverReview("step-1", { reviewer_id: ADA.id, reviewer_name: "Ada Lovelace", status: "approved", note: "good", created_at: 7000 });
    const item = unsentReview({ baseAt: 5000, note: "good" });
    expect(planFlush([item], { ...input, serverReviews: serverReviewsOf([mirrorReview(P, mine)]) })).toEqual([{ type: "settled", item }]);
  });

  it("holds back a sign-off that differs from the person's own newer one, and says it was theirs", () => {
    const mine = serverReview("step-1", { reviewer_id: ADA.id, status: "changes", created_at: 7000 });
    const serverReviews = serverReviewsOf([mirrorReview(P, mine)]);
    expect(planFlush([unsentReview({ baseAt: 5000 })], { ...input, serverReviews })[0]).toMatchObject({ type: "reject", error: "superseded_own" });
    const sameVerdict = serverReview("step-1", { reviewer_id: ADA.id, status: "approved", note: "v1", created_at: 7000 });
    expect(planFlush([unsentReview({ baseAt: 5000, note: "v2" })], { ...input, serverReviews: serverReviewsOf([mirrorReview(P, sameVerdict)]) })[0]).toMatchObject({
      type: "reject",
      error: "superseded_own",
    });
  });

  it("only compares against the team's sign-offs, never one written on this device", () => {
    const local: Review = { id: reviewKey(P, "step-1"), projectId: P, stepId: "step-1", status: "changes", reviewer: "Dr Khan", timestamp: 1, origin: "local" };
    expect(serverReviewsOf([local]).size).toBe(0);
  });

  it("sends a comment and a sign-off written at the same moment with the comment first", () => {
    const steps = planFlush([unsentReview({ queuedAt: 10 }), unsentComment("u1", { queuedAt: 10 })], input);
    expect(steps.map((s) => s.item.kind)).toEqual(["comment", "review"]);
  });
});

describe("classifyPushError", () => {
  it.each([
    [0, "network", "retry"],
    [0, "offline", "retry"],
    [500, "server_error", "retry"],
    [502, "server_error", "retry"],
    [503, "server_error", "retry"],
    [429, "rate_limited", "retry"],
    [408, "request_timeout", "retry"],
    [0, "storage_error", "retry"],
    [401, "unauthenticated", "hold"],
    [401, "anything", "hold"],
    [403, "account_suspended", "hold"],
    [403, "password_reset_required", "hold"],
    [0, "not_configured", "hold"],
    [400, "invalid_input", "reject"],
    [403, "forbidden", "reject"],
    [404, "not_found", "reject"],
    [409, "conflict", "reject"],
    [410, "gone", "reject"],
    [422, "unprocessable", "reject"],
  ] as const)("%i %s is %s", (status, code, verdict) => {
    expect(classifyPushError({ status, code })).toBe(verdict);
  });
});

describe("canRetry", () => {
  it("is false for a sign-off that was overtaken: it is made again instead", () => {
    expect(canRetry("superseded")).toBe(false);
    expect(canRetry("superseded_own")).toBe(false);
    expect(canRetry("forbidden")).toBe(true);
    expect(canRetry("invalid_input")).toBe(true);
  });
});

describe("planAdoption", () => {
  const day = (ms: number) => `day-${ms}`;
  const counter = () => {
    let n = 0;
    return () => `uuid-${++n}`;
  };

  it("turns every comment written on this device into an upload, once", () => {
    const comments = [localComment(1), localComment(2, { stepId: "step-2" })];
    const plan = planAdoption(comments, [], ADA, counter(), day);
    expect(plan.deleteCommentIds).toEqual([1, 2]);
    expect(plan.outbox).toEqual([
      { uid: "uuid-1", kind: "comment", projectId: P, stepId: "step-1", queuedBy: ADA.id, queuedAt: 100, text: "local 1", attempts: 0 },
      { uid: "uuid-2", kind: "comment", projectId: P, stepId: "step-2", queuedBy: ADA.id, queuedAt: 200, text: "local 2", attempts: 0 },
    ]);
  });

  it("finds nothing more to do once its plan has been applied", () => {
    const comments = [localComment(1), mirrored(5, serverComment("c1"))];
    const first = planAdoption(comments, [], ADA, counter(), day);
    const left = comments.filter((c) => !first.deleteCommentIds.includes(c.id as number));
    expect(planAdoption(left, [], ADA, counter(), day)).toEqual({ outbox: [], deleteCommentIds: [], deleteReviewIds: [] });
  });

  it("keeps the order the rows were written in, whatever order they are read in", () => {
    const comments = [localComment(3, { timestamp: 50 }), localComment(1, { timestamp: 50 }), localComment(2, { timestamp: 10 })];
    const plan = planAdoption(comments, [], ADA, counter(), day);
    expect(plan.outbox.map((o) => o.text)).toEqual(["local 2", "local 1", "local 3"]);
    // Strictly increasing times, so the upload order survives being stored and read back.
    expect(plan.outbox.map((o) => o.queuedAt)).toEqual([10, 50, 51]);
  });

  it("adds a note of origin only when the name on this device differs from the account's", () => {
    const comments = [
      localComment(1),
      localComment(2, { author: "Dr Khan", timestamp: 7 }),
      localComment(3, { author: "  Ada Lovelace " }),
      localComment(4, { author: "" }),
    ];
    const plan = planAdoption(comments, [], ADA, counter(), day);
    expect(plan.outbox.map((o) => o.text).sort()).toEqual(["[Written on this device as \"Dr Khan\" on day-7] local 2", "local 1", "local 3", "local 4"].sort());
  });

  it("treats a row with no origin as written on this device", () => {
    const legacy: Comment = { id: 9, projectId: P, stepId: "step-1", author: "Ada Lovelace", role: "researcher", text: "old", timestamp: 5 };
    expect(planAdoption([legacy], [], ADA, counter(), day).deleteCommentIds).toEqual([9]);
  });

  it("never touches copies of team rows", () => {
    const plan = planAdoption([mirrored(5, serverComment("c1"))], [mirrorReview(P, serverReview("step-1"))], ADA, counter(), day);
    expect(plan).toEqual({ outbox: [], deleteCommentIds: [], deleteReviewIds: [] });
  });

  it("turns a sign-off into an upload under the adopting account, made when the step had none", () => {
    const local: Review = { id: reviewKey(P, "step-1"), projectId: P, stepId: "step-1", status: "changes", reviewer: "Ada Lovelace", note: " redo ", timestamp: 300, origin: "local" };
    const plan = planAdoption([], [local], ADA, counter(), day);
    expect(plan.deleteReviewIds).toEqual(["proj-local:step-1"]);
    expect(plan.outbox).toEqual([
      {
        uid: reviewOutboxUid(P, "step-1", ADA.id),
        kind: "review",
        projectId: P,
        stepId: "step-1",
        queuedBy: ADA.id,
        queuedAt: 300,
        status: "changes",
        note: "redo",
        baseAt: null,
        attempts: 0,
      },
    ]);
  });

  it("says who a sign-off was recorded as when that is not the account's name", () => {
    const base: Review = { id: reviewKey(P, "step-1"), projectId: P, stepId: "step-1", status: "approved", reviewer: "Dr Khan", timestamp: 300, origin: "local" };
    expect(planAdoption([], [base], ADA, counter(), day).outbox[0].note).toBe('Recorded on this device as "Dr Khan" on day-300.');
    expect(planAdoption([], [{ ...base, note: "looks fine" }], ADA, counter(), day).outbox[0].note).toBe(
      'Recorded on this device as "Dr Khan" on day-300. looks fine',
    );
    expect(planAdoption([], [{ ...base, reviewer: "Ada Lovelace" }], ADA, counter(), day).outbox[0]).not.toHaveProperty("note");
  });

  it("does not put a sign-off written on this device over the account's own waiting sign-off for that step", () => {
    // Approved on this device while the project was kept here. After it went into the
    // account, and before this ran, the same person asked for changes: that is waiting.
    const local: Review = { id: reviewKey(P, "step-1"), projectId: P, stepId: "step-1", status: "approved", reviewer: "Dr Khan", timestamp: 300, origin: "local" };
    const other: Review = { id: reviewKey(P, "step-2"), projectId: P, stepId: "step-2", status: "approved", reviewer: "Ada Lovelace", timestamp: 310, origin: "local" };
    const waiting: OutboxItem = {
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
    };
    const plan = planAdoption([], [local, other], ADA, counter(), day, [waiting]);
    // The older verdict goes; nothing is queued in its place, so the waiting one stands.
    expect(plan.deleteReviewIds).toEqual([reviewKey(P, "step-1"), reviewKey(P, "step-2")]);
    expect(plan.outbox.map((o) => o.stepId)).toEqual(["step-2"]);

    // Somebody else's waiting sign-off on the same device is not this account's word.
    const bobs = { ...waiting, uid: reviewOutboxUid(P, "step-1", BOB.id), queuedBy: BOB.id };
    expect(planAdoption([], [local], ADA, counter(), day, [bobs]).outbox.map((o) => o.stepId)).toEqual(["step-1"]);
  });

  it("uploads comments before the sign-offs that followed them", () => {
    const review: Review = { id: reviewKey(P, "step-1"), projectId: P, stepId: "step-1", status: "approved", reviewer: "Ada Lovelace", timestamp: 150, origin: "local" };
    const plan = planAdoption([localComment(1), localComment(2)], [review], ADA, counter(), day);
    expect(plan.outbox.map((o) => [o.kind, o.queuedAt])).toEqual([
      ["comment", 100],
      ["comment", 200],
      ["review", 201],
    ]);
  });

  it("sends a comment that is longer than the account accepts in parts, losing nothing", () => {
    const long = "a".repeat(COMMENT_MAX) + "b".repeat(COMMENT_MAX) + "c".repeat(10);
    const plan = planAdoption([localComment(1, { text: long, author: "Dr Khan", timestamp: 7 })], [], ADA, counter(), day);
    const prefix = '[Written on this device as "Dr Khan" on day-7] ';
    expect(plan.outbox).toHaveLength(3);
    for (const o of plan.outbox) expect(charCount(o.text ?? "")).toBeLessThanOrEqual(COMMENT_MAX);
    expect(plan.outbox.map((o) => o.text).join("")).toBe(prefix + long);
    expect(plan.outbox[0].text?.startsWith(prefix)).toBe(true);
    expect(new Set(plan.outbox.map((o) => o.uid)).size).toBe(3);
    expect(plan.outbox.map((o) => o.queuedAt)).toEqual([7, 8, 9]);
    expect(plan.deleteCommentIds).toEqual([1]);
  });

  it("does not cut a long comment inside a character", () => {
    const long = "😀".repeat(COMMENT_MAX + 1);
    const plan = planAdoption([localComment(1, { text: long })], [], ADA, counter(), day);
    expect(plan.outbox.map((o) => charCount(o.text ?? ""))).toEqual([COMMENT_MAX, 1]);
    expect(plan.outbox.map((o) => o.text).join("")).toBe(long);
  });

  it("shortens a note that would be longer than the account accepts", () => {
    const review: Review = { id: reviewKey(P, "step-1"), projectId: P, stepId: "step-1", status: "approved", reviewer: "Dr Khan", note: "n".repeat(NOTE_MAX), timestamp: 1, origin: "local" };
    const note = planAdoption([], [review], ADA, counter(), day).outbox[0].note ?? "";
    expect(charCount(note)).toBe(NOTE_MAX);
    expect(note.startsWith('Recorded on this device as "Dr Khan" on day-1. nnn')).toBe(true);
    expect(note.endsWith("…")).toBe(true);
  });
});

describe("planLocalise", () => {
  const team = mirrored(5, serverComment("c1"));
  const teamReview = mirrorReview(P, serverReview("step-1", { status: "changes" }));

  it("turns the team's rows into ordinary rows of the copy kept on this device", () => {
    const plan = planLocalise([team, localComment(1)], [teamReview], [], ADA);
    expect(plan.updateComments).toEqual([{ id: 5, changes: { origin: "local", uid: undefined, authorId: undefined } }]);
    // The id from the account has to go: it is unique on this device and a fresh download of the project would want it.
    expect(Object.keys(plan.updateComments[0].changes)).toEqual(expect.arrayContaining(["uid", "authorId"]));
    expect(plan.putReviews).toEqual([
      { id: "proj-local:step-1", projectId: P, stepId: "step-1", status: "changes", reviewer: "Bob", timestamp: 5000, origin: "local" },
    ]);
    expect(plan.addComments).toEqual([]);
    expect(plan.removeOutbox).toEqual([]);
  });

  it("keeps what the person had written and not uploaded, as their own comments on that copy", () => {
    const waiting = [unsentComment("u2", { queuedAt: 20 }), unsentComment("u1", { queuedAt: 10, error: "not_found" })];
    const plan = planLocalise([], [], waiting, ADA);
    expect(plan.addComments).toEqual([
      { projectId: P, stepId: "step-1", author: "Ada Lovelace", text: "unsent u1", timestamp: 10, origin: "local" },
      { projectId: P, stepId: "step-1", author: "Ada Lovelace", text: "unsent u2", timestamp: 20, origin: "local" },
    ]);
    expect(plan.removeOutbox.map((o) => o.uid)).toEqual(["u1", "u2"]);
  });

  it("lets the person's waiting sign-off stand on the copy, in place of the team's", () => {
    const plan = planLocalise([], [teamReview], [unsentReview({ note: "good" })], ADA);
    expect(plan.putReviews).toEqual([
      { id: "proj-local:step-1", projectId: P, stepId: "step-1", status: "approved", reviewer: "Ada Lovelace", note: "good", timestamp: 9000, origin: "local" },
    ]);
    expect(plan.removeOutbox).toHaveLength(1);
  });

  it("drops a sign-off that was held back or refused: it never stood, and the team's stays", () => {
    const plan = planLocalise([], [teamReview], [unsentReview({ error: "superseded" })], ADA);
    expect(plan.putReviews.map((r) => [r.reviewer, r.status])).toEqual([["Bob", "changes"]]);
    expect(plan.removeOutbox).toHaveLength(1);
    // Even when that is all there is to do, there is something to do.
    const only = planLocalise([], [], [unsentReview({ error: "superseded" })], ADA);
    expect(only.putReviews).toEqual([]);
    expect(isEmptyLocalise(only)).toBe(false);
  });

  it("leaves what another account left waiting where it is", () => {
    const plan = planLocalise([], [], [unsentComment("u1", { queuedBy: BOB.id })], ADA);
    expect(isEmptyLocalise(plan)).toBe(true);
    expect(isEmptyLocalise(planLocalise([], [], [unsentComment("u1")], null))).toBe(true);
  });

  it("leaves rows written on this device alone", () => {
    const local: Review = { id: reviewKey(P, "step-2"), projectId: P, stepId: "step-2", status: "approved", reviewer: "Dr Khan", timestamp: 1, origin: "local" };
    expect(isEmptyLocalise(planLocalise([localComment(1)], [local], [], ADA))).toBe(true);
  });

  it("leaves nothing for adoption to skip: a localised copy can go into an account again in full", () => {
    const plan = planLocalise([team], [teamReview], [], ADA);
    const localised: Comment = { ...team, ...plan.updateComments[0].changes };
    const again = planAdoption([localised], plan.putReviews, ADA, () => "uuid", (ms) => `day-${ms}`);
    expect(again.outbox.map((o) => [o.kind, o.text ?? o.note])).toEqual([
      ["comment", '[Written on this device as "Bob" on day-1000] text of c1'],
      ["review", 'Recorded on this device as "Bob" on day-5000.'],
    ]);
  });
});

describe("planRehome", () => {
  // Bob took over the copy Ada wrote on. Ada has since been given a copy of her own.
  const taken = new Map<string, Link>([
    [P, link({ owner: BOB.id })],
    ["proj-ada-copy", link()],
  ]);

  it("moves the person's waiting items to their own copy of the same server project", () => {
    const comment = unsentComment("u1");
    const review = unsentReview();
    expect(planRehome([comment, review], taken, ADA.id)).toEqual([
      { item: comment, to: "proj-ada-copy" },
      { item: review, to: "proj-ada-copy" },
    ]);
  });

  it("leaves other people's items, and the person's items on their own projects", () => {
    expect(planRehome([unsentComment("u1", { queuedBy: BOB.id })], taken, ADA.id)).toEqual([]);
    expect(planRehome([unsentComment("u1", { projectId: "proj-ada-copy" })], taken, ADA.id)).toEqual([]);
    expect(planRehome([unsentComment("u1")], new Map([[P, link()]]), ADA.id)).toEqual([]);
  });

  it("leaves items where they are when the person has no copy of that project, or the copy is not in an account", () => {
    expect(planRehome([unsentComment("u1")], new Map([[P, link({ owner: BOB.id })]]), ADA.id)).toEqual([]);
    expect(planRehome([unsentComment("u1")], new Map<string, Link>([[P, { kind: "device", asked: true }]]), ADA.id)).toEqual([]);
    expect(planRehome([unsentComment("u1")], new Map<string, Link>([[P, link({ owner: BOB.id })], ["other", link({ serverId: "proj_other" })]]), ADA.id)).toEqual([]);
    expect(planRehome([unsentComment("u1")], new Map(), ADA.id)).toEqual([]);
  });
});

describe("shouldPull", () => {
  const idle = { hasUnsent: false, hasLocal: false, isActive: false, serverStamp: 5, seenStamp: 5 };

  it("is false when nothing is waiting, the project is not on screen and the marker has not moved", () => {
    expect(shouldPull(idle)).toBe(false);
    expect(shouldPull({ ...idle, serverStamp: null, seenStamp: null })).toBe(false);
    expect(shouldPull({ hasUnsent: false, isActive: false, serverStamp: 1, seenStamp: 1 })).toBe(false);
  });

  it("is true when there is something to upload", () => {
    expect(shouldPull({ ...idle, hasUnsent: true })).toBe(true);
    expect(shouldPull({ ...idle, hasLocal: true })).toBe(true);
  });

  it("is true for the project on screen", () => {
    expect(shouldPull({ ...idle, isActive: true })).toBe(true);
  });

  it("is true when the account's marker is not the one last read up to", () => {
    expect(shouldPull({ ...idle, serverStamp: 6 })).toBe(true);
    expect(shouldPull({ ...idle, seenStamp: null })).toBe(true);
    expect(shouldPull({ ...idle, serverStamp: 4 })).toBe(true);
  });
});

describe("isDue", () => {
  it("is true the first time and again once the gap has passed", () => {
    expect(isDue(1000, undefined, OPEN_SYNC_MS)).toBe(true);
    expect(isDue(1000 + OPEN_SYNC_MS - 1, 1000, OPEN_SYNC_MS)).toBe(false);
    expect(isDue(1000 + OPEN_SYNC_MS, 1000, OPEN_SYNC_MS)).toBe(true);
  });
});

describe("words", () => {
  it("says a waiting comment will send, and mentions being online only when offline", () => {
    expect(pendingHint(true)).toBe("Not uploaded yet. It will send when you are back online.");
    expect(pendingHint(false)).toBe("Not uploaded yet.");
  });

  it("explains a refused comment", () => {
    expect(describeUnsentError("comment", "forbidden")).toBe("Could not upload: you no longer have permission to comment on this project.");
    expect(describeUnsentError("comment", "not_found")).toBe("Could not upload: this project is no longer shared with you.");
    expect(describeUnsentError("comment", "invalid_input")).toBe("Could not upload: the comment is too long (5,000 characters at most).");
    expect(describeUnsentError("comment", "conflict")).toBe("Could not upload: the server did not accept it.");
    expect(describeUnsentError("comment", "constructor")).toBe("Could not upload: the server did not accept it.");
  });

  it("explains a sign-off that was held back or refused", () => {
    expect(describeUnsentError("review", "superseded")).toBe(
      "Your sign-off was not uploaded because someone else signed off this step while you were offline. Check theirs, then sign off again if it still applies.",
    );
    expect(describeUnsentError("review", "superseded_own")).toBe(
      "Your sign-off was not uploaded because you signed off this step somewhere else in the meantime. Check that one, then sign off again if it still applies.",
    );
    expect(describeUnsentError("review", "forbidden")).toBe("Could not upload your sign-off: only a project supervisor or the owner can sign off a step.");
    expect(describeUnsentError("review", "invalid_input")).toBe("Could not upload your sign-off: the note is too long (2,000 characters at most).");
    expect(describeUnsentError("review", "not_found")).toBe("Could not upload your sign-off: this project is no longer shared with you.");
    expect(describeUnsentError("review", "weird")).toBe("Could not upload your sign-off: the server did not accept it.");
  });

  it("tells a viewer or an editor why they cannot sign off", () => {
    expect(gateNote("viewer")).toBe(
      "Only a project supervisor or the owner can sign off a step. You are a Viewer on this project. The owner can change your role in Share.",
    );
    expect(gateNote("editor")).toBe(
      "Only a project supervisor or the owner can sign off a step. You are an Editor on this project. The owner can change your role in Share.",
    );
  });

  it("has the fixed notes", () => {
    expect(UNSENT_REVIEW_HINT).toBe("Your sign-off is saved on this device and has not been uploaded yet.");
    expect(READONLY_NOTE).toBe("Sign in to the account this project belongs to if you want to comment.");
    expect(HELD_NOTE).toBe("Your account is suspended, so new comments stay on this device until it is reactivated.");
  });

  it("says how fresh the team's side is", () => {
    const when = (ms: number) => `at ${ms}`;
    expect(teamSyncLine({ pulledAt: 5, offline: false }, when)).toBe("Synced with your team at 5.");
    expect(teamSyncLine({ pulledAt: null, offline: false }, when)).toBe("Not synced with your team yet.");
    expect(teamSyncLine({ pulledAt: null, offline: true }, when)).toBe("Not synced with your team yet.");
    expect(teamSyncLine({ pulledAt: 5, offline: true }, when)).toBe("Offline. Showing what was last synced (at 5).");
  });

  it("announces the state without the time, which moves on by itself", () => {
    expect(teamSyncAnnouncement({ pulledAt: 5, offline: false })).toBe("Synced with your team.");
    expect(teamSyncAnnouncement({ pulledAt: 999, offline: false })).toBe("Synced with your team.");
    expect(teamSyncAnnouncement({ pulledAt: null, offline: false })).toBe("Not synced with your team yet.");
    expect(teamSyncAnnouncement({ pulledAt: null, offline: true })).toBe("Not synced with your team yet.");
    expect(teamSyncAnnouncement({ pulledAt: 5, offline: true })).toBe("Offline. Showing what was last synced.");
  });

  it("uses no em-dashes and names no number of code digits", () => {
    const all = [
      pendingHint(true),
      pendingHint(false),
      UNSENT_REVIEW_HINT,
      READONLY_NOTE,
      HELD_NOTE,
      gateNote("viewer"),
      gateNote("editor"),
      teamSyncLine({ pulledAt: 1, offline: true }, () => "x"),
      teamSyncAnnouncement({ pulledAt: 1, offline: true }),
      teamSyncAnnouncement({ pulledAt: 1, offline: false }),
      ...["forbidden", "not_found", "invalid_input", "other", "superseded", "superseded_own"].flatMap((e) => [
        describeUnsentError("comment", e),
        describeUnsentError("review", e),
      ]),
    ];
    for (const sentence of all) {
      expect(sentence).not.toMatch(/[—–]/);
      expect(sentence).not.toMatch(/digit/i);
    }
  });
});
