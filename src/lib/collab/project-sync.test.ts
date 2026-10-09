import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "@/lib/db/schema";
import { SyncError } from "@/lib/supabase/errors";
import { TOMBSTONES_KEY, awaitsFirstUpload, getLink, isServerProjectId, listLinks, setLink, type AccountLink, type Link } from "./links";
import {
  EMPTY_CONTENT,
  FOCUS_SYNC_MS,
  MAX_CONTENT_BYTES,
  createProjectSync,
  deletionEffect,
  fingerprint,
  isBlank,
  linkUpdates,
  localIdForPull,
  parseContent,
  parseTombstones,
  planSync,
  serverMetaOf,
  sessionView,
  settleDeletion,
  settlePush,
  shouldSyncOnFocus,
  syncableMeta,
  tooLarge,
  withTombstone,
  withoutTombstone,
  type LocalMeta,
  type OpenProject,
  type ServerMeta,
  type SessionView,
  type SyncPorts,
} from "./project-sync";
import { canEdit, serializeContent, type ListedProject, type ProjectRole } from "./sync";

const ADA = "user-ada";
const BOB = "user-bob";

/** A linked local project whose server copy is known to exist. */
const linked = (localId: string, updatedAt: number, serverId: string, rev: number): LocalMeta => ({
  localId,
  updatedAt,
  link: { serverId, rev, created: true },
});
/** A server copy the signed-in person may upload to. */
const remote = (id: string, rev: number, updatedAt: number, canPush = true): ServerMeta => ({ id, rev, updatedAt, canPush });

describe("planSync", () => {
  it("creates a remote copy for a project with no record", () => {
    const local: LocalMeta[] = [{ localId: "p1", updatedAt: 100, link: null }];
    expect(planSync(local, [])).toEqual([{ type: "createRemote", localId: "p1" }]);
  });

  it("pulls a server-only project (fresh install)", () => {
    expect(planSync([], [remote("s1", 3, 500)])).toEqual([{ type: "pullNew", serverId: "s1", rev: 3 }]);
  });

  it("pushes when the local copy is newer", () => {
    expect(planSync([linked("p1", 900, "s1", 2)], [remote("s1", 2, 800)])).toEqual([
      { type: "push", localId: "p1", serverId: "s1", baseRev: 2 },
    ]);
  });

  it("pulls when the server rev advanced and is newer", () => {
    expect(planSync([linked("p1", 700, "s1", 2)], [remote("s1", 5, 900)])).toEqual([
      { type: "pull", localId: "p1", serverId: "s1", rev: 5 },
    ]);
  });

  it("is a noop when in sync", () => {
    expect(planSync([linked("p1", 800, "s1", 4)], [remote("s1", 4, 800)])).toEqual([]);
  });

  it("local newer wins over an advanced server rev (last-writer-wins)", () => {
    expect(planSync([linked("p1", 1000, "s1", 2)], [remote("s1", 9, 900)])).toEqual([
      { type: "push", localId: "p1", serverId: "s1", baseRev: 2 },
    ]);
  });

  it("detaches, and never re-creates, when the linked server copy disappeared", () => {
    expect(planSync([linked("p1", 100, "gone", 1)], [])).toEqual([{ type: "detach", localId: "p1", serverId: "gone" }]);
  });

  it("handles a mix of push, pull, create, detach and pullNew in one pass", () => {
    const local: LocalMeta[] = [
      linked("a", 900, "sa", 1), // newer -> push
      linked("b", 100, "sb", 1), // server newer -> pull
      { localId: "c", updatedAt: 50, link: null }, // no record -> createRemote
      linked("e", 50, "se", 2), // gone from the list -> detach
    ];
    const server: ServerMeta[] = [
      remote("sa", 1, 800),
      remote("sb", 4, 500),
      remote("sd", 2, 700), // server-only -> pullNew
    ];
    const actions = planSync(local, server);
    expect(actions).toContainEqual({ type: "push", localId: "a", serverId: "sa", baseRev: 1 });
    expect(actions).toContainEqual({ type: "pull", localId: "b", serverId: "sb", rev: 4 });
    expect(actions).toContainEqual({ type: "createRemote", localId: "c" });
    expect(actions).toContainEqual({ type: "detach", localId: "e", serverId: "se" });
    expect(actions).toContainEqual({ type: "pullNew", serverId: "sd", rev: 2 });
    expect(actions).toHaveLength(5);
  });

  it("repeats the create for a link the server has not confirmed, whether or not it arrived", () => {
    const local: LocalMeta[] = [{ localId: "p1", updatedAt: 100, link: { serverId: "s1", rev: 0, created: false } }];
    // The request never arrived.
    expect(planSync(local, [])).toEqual([{ type: "createRemote", localId: "p1" }]);
    // It arrived but the answer was lost: no second copy is downloaded.
    expect(planSync(local, [remote("s1", 0, 0)])).toEqual([{ type: "createRemote", localId: "p1" }]);
  });

  it("uploads to a server copy that has no content yet", () => {
    expect(planSync([linked("p1", 100, "s1", 0)], [remote("s1", 0, 0)])).toEqual([
      { type: "push", localId: "p1", serverId: "s1", baseRev: 0 },
    ]);
  });

  it("never pushes for a viewer or supervisor, however new the local copy", () => {
    expect(planSync([linked("p1", 9999, "s1", 2)], [remote("s1", 2, 800, false)])).toEqual([]);
  });

  it("pulls for a viewer when the server revision advanced, even over later local edits", () => {
    expect(planSync([linked("p1", 9999, "s1", 2)], [remote("s1", 3, 800, false)])).toEqual([
      { type: "pull", localId: "p1", serverId: "s1", rev: 3 },
    ]);
  });

  it("does not download a project that was deleted on this device", () => {
    const server = [remote("s1", 3, 500), remote("s2", 1, 100)];
    expect(planSync([], server, ["s1"])).toEqual([{ type: "pullNew", serverId: "s2", rev: 1 }]);
    expect(planSync([], server, new Set(["s1", "s2"]))).toEqual([]);
  });

  it("never pulls at the revision this device last synced from, whatever the two clocks say", () => {
    // The server's stamp is ahead of this device's clock. The copy there is still the one synced from.
    expect(planSync([linked("p1", 1500, "s1", 3)], [remote("s1", 3, 2000)])).toEqual([
      { type: "push", localId: "p1", serverId: "s1", baseRev: 3 },
    ]);
    // A viewer has nothing to upload either way.
    expect(planSync([linked("p1", 1500, "s1", 3)], [remote("s1", 3, 2000, false)])).toEqual([]);
  });

  it("leaves a project alone while its deletion is on its way", () => {
    expect(planSync([linked("p1", 900, "s1", 2)], [remote("s1", 2, 800)], ["s1"])).toEqual([]);
    expect(planSync([linked("p1", 900, "s1", 2)], [], ["s1"])).toEqual([]);
  });
});

const accountLink = (over: Partial<AccountLink> = {}): AccountLink => ({
  kind: "account",
  owner: ADA,
  serverId: "s1",
  rev: 1,
  created: true,
  role: "owner",
  ...over,
});

describe("what reaches the planner", () => {
  const projects = [
    { id: "mine", updatedAt: 10 },
    { id: "new", updatedAt: 20 },
    { id: "pinned", updatedAt: 30 },
    { id: "asked", updatedAt: 40 },
    { id: "bobs", updatedAt: 50 },
  ];
  const links = new Map<string, Link>([
    ["mine", accountLink({ serverId: "s-mine", rev: 4 })],
    ["pinned", { kind: "device", asked: false }],
    ["asked", { kind: "device", asked: true }],
    ["bobs", accountLink({ owner: BOB, serverId: "s-bobs" })],
  ]);

  it("passes only the signed-in account's projects and new ones", () => {
    expect(syncableMeta(projects, links, ADA)).toEqual([
      { localId: "mine", updatedAt: 10, link: { serverId: "s-mine", rev: 4, created: true } },
      { localId: "new", updatedAt: 20, link: null },
    ]);
  });

  it("plans nothing for pinned projects or another account's projects", () => {
    const pinnedAndForeign = projects.filter((p) => ["pinned", "asked", "bobs"].includes(p.id));
    // Bob's project is even in the server list: it still is not Ada's to touch here.
    const actions = planSync(syncableMeta(pinnedAndForeign, links, ADA), []);
    expect(actions).toEqual([]);
  });

  it("reads the edit time and the right to upload from the server list", () => {
    const row = (over: Partial<ListedProject>): ListedProject => ({
      id: "s1",
      title: "T",
      study_type: "cohort",
      owner_id: ADA,
      role: "owner",
      rev: 2,
      content_updated_at: 700,
      created_at: 1,
      updated_at: 99999,
      collab_updated_at: null,
      ...over,
    });
    expect(serverMetaOf([row({}), row({ id: "s2", role: "viewer" }), row({ id: "s3", role: "supervisor" }), row({ id: "s4", role: "editor" })])).toEqual([
      { id: "s1", rev: 2, updatedAt: 700, canPush: true },
      { id: "s2", rev: 2, updatedAt: 700, canPush: false },
      { id: "s3", rev: 2, updatedAt: 700, canPush: false },
      { id: "s4", rev: 2, updatedAt: 700, canPush: true },
    ]);
    // Never uploaded: 0, not the server's own clock.
    expect(serverMetaOf([row({ rev: 0, content_updated_at: null })])[0].updatedAt).toBe(0);
  });
});

describe("linkUpdates", () => {
  it("changes nothing for links that are already right", () => {
    const links = new Map<string, Link>([["a", accountLink()]]);
    expect(linkUpdates(links, [{ id: "s1", role: "owner" }], ADA).size).toBe(0);
  });

  it("keeps the role fresh", () => {
    const links = new Map<string, Link>([["a", accountLink({ role: "editor", rev: 7, synced: "x" })]]);
    expect(linkUpdates(links, [{ id: "s1", role: "viewer" }], ADA)).toEqual(
      new Map([["a", accountLink({ role: "viewer", rev: 7, synced: "x" })]]),
    );
  });

  it("re-owns another account's link to a project that is in this person's list", () => {
    // Same role for both people, so the owner is the only thing that differs.
    const links = new Map<string, Link>([["a", accountLink({ owner: BOB, role: "editor", rev: 5 })]]);
    expect(linkUpdates(links, [{ id: "s1", role: "editor" }], ADA)).toEqual(new Map([["a", accountLink({ owner: ADA, role: "editor", rev: 5 })]]));
  });

  it("confirms a link once its project shows up in the list", () => {
    const links = new Map<string, Link>([["a", accountLink({ created: false, rev: 0 })]]);
    expect(linkUpdates(links, [{ id: "s1", role: "owner" }], ADA).get("a")?.created).toBe(true);
  });

  it("does not take over a copy that holds work its owner has not uploaded", () => {
    const links = new Map<string, Link>([["a", accountLink({ owner: BOB, role: "editor" })]]);
    const asked: string[] = [];
    const out = linkUpdates(links, [{ id: "s1", role: "editor" }], ADA, (localId, link) => {
      asked.push(`${localId}:${link.owner}`);
      return false;
    });
    expect(out.size).toBe(0);
    expect(asked).toEqual([`a:${BOB}`]);
  });

  it("does not take over a second copy of a project this person already has here", () => {
    const links = new Map<string, Link>([
      ["bobs-copy", accountLink({ owner: BOB })],
      ["mine", accountLink({ owner: ADA })],
    ]);
    expect(linkUpdates(links, [{ id: "s1", role: "owner" }], ADA).size).toBe(0);
    // Two foreign copies of one project: only the first is taken.
    const two = new Map<string, Link>([
      ["copy-1", accountLink({ owner: BOB })],
      ["copy-2", accountLink({ owner: "user-cy" })],
    ]);
    expect([...linkUpdates(two, [{ id: "s1", role: "owner" }], ADA).keys()]).toEqual(["copy-1"]);
  });

  it("never asks whether the person's own copy is clean", () => {
    const links = new Map<string, Link>([["a", accountLink({ role: "viewer" })]]);
    const out = linkUpdates(links, [{ id: "s1", role: "editor" }], ADA, () => {
      throw new Error("not for an own link");
    });
    expect(out.get("a")?.role).toBe("editor");
  });

  it("does not take over another account's copy of a project this person is leaving", () => {
    const links = new Map<string, Link>([["a", accountLink({ owner: BOB, role: "editor" })]]);
    const listed = [{ id: "s1", role: "editor" as const }];
    expect(linkUpdates(links, listed, ADA, () => true, new Set(["s1"])).size).toBe(0);
    expect(linkUpdates(links, listed, ADA, () => true, new Set(["s-other"])).size).toBe(1);
  });

  it("leaves pins and links to projects outside the list alone", () => {
    const links = new Map<string, Link>([
      ["pin", { kind: "device", asked: true }],
      ["bobs", accountLink({ owner: BOB, serverId: "elsewhere" })],
    ]);
    expect(linkUpdates(links, [{ id: "s1", role: "owner" }], ADA).size).toBe(0);
  });
});

describe("content helpers", () => {
  it("reads a content document", () => {
    const raw = JSON.stringify({ stepData: { q: { pico: "x" } }, stepStatus: { q: { complete: true, needsAttention: false } } });
    expect(parseContent(raw)).toEqual({ stepData: { q: { pico: "x" } }, stepStatus: { q: { complete: true, needsAttention: false } } });
  });

  it("refuses anything that is not a content document", () => {
    for (const raw of [null, undefined, "", "not json", "[]", "null", '"text"', '{"stepData":{}}', '{"stepData":[],"stepStatus":{}}', '{"stepData":{},"stepStatus":null}']) {
      expect(parseContent(raw)).toBeNull();
    }
  });

  it("fingerprints equal content equally and different content differently", () => {
    const a = serializeContent({ stepData: { q: { a: 1 } }, stepStatus: {} });
    const b = serializeContent({ stepData: { q: { a: 2 } }, stepStatus: {} });
    expect(fingerprint(a)).toBe(fingerprint(serializeContent({ stepData: { q: { a: 1 } }, stepStatus: {} })));
    expect(fingerprint(a)).not.toBe(fingerprint(b));
    expect(fingerprint("")).not.toBe(fingerprint(" "));
    // Same length, one character swapped.
    expect(fingerprint("abcd")).not.toBe(fingerprint("abdc"));
  });

  it("uploads only content that changed, and takes the server copy when it moved on", () => {
    expect(settlePush(false, 5, 2)).toBe("push");
    expect(settlePush(false, 2, 2)).toBe("push");
    expect(settlePush(true, 5, 2)).toBe("pull");
    expect(settlePush(true, 2, 2)).toBe("skip");
  });

  it("tells a project with nothing in it from one that holds work", () => {
    expect(isBlank(EMPTY_CONTENT)).toBe(true);
    expect(isBlank({ stepData: {}, stepStatus: {} })).toBe(true);
    expect(isBlank({ stepData: { q: "" }, stepStatus: {} })).toBe(false);
    expect(isBlank({ stepData: {}, stepStatus: { q: { complete: true, needsAttention: false } } })).toBe(false);
  });

  it("measures a document in bytes, as the account does", () => {
    expect(MAX_CONTENT_BYTES).toBe(20 * 1024 * 1024);
    expect(tooLarge("x".repeat(10), 10)).toBe(false);
    expect(tooLarge("x".repeat(11), 10)).toBe(true);
    // Three characters, nine bytes.
    expect(tooLarge("\u20ac\u20ac\u20ac", 9)).toBe(false);
    expect(tooLarge("\u20ac\u20ac\u20ac", 8)).toBe(true);
    // Short enough that no character count can exceed the limit: not measured further.
    expect(tooLarge("\u20ac", 3)).toBe(false);
    expect(tooLarge("", 0)).toBe(false);
  });

  it("uses the server id as the local id unless a project already has it", () => {
    const fresh = (() => {
      const ids = ["s1", "f1", "f2"];
      return () => ids.shift()!;
    })();
    expect(localIdForPull("s1", new Set(["x"]), fresh)).toBe("s1");
    // Taken (a detached copy): a fresh id, skipping ones that are taken too.
    expect(localIdForPull("s1", new Set(["s1", "f1"]), fresh)).toBe("f2");
  });
});

describe("tombstones", () => {
  it("reads the stored queue and drops what is not a tombstone", () => {
    const raw = JSON.stringify([
      { serverId: "s1", owner: ADA, action: "delete" },
      { serverId: "", owner: ADA, action: "delete" },
      { serverId: "s2", action: "leave" },
      "x",
      null,
      { serverId: "s1", owner: ADA, action: "delete" },
      { serverId: "s3", owner: ADA, action: "leave" },
    ]);
    expect(parseTombstones(raw)).toEqual([
      { serverId: "s1", owner: ADA, action: "delete" },
      { serverId: "s3", owner: ADA, action: "leave" },
    ]);
    for (const bad of [null, undefined, "", "nope", "{}", "3"]) expect(parseTombstones(bad)).toEqual([]);
  });

  it("reads one that does not say what was confirmed, or says something else, as a leave", () => {
    const raw = JSON.stringify([{ serverId: "s1", owner: ADA }, { serverId: "s2", owner: ADA, action: "everything" }]);
    expect(parseTombstones(raw)).toEqual([
      { serverId: "s1", owner: ADA, action: "leave" },
      { serverId: "s2", owner: ADA, action: "leave" },
    ]);
  });

  it("adds once and removes by server id and account", () => {
    const one = withTombstone([], { serverId: "s1", owner: ADA, action: "delete" });
    expect(withTombstone(one, { serverId: "s1", owner: ADA, action: "delete" })).toEqual(one);
    const two = withTombstone(one, { serverId: "s1", owner: BOB, action: "leave" });
    expect(two).toHaveLength(2);
    expect(withoutTombstone(two, { serverId: "s1", owner: ADA, action: "delete" })).toEqual([{ serverId: "s1", owner: BOB, action: "leave" }]);
  });
});

describe("deletionEffect", () => {
  it("says what deleting a project here does to the account", () => {
    expect(deletionEffect(null)).toBe("device");
    expect(deletionEffect(undefined)).toBe("device");
    expect(deletionEffect({ kind: "device", asked: true })).toBe("device");
    expect(deletionEffect(accountLink({ role: "owner" }))).toBe("everyone");
    for (const role of ["editor", "viewer", "supervisor"] as const) expect(deletionEffect(accountLink({ role }))).toBe("leave");
  });
});

describe("settleDeletion", () => {
  it("carries out what the link says when that is what was asked about, or nothing was said", () => {
    for (const effect of ["device", "leave", "everyone"] as const) {
      expect(settleDeletion(effect, effect)).toBe(effect);
      expect(settleDeletion(effect, undefined)).toBe(effect);
    }
  });

  it("never does more than was asked about", () => {
    // Asked to leave, an owner by now: still a leave, never a delete for everyone.
    expect(settleDeletion("everyone", "leave")).toBe("leave");
    // Asked about a project on this device only, and it is in an account by now: nothing.
    expect(settleDeletion("leave", "device")).toBeNull();
    expect(settleDeletion("everyone", "device")).toBeNull();
  });

  it("does what is still possible when less is", () => {
    // Asked to delete for everyone, no longer an owner: leaving is what is left.
    expect(settleDeletion("leave", "everyone")).toBe("leave");
    // The server copy went away meanwhile: only the copy here is removed.
    expect(settleDeletion("device", "everyone")).toBe("device");
    expect(settleDeletion("device", "leave")).toBe("device");
  });
});

describe("triggers", () => {
  it("syncs on focus at most once a minute", () => {
    expect(FOCUS_SYNC_MS).toBe(60_000);
    expect(shouldSyncOnFocus(100_000, 100_000 - 59_999)).toBe(false);
    expect(shouldSyncOnFocus(100_000, 100_000 - 60_000)).toBe(true);
    expect(shouldSyncOnFocus(100_000, -Infinity)).toBe(true);
  });

  it("syncs only for a signed-in person whose password is settled", () => {
    const profile = { id: ADA, email: "a@example.test", name: "Ada", institution: "", role: "researcher", status: "active", mustSetPassword: false, createdAt: 1 } as const;
    const device = { id: ADA, email: "a@example.test", name: "Ada" };
    const settled = { passwordPending: false };
    expect(sessionView({ phase: "ready", profile, deviceAccount: device, ...settled })).toEqual({ userId: ADA, signedInId: ADA, deviceAccountId: ADA });
    expect(sessionView({ phase: "ready", profile: { ...profile, mustSetPassword: true }, deviceAccount: device, ...settled })).toEqual({
      userId: null,
      signedInId: ADA,
      deviceAccountId: ADA,
    });
    // A code was accepted and the password is not settled yet: the account may
    // still open with a password somebody else set, so nothing is uploaded into it.
    expect(sessionView({ phase: "ready", profile, deviceAccount: device, passwordPending: true })).toEqual({
      userId: null,
      signedInId: ADA,
      deviceAccountId: ADA,
    });
    // Signed out without asking: the account's projects stay on show, but nothing syncs.
    expect(sessionView({ phase: "anon", profile: null, deviceAccount: device, ...settled })).toEqual({ userId: null, signedInId: null, deviceAccountId: ADA });
    expect(sessionView({ phase: "loading", profile: null, deviceAccount: null, ...settled })).toEqual({ userId: null, signedInId: null, deviceAccountId: null });
    expect(sessionView({ phase: "unconfigured", profile: null, deviceAccount: null, ...settled }).userId).toBeNull();
  });
});

// --- The engine, driven with hand-written stand-ins for the backend and the app ----

interface ServerRow {
  id: string;
  title: string;
  study_type: string;
  role: ProjectRole;
  rev: number;
  content: string | null;
  content_updated_at: number | null;
}

type Op = "list" | "create" | "get" | "put" | "delete" | "leave";

const notFound = () => new SyncError(404, "not_found");
const offline = () => new SyncError(0, "offline");

const project = (id: string, over: Partial<Project> = {}): Project => ({
  id,
  title: `Title of ${id}`,
  studyType: "cohort",
  stepData: {},
  stepStatus: {},
  createdAt: 1,
  updatedAt: 100,
  ...over,
});

function harness(session: SessionView = { userId: null, signedInId: null, deviceAccountId: null }, options: { maxContentBytes?: number } = {}) {
  const calls: string[] = [];
  const rows = new Map<string, ServerRow>();
  const fail: Partial<Record<Op, SyncError | null>> = {};
  const hooks: {
    onCreate?: (id: string) => void;
    afterList?: () => void;
    beforePut?: () => void;
    /** Runs when the engine reads one project from the device. */
    onLocalGet?: (id: string) => void;
    getContent?: Promise<void>;
    /** The list has been read on the server; its answer does not arrive until this resolves. */
    listHold?: Promise<void>;
    /** Runs at the start of every request. It may wait, or throw to refuse that one request. */
    before?: (op: Op, id?: string) => void | Promise<void>;
  } = {};
  const check = (op: Op) => {
    const e = fail[op];
    if (e) throw e;
  };
  const listed = (r: ServerRow): ListedProject => ({
    id: r.id,
    title: r.title,
    study_type: r.study_type,
    owner_id: ADA,
    role: r.role,
    rev: r.rev,
    content_updated_at: r.content_updated_at,
    created_at: 5,
    updated_at: 5,
    collab_updated_at: null,
  });

  const api: SyncPorts["api"] = {
    async listProjects() {
      calls.push("list");
      await hooks.before?.("list");
      check("list");
      const projects = [...rows.values()].map(listed);
      hooks.afterList?.();
      await hooks.listHold;
      return { projects };
    },
    async createProject(id: string, title: string, studyType: string) {
      calls.push(`create:${id}`);
      await hooks.before?.("create", id);
      hooks.onCreate?.(id);
      if (!rows.has(id)) rows.set(id, { id, title, study_type: studyType, role: "owner", rev: 0, content: null, content_updated_at: null });
      check("create"); // after the row exists: the answer is what gets lost
      return { project: listed(rows.get(id)!) };
    },
    async getContent(id) {
      calls.push(`get:${id}`);
      await hooks.before?.("get", id);
      check("get");
      await hooks.getContent;
      const r = rows.get(id);
      if (!r) throw notFound();
      return { content: r.content, rev: r.rev, updatedAt: r.content_updated_at };
    },
    async putContent(id, payload) {
      calls.push(`put:${id}`);
      await hooks.before?.("put", id);
      hooks.beforePut?.();
      check("put");
      const r = rows.get(id);
      if (!r) throw notFound();
      if (!canEdit(r.role)) throw new SyncError(403, "forbidden");
      if (r.rev > payload.baseRev && (r.content_updated_at ?? 0) > payload.updatedAt) {
        throw new SyncError(409, "conflict", { content: r.content, rev: r.rev, updatedAt: r.content_updated_at });
      }
      r.content = payload.content ?? serializeContent(payload);
      r.rev += 1;
      r.content_updated_at = payload.updatedAt;
      return { ok: true as const, rev: r.rev };
    },
    async deleteProject(id) {
      calls.push(`delete:${id}`);
      await hooks.before?.("delete", id);
      check("delete");
      if (!rows.delete(id)) throw notFound();
      return { ok: true as const };
    },
    async leaveProject(id) {
      calls.push(`leave:${id}`);
      await hooks.before?.("leave", id);
      check("leave");
      if (!rows.delete(id)) throw notFound();
      return { ok: true as const };
    },
  };

  // What is on the device.
  const local = new Map<string, Project>();
  const state = { clock: 1_000, online: true, open: null as Project | null, step: "", persisted: 0, closed: 0, rechecks: 0, refreshed: 0, cleared: 0, listFails: 0, afterSyncThrows: false };
  /** How long each coming read of the device's project list takes, first read first. Default: no time. */
  const listDelays: number[] = [];
  const reloads: Array<[string, string]> = [];

  const editorListeners = new Set<(next: Project | null, prev: Project | null) => void>();
  const setOpen = (next: Project | null) => {
    const prev = state.open;
    state.open = next;
    for (const listener of [...editorListeners]) listener(next, prev);
  };
  const editor: OpenProject = {
    current: () => ({ project: state.open, stepId: state.step }),
    subscribe: (listener) => {
      editorListeners.add(listener);
      return () => editorListeners.delete(listener);
    },
    persist: async () => {
      state.persisted += 1;
      if (state.open) local.set(state.open.id, { ...state.open, updatedAt: state.clock });
    },
    reload: async (id, stepId) => {
      reloads.push([id, stepId]);
      const p = local.get(id);
      if (!p) return;
      state.step = stepId;
      setOpen(structuredClone(p));
    },
    close: () => {
      state.closed += 1;
      setOpen(null);
    },
  };

  // The person using the runner.
  const ui = {
    open(id: string, step = "step-1") {
      state.step = step;
      setOpen(structuredClone(local.get(id)!));
    },
    type(field: string, value: unknown) {
      if (!state.open) throw new Error("no project is open");
      setOpen({ ...state.open, stepData: { ...state.open.stepData, [field]: value } });
    },
    goToStep(step: string) {
      state.step = step;
      setOpen(state.open); // the runner's state changed; the project did not
    },
    /** The runner saves the open project to the device by itself, whether or not it may be uploaded. */
    save() {
      if (state.open) local.set(state.open.id, { ...structuredClone(state.open), updatedAt: state.clock });
    },
    create(p: Project) {
      local.set(p.id, p);
      state.step = "step-1";
      setOpen(structuredClone(p));
    },
  };

  let view = session;
  const sessionListeners = new Set<() => void>();
  const setView = (next: SessionView) => {
    view = next;
    for (const listener of [...sessionListeners]) listener();
  };
  const account = {
    signIn: (id: string) => setView({ userId: id, signedInId: id, deviceAccountId: id }),
    signInWithoutPassword: (id: string) => setView({ userId: null, signedInId: id, deviceAccountId: id }),
    signOut: () => setView({ userId: null, signedInId: null, deviceAccountId: null }),
    expire: () => setView({ userId: null, signedInId: null, deviceAccountId: view.deviceAccountId }),
  };

  const deviceListeners = { online: new Set<() => void>(), offline: new Set<() => void>(), focus: new Set<() => void>() };
  const on = (set: Set<() => void>) => (listener: () => void) => {
    set.add(listener);
    return () => set.delete(listener);
  };
  const fire = (kind: keyof typeof deviceListeners) => {
    for (const listener of [...deviceListeners[kind]]) listener();
  };

  let accepted: (() => Promise<void>) | null = null;
  const afterSync: string[][] = [];

  const engine = createProjectSync({
    api,
    projects: {
      list: async () => {
        if (state.listFails > 0) {
          state.listFails -= 1;
          throw new Error("the device's storage is not available");
        }
        const delay = listDelays.shift();
        if (delay !== undefined) await new Promise((resolve) => setTimeout(resolve, delay));
        return [...local.values()].map((p) => structuredClone(p));
      },
      get: async (id) => {
        hooks.onLocalGet?.(id);
        const p = local.get(id);
        return p ? structuredClone(p) : undefined;
      },
      put: async (p) => void local.set(p.id, structuredClone(p)),
      update: async (id, patch) => {
        const p = local.get(id);
        if (p) local.set(id, { ...p, ...structuredClone(patch) });
      },
      remove: async (id) => {
        local.delete(id);
        if (state.open?.id === id) setOpen(null);
      },
    },
    editor,
    session: {
      get: () => view,
      subscribe: (listener) => {
        sessionListeners.add(listener);
        return () => sessionListeners.delete(listener);
      },
      recheck: () => void (state.rechecks += 1),
    },
    invitations: {
      refresh: async () => void (state.refreshed += 1),
      clear: () => void (state.cleared += 1),
      onAccepted: (listener) => {
        accepted = listener;
        return () => {
          accepted = null;
        };
      },
    },
    device: {
      online: () => state.online,
      now: () => state.clock,
      onOnline: on(deviceListeners.online),
      onOffline: on(deviceListeners.offline),
      onFocus: on(deviceListeners.focus),
    },
    storage: localStorage,
    pushDelayMs: 0,
    ...(options.maxContentBytes !== undefined ? { maxContentBytes: options.maxContentBytes } : {}),
    afterSync: (rows) => {
      afterSync.push(rows.map((r) => r.id));
      if (state.afterSyncThrows) throw new Error("a layer on top failed");
    },
  });

  /** Let timers and everything they start finish. */
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  /** Wait for the sync that is running (the one a sign-in started) without asking for another. */
  const synced = async () => {
    await settle();
    if (view.userId) await engine.start(view.userId);
    await settle();
  };

  return {
    engine,
    api,
    calls,
    rows,
    fail,
    hooks,
    local,
    state,
    listDelays,
    afterSync,
    reloads,
    ui,
    account,
    fire,
    settle,
    synced,
    status: () => engine.status.getState(),
    count: (prefix: string) => calls.filter((c) => c === prefix || c.startsWith(`${prefix}:`)).length,
    acceptInvitation: () => accepted?.(),
    serverRow: (id: string, over: Partial<ServerRow> = {}) => {
      const row: ServerRow = { id, title: `Server ${id}`, study_type: "cohort", role: "owner", rev: 1, content: content({ a: 1 }), content_updated_at: 500, ...over };
      rows.set(id, row);
      return row;
    },
  };
}

const content = (stepData: Record<string, unknown>) => serializeContent({ stepData, stepStatus: {} });
const signedIn = (id: string): SessionView => ({ userId: id, signedInId: id, deviceAccountId: id });

describe("sync engine", () => {
  afterEach(() => localStorage.clear());

  it("pins guest projects when someone signs in, before the first sync, and uploads nothing", async () => {
    const h = harness();
    h.local.set("guest", project("guest"));
    h.engine.bind();
    const before = h.status().revision;
    // Reading the device's projects for the pin is slow, as it can be on a real device.
    h.listDelays.push(20);

    h.account.signIn(ADA);
    await h.synced();

    expect(getLink("guest")).toEqual({ kind: "device", asked: false });
    expect(h.count("list")).toBe(1);
    expect(h.count("create")).toBe(0);
    expect(h.rows.size).toBe(0);
    expect(h.status().revision).toBeGreaterThan(before);
    expect(h.status().state).toBe("idle");
  });

  it("does not let an edit made right after signing in slip a guest project into the account", async () => {
    const h = harness();
    h.local.set("guest", project("guest"));
    h.engine.bind();
    h.ui.open("guest");
    h.listDelays.push(20);

    h.account.signIn(ADA);
    h.ui.type("q", "typed before the pin was written");
    h.ui.create(project("also-guest")); // made in the same moment: not this account's either
    await h.synced();

    expect(getLink("guest")).toEqual({ kind: "device", asked: false });
    expect(getLink("also-guest")).toEqual({ kind: "device", asked: false });
    expect(h.count("create")).toBe(0);
    expect(h.count("put")).toBe(0);
  });

  it("keeps guest work out while the device's projects cannot be read, and pins it once they can", async () => {
    const h = harness();
    h.local.set("guest", project("guest"));
    h.engine.bind();
    h.ui.open("guest");
    h.state.listFails = 2; // the pin at sign-in, and the first sync's own attempt

    h.account.signIn(ADA);
    await h.synced();
    expect(getLink("guest")).toBeNull();
    expect(h.count("list")).toBe(0); // the sync did not go on without the pin
    expect(h.status()).toMatchObject({ state: "error", errorCode: "storage_error" });

    // Typing, and asking to add it to the account, do not get it through either.
    h.state.listFails = 2;
    h.ui.type("q", "typed while the pin could not be written");
    await h.settle();
    await expect(h.engine.ensureRemote("guest")).rejects.toThrow();
    expect(h.state.listFails).toBe(0);
    expect(h.count("create")).toBe(0);
    expect(h.count("put")).toBe(0);
    expect(h.status()).toMatchObject({ state: "error", errorCode: "storage_error" });

    await h.engine.reconcile();
    expect(getLink("guest")).toEqual({ kind: "device", asked: false });
    expect(h.count("create")).toBe(0);
    expect(h.status().state).toBe("idle");
  });

  it("says so when the device's projects cannot be read during a sync, and recovers", async () => {
    const h = harness(signedIn(ADA));
    h.serverRow("s1");
    h.state.listFails = 1;
    h.engine.bind();
    await h.synced();
    expect(h.status()).toMatchObject({ state: "error", errorCode: "storage_error", lastSyncedAt: null });
    expect(h.local.size).toBe(0);

    await h.engine.reconcile();
    expect(h.status().state).toBe("idle");
    expect(h.local.has("s1")).toBe(true);
  });

  it("uploads a project with no record when the app launches already signed in", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1", { stepData: { q: "mine" } }));
    h.engine.bind();
    await h.synced();

    const link = getLink("p1") as AccountLink;
    expect(link).toMatchObject({ kind: "account", owner: ADA, created: true, role: "owner", rev: 1 });
    expect(isServerProjectId(link.serverId)).toBe(true);
    expect(h.rows.get(link.serverId)).toMatchObject({ rev: 1, content: content({ q: "mine" }), content_updated_at: 100 });
    expect(link.synced).toBe(fingerprint(content({ q: "mine" })));
  });

  it("writes the link, with the new server id, before the create request goes out", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1"));
    let atRequest: Link | null = null;
    let requested = "";
    h.hooks.onCreate = (id) => {
      requested = id;
      atRequest = getLink("p1");
    };
    h.engine.bind();
    await h.synced();

    expect(atRequest).toEqual({ kind: "account", owner: ADA, serverId: requested, rev: 0, created: false, role: "owner" });
  });

  it("asks for the same project again after a lost answer, and ends with one copy", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1"));
    h.fail.create = new SyncError(0, "network");
    h.engine.bind();
    await h.synced();

    const first = getLink("p1") as AccountLink;
    expect(first.created).toBe(false);
    expect(h.status().state).toBe("offline");

    h.fail.create = null;
    await h.engine.reconcile();

    const creates = h.calls.filter((c) => c.startsWith("create:"));
    expect(new Set(creates)).toEqual(new Set([`create:${first.serverId}`]));
    expect(getLink("p1")).toMatchObject({ serverId: first.serverId, created: true, rev: 1 });
    expect(h.rows.size).toBe(1);
    expect(h.local.size).toBe(1);
  });

  it("gives a project made while signed in an account link at once, then uploads it", async () => {
    const h = harness(signedIn(ADA));
    h.engine.bind();
    await h.synced();

    h.ui.create(project("fresh", { stepData: { q: 1 } }));
    await Promise.resolve();
    await Promise.resolve();
    expect(getLink("fresh")).toMatchObject({ kind: "account", owner: ADA, created: false });
    await h.settle();

    const link = getLink("fresh") as AccountLink;
    expect(link).toMatchObject({ created: true, rev: 1 });
    expect(h.rows.get(link.serverId)?.content).toBe(content({ q: 1 }));
  });

  it("downloads the account's projects onto a second device, with the role on the link", async () => {
    const h = harness(signedIn(ADA));
    h.serverRow("s1", { rev: 4, content: content({ q: "from the other device" }), content_updated_at: 700, role: "editor" });
    h.serverRow("s2", { rev: 0, content: null, content_updated_at: null });
    h.engine.bind();
    await h.synced();

    expect(h.local.get("s1")).toMatchObject({ id: "s1", title: "Server s1", studyType: "cohort", stepData: { q: "from the other device" }, updatedAt: 700 });
    expect(getLink("s1")).toMatchObject({ kind: "account", owner: ADA, serverId: "s1", rev: 4, created: true, role: "editor" });
    // Nobody has uploaded s2 yet: it must not look edited here.
    expect(h.local.get("s2")).toMatchObject({ stepData: {}, updatedAt: 0 });
    expect(h.count("put")).toBe(0);
    // A second sync finds nothing to do.
    await h.engine.reconcile();
    expect(h.count("get")).toBe(2);
    expect(h.count("put")).toBe(0);
  });

  it("does not overwrite a detached copy that has the server project's id", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("s1", project("s1", { stepData: { q: "my detached copy" } }));
    setLink("s1", { kind: "device", asked: true });
    h.serverRow("s1", { content: content({ q: "the team's" }) });
    h.engine.bind();
    await h.synced();

    expect(h.local.get("s1")?.stepData).toEqual({ q: "my detached copy" });
    expect(getLink("s1")).toEqual({ kind: "device", asked: true });
    const pulled = [...h.local.values()].find((p) => p.id !== "s1");
    expect(pulled?.stepData).toEqual({ q: "the team's" });
    expect(getLink(pulled!.id)).toMatchObject({ kind: "account", serverId: "s1" });
  });

  it("uploads an edit after the delay, and does not treat moving between steps as an edit", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1", { stepData: { q: "v1" }, updatedAt: 500 }));
    setLink("p1", accountLink({ rev: 1, synced: fingerprint(content({ q: "v1" })) }));
    h.serverRow("s1", { rev: 1, content: content({ q: "v1" }), content_updated_at: 500 });
    h.engine.bind();
    await h.synced();
    h.ui.open("p1");
    await h.settle();

    h.ui.goToStep("step-2");
    await h.settle();
    expect(h.count("put")).toBe(0);
    expect(h.state.persisted).toBe(0);

    h.state.clock = 2_000;
    h.ui.type("q", "v2");
    await h.settle();
    expect(h.rows.get("s1")).toMatchObject({ rev: 2, content: content({ q: "v2" }), content_updated_at: 2_000 });
    expect(getLink("p1")).toMatchObject({ rev: 2, synced: fingerprint(content({ q: "v2" })) });
    expect(h.status()).toMatchObject({ state: "idle", lastSyncedAt: 2_000 });
  });

  it("does not upload a save that changed nothing, and takes the newer server copy instead", async () => {
    const h = harness(signedIn(ADA));
    // Saved again here at 900 (moving between steps does that) without any change...
    h.local.set("p1", project("p1", { stepData: { q: "v1" }, updatedAt: 900 }));
    setLink("p1", accountLink({ rev: 1, synced: fingerprint(content({ q: "v1" })) }));
    // ...while a collaborator uploaded real work at 800.
    h.serverRow("s1", { rev: 2, content: content({ q: "collaborator's work" }), content_updated_at: 800 });
    h.engine.bind();
    await h.synced();

    expect(h.count("put")).toBe(0);
    expect(h.rows.get("s1")?.content).toBe(content({ q: "collaborator's work" }));
    expect(h.local.get("p1")).toMatchObject({ stepData: { q: "collaborator's work" }, updatedAt: 800 });
    expect(getLink("p1")).toMatchObject({ rev: 2 });
  });

  it("checks unchanged content once, not on every sync", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1", { stepData: { q: "v1" }, updatedAt: 900 }));
    setLink("p1", accountLink({ rev: 1, synced: fingerprint(content({ q: "v1" })) }));
    h.serverRow("s1", { rev: 1, content: content({ q: "v1" }), content_updated_at: 500 });
    h.engine.bind();
    await h.synced();
    await h.engine.reconcile();

    expect(h.count("put")).toBe(0);
    expect(h.count("get")).toBe(0);
    expect(h.status().state).toBe("idle");
  });

  it("never uploads a viewer's edits, and replaces them when the team's copy advances", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1", { stepData: { q: "v1" }, updatedAt: 500 }));
    setLink("p1", accountLink({ rev: 1, role: "viewer" }));
    const row = h.serverRow("s1", { rev: 1, role: "viewer", content: content({ q: "v1" }), content_updated_at: 500 });
    h.engine.bind();
    await h.synced();
    h.ui.open("p1");

    h.state.clock = 9_000;
    h.ui.type("q", "a viewer's local change");
    await h.settle();
    await h.engine.reconcile();
    expect(h.count("put")).toBe(0);

    row.rev = 2;
    row.content = content({ q: "the team's v2" });
    row.content_updated_at = 600;
    await h.engine.reconcile();
    expect(h.count("put")).toBe(0);
    expect(h.local.get("p1")?.stepData).toEqual({ q: "the team's v2" });
    expect(h.state.open?.stepData).toEqual({ q: "the team's v2" });
  });

  it("stops uploading as soon as the list says the person became a viewer", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1", { stepData: { q: "local" }, updatedAt: 900 }));
    setLink("p1", accountLink({ rev: 1, role: "editor" }));
    h.serverRow("s1", { rev: 1, role: "viewer", content: content({ q: "v1" }), content_updated_at: 500 });
    h.engine.bind();
    await h.synced();

    expect(h.count("put")).toBe(0);
    expect(getLink("p1")).toMatchObject({ role: "viewer" });
  });

  it("never downloads over edits that are still waiting to upload", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1", { stepData: { q: "v1" }, updatedAt: 500 }));
    setLink("p1", accountLink({ rev: 1, synced: fingerprint(content({ q: "v1" })) }));
    const row = h.serverRow("s1", { rev: 1, content: content({ q: "v1" }), content_updated_at: 500 });
    h.engine.bind();
    await h.synced();
    h.ui.open("p1");

    // A collaborator's upload arrives, and the person here types while the sync is reading the list.
    row.rev = 2;
    row.content = content({ q: "collaborator" });
    row.content_updated_at = 600;
    h.state.clock = 3_000;
    h.hooks.afterList = () => {
      h.hooks.afterList = undefined;
      h.ui.type("q", "typed during the sync");
    };
    await h.engine.reconcile();
    expect(h.state.open?.stepData).toEqual({ q: "typed during the sync" });

    await h.settle();
    // The edit was made later, so it wins; it was never thrown away unseen.
    expect(h.rows.get("s1")).toMatchObject({ rev: 3, content: content({ q: "typed during the sync" }) });
    expect(h.local.get("p1")?.stepData).toEqual({ q: "typed during the sync" });
  });

  it("returns to the step the person was on when the open project is replaced", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1", { stepData: { q: "v1" }, updatedAt: 500 }));
    setLink("p1", accountLink({ rev: 1 }));
    const row = h.serverRow("s1", { rev: 1, content: content({ q: "v1" }), content_updated_at: 500 });
    h.engine.bind();
    await h.synced();
    h.ui.open("p1");
    h.ui.goToStep("step-3");

    row.rev = 2;
    row.content = content({ q: "v2" });
    row.content_updated_at = 600;
    await h.engine.reconcile();
    await h.settle();

    expect(h.reloads).toEqual([["p1", "step-3"]]);
    expect(h.state.open?.stepData).toEqual({ q: "v2" });
    // Replacing the open project is not an edit: nothing is saved again or uploaded back.
    expect(h.count("put")).toBe(0);
    expect(h.state.persisted).toBe(0);
    expect(h.local.get("p1")?.updatedAt).toBe(600);
  });

  it("does not replace an open project that is being pulled when the person signs out", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1", { stepData: { q: "v1" }, updatedAt: 500 }));
    setLink("p1", accountLink({ rev: 1 }));
    h.serverRow("s1", { rev: 2, content: content({ q: "v2" }), content_updated_at: 600 });
    let release = () => {};
    h.hooks.getContent = new Promise<void>((resolve) => (release = resolve));
    h.engine.bind();
    await h.settle();
    expect(h.count("get")).toBe(1);

    h.account.signOut();
    release();
    await h.settle();

    expect(h.local.get("p1")).toMatchObject({ stepData: { q: "v1" }, updatedAt: 500 });
    expect(getLink("p1")).toMatchObject({ rev: 1 });
  });

  it("does not upload something that was typed and then undone", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1", { stepData: { q: "v1" }, updatedAt: 500 }));
    setLink("p1", accountLink({ rev: 1, synced: fingerprint(content({ q: "v1" })) }));
    h.serverRow("s1", { rev: 1, content: content({ q: "v1" }), content_updated_at: 500 });
    h.engine.bind();
    await h.synced();
    h.ui.open("p1");

    h.ui.type("q", "a slip of the keyboard");
    h.ui.type("q", "v1");
    await h.settle();

    expect(h.state.persisted).toBe(1);
    expect(h.count("put")).toBe(0);
    expect(h.rows.get("s1")?.rev).toBe(1);
  });

  it("keeps what was typed during an upload that the server refused as stale", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1", { stepData: { q: "v1" }, updatedAt: 500 }));
    setLink("p1", accountLink({ rev: 1, synced: fingerprint(content({ q: "v1" })) }));
    const row = h.serverRow("s1", { rev: 1, content: content({ q: "v1" }), content_updated_at: 500 });
    h.engine.bind();
    await h.synced();
    h.ui.open("p1");

    h.state.clock = 2_000;
    h.hooks.beforePut = () => {
      h.hooks.beforePut = undefined;
      // A collaborator's save at 2500 lands first, and the person here keeps typing.
      row.rev = 2;
      row.content = content({ q: "collaborator at 2500" });
      row.content_updated_at = 2_500;
      h.state.clock = 3_000;
      h.ui.type("q", "typed more at 3000");
    };
    h.ui.type("q", "typed at 2000");
    await h.settle();

    // The later edit wins, and at no point was the open project swapped under the person's hands.
    expect(h.reloads).toEqual([]);
    expect(h.state.open?.stepData).toEqual({ q: "typed more at 3000" });
    expect(h.rows.get("s1")).toMatchObject({ rev: 3, content: content({ q: "typed more at 3000" }) });
  });

  it("leaves a project on the device if it is pinned there while a sync is running", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1"));
    // The plan already says "upload p1" when the person chooses to keep it on this device.
    h.hooks.onLocalGet = (id) => {
      if (id === "p1") setLink("p1", { kind: "device", asked: true });
    };
    h.engine.bind();
    await h.synced();

    expect(getLink("p1")).toEqual({ kind: "device", asked: true });
    expect(h.count("create")).toBe(0);
    expect(h.status().state).toBe("idle");
  });

  it("takes the newer server copy when an upload is refused as stale", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1", { stepData: { q: "mine, edited at 700" }, updatedAt: 700 }));
    setLink("p1", accountLink({ rev: 1, synced: fingerprint(content({ q: "v1" })) }));
    const row = h.serverRow("s1", { rev: 1, content: content({ q: "v1" }), content_updated_at: 500 });
    // Between reading the list and uploading, a collaborator saves a later edit.
    h.hooks.afterList = () => {
      h.hooks.afterList = undefined;
      row.rev = 2;
      row.content = content({ q: "theirs, edited at 800" });
      row.content_updated_at = 800;
    };
    h.engine.bind();
    await h.synced();

    expect(h.count("put")).toBe(1);
    expect(h.rows.get("s1")).toMatchObject({ rev: 2, content: content({ q: "theirs, edited at 800" }) });
    expect(h.local.get("p1")).toMatchObject({ stepData: { q: "theirs, edited at 800" }, updatedAt: 800 });
    expect(getLink("p1")).toMatchObject({ rev: 2, synced: fingerprint(content({ q: "theirs, edited at 800" })) });
  });

  it("keeps a project whose server copy is gone as a device-only copy, and says so", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1", { title: "Left behind" }));
    setLink("p1", accountLink({ serverId: "gone" }));
    h.engine.bind();
    await h.synced();

    expect(getLink("p1")).toEqual({ kind: "device", asked: true });
    expect(h.local.has("p1")).toBe(true);
    expect(h.count("create")).toBe(0);
    expect(h.rows.size).toBe(0);
    expect(h.status().detached).toEqual([{ localId: "p1", title: "Left behind", reason: "gone" }]);
    h.status().dismissDetached();
    expect(h.status().detached).toEqual([]);
  });

  it("gives up a sync in flight when the person signs out, writing nothing", async () => {
    const h = harness(signedIn(ADA));
    h.serverRow("s1");
    let release = () => {};
    h.hooks.getContent = new Promise<void>((resolve) => (release = resolve));
    h.engine.bind();
    await h.settle();
    expect(h.count("get")).toBe(1);

    h.account.signOut();
    release();
    await h.settle();

    expect(h.local.size).toBe(0);
    expect(listLinks().size).toBe(0);
    expect(h.status().state).toBe("idle");
  });

  it("does not hand one account's download to the next account", async () => {
    const h = harness(signedIn(ADA));
    h.serverRow("s1");
    let release = () => {};
    h.hooks.getContent = new Promise<void>((resolve) => (release = resolve));
    h.engine.bind();
    await h.settle();

    h.account.signOut();
    h.rows.clear(); // Bob's account is empty
    h.account.signIn(BOB);
    release();
    await h.synced();

    expect(h.local.size).toBe(0);
    expect(listLinks().size).toBe(0);
  });

  it("stays on after a failed listing, and catches up when the device is back online", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1", { stepData: { q: "v1" }, updatedAt: 500 }));
    setLink("p1", accountLink({ rev: 1, synced: fingerprint(content({ q: "v1" })) }));
    h.serverRow("s1", { rev: 1, content: content({ q: "v1" }), content_updated_at: 500 });
    h.fail.list = offline();
    h.fail.put = offline();
    h.engine.bind();
    await h.synced();
    expect(h.status()).toMatchObject({ state: "offline", lastSyncedAt: null });

    // Edits made while offline are still noticed and kept on the device.
    h.ui.open("p1");
    h.state.clock = 4_000;
    h.ui.type("q", "typed offline");
    await h.settle();
    expect(h.local.get("p1")).toMatchObject({ stepData: { q: "typed offline" }, updatedAt: 4_000 });
    expect(h.rows.get("s1")?.rev).toBe(1);

    h.fail.list = null;
    h.fail.put = null;
    h.fire("online");
    await h.synced();
    expect(h.rows.get("s1")).toMatchObject({ rev: 2, content: content({ q: "typed offline" }) });
    expect(h.status()).toMatchObject({ state: "idle", lastSyncedAt: 4_000 });
  });

  it("reports a refused account to the session and shows an error", async () => {
    const h = harness(signedIn(ADA));
    h.fail.list = new SyncError(403, "account_suspended");
    h.engine.bind();
    await h.synced();

    expect(h.status()).toMatchObject({ state: "error", errorCode: "account_suspended" });
    expect(h.state.rechecks).toBe(1);
  });

  it("syncs on focus at most once a minute", async () => {
    const h = harness(signedIn(ADA));
    h.engine.bind();
    await h.synced();
    expect(h.count("list")).toBe(1);

    h.state.clock += FOCUS_SYNC_MS - 1;
    h.fire("focus");
    await h.synced();
    expect(h.count("list")).toBe(1);

    h.state.clock += 1;
    h.fire("focus");
    await h.synced();
    expect(h.count("list")).toBe(2);
  });

  it("runs one more sync, not several, for calls made while one is running", async () => {
    const h = harness(signedIn(ADA));
    h.engine.bind();
    const all = [h.engine.reconcile(), h.engine.reconcile(), h.engine.reconcile()];
    await Promise.all(all);
    await h.settle();
    expect(h.count("list")).toBe(2);
  });

  it("deletes an owner's project in the account as well", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1"));
    setLink("p1", accountLink({ role: "owner" }));
    h.serverRow("s1");
    h.engine.bind();
    await h.synced();

    await expect(h.engine.deleteProjectEverywhere("p1")).resolves.toBe("deleted");
    expect(h.calls).toContain("delete:s1");
    expect(h.local.has("p1")).toBe(false);
    expect(getLink("p1")).toBeNull();
    expect(localStorage.getItem(TOMBSTONES_KEY)).toBeNull();
  });

  it("leaves, rather than deletes, for a member who is not an owner", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1"));
    setLink("p1", accountLink({ role: "editor" }));
    h.serverRow("s1", { role: "editor" });
    h.engine.bind();
    await h.synced();

    await expect(h.engine.deleteProjectEverywhere("p1")).resolves.toBe("left");
    expect(h.calls).toContain("leave:s1");
    expect(h.count("delete")).toBe(0);
  });

  it("carries out a 'delete for everyone' as a leave once the account says the person is no longer an owner", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1"));
    // This device still says owner. The account says editor.
    setLink("p1", accountLink({ role: "owner" }));
    h.serverRow("s1", { role: "editor" });
    h.fail.list = offline();
    h.engine.bind();
    await h.synced();
    h.fail.list = null;
    h.hooks.before = (op) => {
      if (op === "delete") throw new SyncError(403, "forbidden");
    };

    // Refused as a delete: it stays queued, and the next sync carries it out as the leave that is left to do.
    await expect(h.engine.deleteProjectEverywhere("p1", "everyone")).resolves.toBe("queued");
    await h.engine.reconcile();
    expect(h.calls).toContain("leave:s1");
    expect(h.rows.has("s1")).toBe(false);
    expect(localStorage.getItem(TOMBSTONES_KEY)).toBeNull();
  });

  it("queues a deletion made offline, keeps the project from coming back, and sends it at the next sync", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1"));
    setLink("p1", accountLink({ role: "owner" }));
    h.serverRow("s1");
    h.engine.bind();
    await h.synced();

    h.fail.delete = offline();
    await expect(h.engine.deleteProjectEverywhere("p1")).resolves.toBe("queued");
    expect(h.local.has("p1")).toBe(false);
    expect(parseTombstones(localStorage.getItem(TOMBSTONES_KEY))).toEqual([{ serverId: "s1", owner: ADA, action: "delete" }]);

    // Still unreachable: the project is in the list but is not downloaded again.
    const refreshed = h.state.refreshed;
    await h.engine.reconcile();
    expect(h.local.size).toBe(0);
    expect(h.rows.has("s1")).toBe(true);
    expect(h.status().state).toBe("offline");
    // The connection dropped part way: nothing more is asked of the backend.
    expect(h.state.refreshed).toBe(refreshed);
    expect(h.afterSync).toHaveLength(1);

    h.fail.delete = null;
    await h.engine.reconcile();
    expect(h.rows.has("s1")).toBe(false);
    expect(h.local.size).toBe(0);
    expect(localStorage.getItem(TOMBSTONES_KEY)).toBeNull();
    expect(h.status().state).toBe("idle");
  });

  it("uses the role from the list, not the stale one, when a queued deletion is sent", async () => {
    const h = harness(signedIn(ADA));
    h.serverRow("s1", { role: "viewer" });
    localStorage.setItem(TOMBSTONES_KEY, JSON.stringify([{ serverId: "s1", owner: ADA, action: "delete" }, { serverId: "s9", owner: BOB }]));
    h.engine.bind();
    await h.synced();

    expect(h.calls).toContain("leave:s1");
    expect(h.count("delete")).toBe(0);
    // Bob's queued deletion waits for Bob.
    expect(parseTombstones(localStorage.getItem(TOMBSTONES_KEY))).toEqual([{ serverId: "s9", owner: BOB, action: "leave" }]);
  });

  it("deletes a device-only project without touching the account", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("mine", project("mine"));
    setLink("mine", { kind: "device", asked: true });
    h.engine.bind();
    await h.synced();
    const callsBefore = h.calls.length;

    await expect(h.engine.deleteProjectEverywhere("mine")).resolves.toBe("local");
    expect(h.local.has("mine")).toBe(false);
    expect(getLink("mine")).toBeNull();
    expect(h.calls.length).toBe(callsBefore);
  });

  it("ensureRemote adopts a device-only project with one create request, however many callers", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("mine", project("mine", { stepData: { q: "kept here until now" } }));
    setLink("mine", { kind: "device", asked: true });
    h.engine.bind();
    await h.synced();
    expect(h.count("create")).toBe(0);

    const [a, b] = await Promise.all([h.engine.ensureRemote("mine"), h.engine.ensureRemote("mine")]);
    expect(a).toBe(b);
    expect(h.count("create")).toBe(1);
    expect(getLink("mine")).toMatchObject({ kind: "account", owner: ADA, serverId: a, created: true, rev: 1 });
    // Its content is there too, so nobody is invited to an empty project.
    expect(h.rows.get(a)?.content).toBe(content({ q: "kept here until now" }));
    // Asking again makes no request.
    await expect(h.engine.ensureRemote("mine")).resolves.toBe(a);
    expect(h.count("create")).toBe(1);
  });

  it("ensureRemote refuses when nobody is signed in, and for another account's project", async () => {
    const h = harness();
    h.local.set("mine", project("mine"));
    h.engine.bind();
    await expect(h.engine.ensureRemote("mine")).rejects.toMatchObject({ code: "unauthenticated" });

    h.account.signInWithoutPassword(ADA);
    await expect(h.engine.ensureRemote("mine")).rejects.toMatchObject({ code: "password_reset_required" });

    h.account.signIn(ADA);
    await h.synced();
    h.local.set("bobs", project("bobs"));
    setLink("bobs", accountLink({ owner: BOB, serverId: "s-bob" }));
    await expect(h.engine.ensureRemote("bobs")).rejects.toMatchObject({ code: "forbidden" });
    await expect(h.engine.ensureRemote("nothing-here")).rejects.toMatchObject({ code: "not_found" });
    expect(h.count("create")).toBe(0);
  });

  it("never syncs another account's project, and takes over the link of one they share", async () => {
    const h = harness(signedIn(BOB));
    // Ada used this device before. One of her projects is shared with Bob, one is not.
    h.local.set("shared", project("shared", { stepData: { q: "v1" }, updatedAt: 500 }));
    setLink("shared", accountLink({ owner: ADA, serverId: "s-shared", rev: 1, role: "owner", synced: fingerprint(content({ q: "v1" })) }));
    h.local.set("private", project("private", { updatedAt: 9_999 }));
    setLink("private", accountLink({ owner: ADA, serverId: "s-private", rev: 1 }));
    h.serverRow("s-shared", { rev: 1, role: "editor", content: content({ q: "v1" }), content_updated_at: 500 });
    h.engine.bind();
    await h.synced();

    expect(getLink("shared")).toMatchObject({ owner: BOB, role: "editor", serverId: "s-shared" });
    expect(getLink("private")).toMatchObject({ owner: ADA });
    // No duplicate download, and Ada's private project is neither uploaded nor detached.
    expect(h.local.size).toBe(2);
    expect(h.calls).toEqual(["list"]);
  });

  it("leaves another account's copy untouched when it holds work that was never uploaded", async () => {
    const h = harness(signedIn(BOB));
    // Ada edited the shared project here and signed out before it uploaded.
    h.local.set("shared", project("shared", { stepData: { q: "Ada's unsent draft" }, updatedAt: 9_000 }));
    setLink("shared", accountLink({ owner: ADA, serverId: "s-shared", rev: 1, role: "owner", synced: fingerprint(content({ q: "v1" })) }));
    h.serverRow("s-shared", { rev: 1, role: "editor", content: content({ q: "v1" }), content_updated_at: 500 });
    h.engine.bind();
    await h.synced();

    // Bob, an editor, neither uploads Ada's draft nor overwrites it. He gets his own copy.
    expect(h.count("put")).toBe(0);
    expect(h.local.get("shared")).toMatchObject({ stepData: { q: "Ada's unsent draft" }, updatedAt: 9_000 });
    expect(getLink("shared")).toMatchObject({ owner: ADA, role: "owner" });
    const bobs = [...h.local.values()].filter((p) => p.id !== "shared");
    expect(bobs).toHaveLength(1);
    expect(bobs[0].stepData).toEqual({ q: "v1" });
    expect(getLink(bobs[0].id)).toMatchObject({ owner: BOB, serverId: "s-shared", role: "editor" });

    // When Ada is back her draft uploads, and Bob's copy is not handed to her as a duplicate.
    h.account.signOut();
    h.rows.get("s-shared")!.role = "owner";
    h.account.signIn(ADA);
    await h.synced();
    expect(h.rows.get("s-shared")).toMatchObject({ rev: 2, content: content({ q: "Ada's unsent draft" }) });
    expect(getLink(bobs[0].id)).toMatchObject({ owner: BOB });
    expect(h.local.size).toBe(2);
  });

  it("waits for an invited person to choose a password, and still pins their guest work", async () => {
    const h = harness();
    h.local.set("guest", project("guest"));
    h.engine.bind();

    h.account.signInWithoutPassword(ADA);
    await h.settle();
    expect(h.count("list")).toBe(0);
    expect(getLink("guest")).toEqual({ kind: "device", asked: false });

    h.account.signIn(ADA);
    await h.synced();
    expect(h.count("list")).toBe(1);
    expect(h.count("create")).toBe(0);
    expect(getLink("guest")).toEqual({ kind: "device", asked: false });
  });

  it("on sign-out saves waiting edits to the device, closes the hidden project and forgets invitations", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1", { stepData: { q: "v1" }, updatedAt: 500 }));
    setLink("p1", accountLink({ rev: 1 }));
    h.serverRow("s1", { rev: 1, content: content({ q: "v1" }), content_updated_at: 500 });
    h.engine.bind();
    await h.synced();
    h.ui.open("p1");
    const cleared = h.state.cleared;

    h.state.clock = 7_000;
    h.ui.type("q", "typed just before signing out");
    h.account.signOut();
    await h.settle();

    expect(h.local.get("p1")).toMatchObject({ stepData: { q: "typed just before signing out" }, updatedAt: 7_000 });
    expect(h.state.open).toBeNull();
    expect(h.state.closed).toBe(1);
    expect(h.state.cleared).toBe(cleared + 1);
    expect(h.count("put")).toBe(0);

    // Signing in again uploads what was waiting.
    h.account.signIn(ADA);
    await h.synced();
    expect(h.rows.get("s1")).toMatchObject({ rev: 2, content: content({ q: "typed just before signing out" }) });
  });

  it("keeps the account's project open after an involuntary sign-out, and stops syncing", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1"));
    setLink("p1", accountLink());
    h.serverRow("s1");
    h.engine.bind();
    await h.synced();
    h.ui.open("p1");
    const lists = h.count("list");

    h.account.expire();
    await h.settle();
    expect(h.state.open?.id).toBe("p1");
    h.fire("online");
    h.fire("focus");
    await h.engine.reconcile();
    expect(h.count("list")).toBe(lists);
  });

  it("closes a project that should not be showing as soon as it is opened", async () => {
    const h = harness();
    h.local.set("adas", project("adas"));
    setLink("adas", accountLink({ owner: ADA }));
    h.local.set("guest", project("guest"));
    h.engine.bind();

    h.ui.open("adas");
    expect(h.state.open).toBeNull();
    h.ui.open("guest");
    expect(h.state.open?.id).toBe("guest");
  });

  it("reads invitations at the end of a sync and syncs when one is accepted", async () => {
    const h = harness(signedIn(ADA));
    h.engine.bind();
    await h.synced();
    expect(h.state.refreshed).toBe(1);

    h.serverRow("s-joined", { role: "editor" });
    await h.acceptInvitation();
    expect(h.local.has("s-joined")).toBe(true);
    expect(h.state.refreshed).toBe(2);
  });

  it("hands the project list to the layers on top after a sync that reached the backend, and only then", async () => {
    const h = harness(signedIn(ADA));
    h.serverRow("s1");
    h.serverRow("s2", { role: "viewer" });
    h.state.afterSyncThrows = true; // and their failure is not a sync failure
    h.engine.bind();
    await h.synced();
    expect(h.afterSync).toEqual([["s1", "s2"]]);
    expect(h.status().state).toBe("idle");

    h.fail.list = offline();
    await h.engine.reconcile();
    expect(h.afterSync).toHaveLength(1);
    expect(h.state.refreshed).toBe(1);
  });

  // --- Work that has not reached the account is never lost ---

  it("uploads offline edits, and never replaces them, when the server's stamp is ahead of this device's clock", async () => {
    const h = harness(signedIn(ADA));
    // Revision 3 was pulled with a stamp of 2000 from a device whose clock runs
    // ahead. It was then edited here, offline, at 1500 by this device's clock.
    h.local.set("p1", project("p1", { stepData: { q: "my offline edit" }, updatedAt: 1_500 }));
    setLink("p1", accountLink({ rev: 3, synced: fingerprint(content({ q: "v3" })) }));
    h.serverRow("s1", { rev: 3, content: content({ q: "v3" }), content_updated_at: 2_000 });
    h.engine.bind();
    await h.synced();

    expect(h.count("get")).toBe(0);
    expect(h.local.get("p1")?.stepData).toEqual({ q: "my offline edit" });
    expect(h.rows.get("s1")).toMatchObject({ rev: 4, content: content({ q: "my offline edit" }) });
    expect(getLink("p1")).toMatchObject({ rev: 4, synced: fingerprint(content({ q: "my offline edit" })) });
  });

  it("asks nothing of the backend at an unchanged revision when the content is the one last synced", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1", { stepData: { q: "v3" }, updatedAt: 1_500 }));
    setLink("p1", accountLink({ rev: 3, synced: fingerprint(content({ q: "v3" })) }));
    h.serverRow("s1", { rev: 3, content: content({ q: "v3" }), content_updated_at: 2_000 });
    h.engine.bind();
    await h.synced();
    await h.engine.reconcile();

    expect(h.calls).toEqual(["list", "list"]);
    expect(h.local.get("p1")).toMatchObject({ stepData: { q: "v3" }, updatedAt: 1_500 });
  });

  it("does not upload the empty copy of a project nobody has uploaded yet, however often it is saved here", async () => {
    const h = harness(signedIn(BOB));
    // Bob accepted an invitation to a project whose author has not uploaded it yet.
    h.serverRow("s1", { role: "editor", rev: 0, content: null, content_updated_at: null });
    h.engine.bind();
    await h.synced();
    expect(getLink("s1")).toMatchObject({ rev: 0, synced: fingerprint(content({})) });

    // Opening it and moving between steps saves it again: a new time, no change.
    h.local.set("s1", { ...h.local.get("s1")!, updatedAt: 5_000 });
    await h.engine.reconcile();

    expect(h.count("put")).toBe(0);
    expect(h.rows.get("s1")).toMatchObject({ rev: 0, content: null });
  });

  it("never replaces work that has not reached the account with somebody else's copy: both are kept", async () => {
    const h = harness(signedIn(ADA));
    // Ada's first upload failed after the project was created in her account.
    h.local.set("mine", project("mine", { title: "Review", stepData: { q: "months of work" }, updatedAt: 1_000 }));
    setLink("mine", accountLink({ serverId: "s1", rev: 0 }));
    // Since then a collaborator has written to the copy in the account.
    h.serverRow("s1", { rev: 1, content: content({ q: "a collaborator's start" }), content_updated_at: 2_000 });
    h.engine.bind();
    await h.synced();

    expect(h.local.get("mine")).toMatchObject({ stepData: { q: "months of work" }, updatedAt: 1_000 });
    expect(getLink("mine")).toEqual({ kind: "device", asked: true });
    expect(h.status().detached).toEqual([{ localId: "mine", title: "Review", reason: "diverged" }]);
    // The team's copy is untouched, and arrives beside hers.
    expect(h.count("put")).toBe(0);
    expect(h.rows.get("s1")).toMatchObject({ rev: 1, content: content({ q: "a collaborator's start" }) });
    expect(h.local.get("s1")?.stepData).toEqual({ q: "a collaborator's start" });
    expect(getLink("s1")).toMatchObject({ kind: "account", owner: ADA, serverId: "s1", rev: 1 });
  });

  it("gives a viewer of a project nobody had uploaded the team's copy, whatever they typed meanwhile", async () => {
    const h = harness(signedIn(BOB));
    const row = h.serverRow("s1", { role: "viewer", rev: 0, content: null, content_updated_at: null });
    h.engine.bind();
    await h.synced();
    h.local.set("s1", { ...h.local.get("s1")!, stepData: { q: "a viewer's scribble" }, updatedAt: 9_000 });

    row.rev = 1;
    row.content = content({ q: "the author's work" });
    row.content_updated_at = 2_000;
    await h.engine.reconcile();

    expect(h.local.get("s1")?.stepData).toEqual({ q: "the author's work" });
    expect(getLink("s1")).toMatchObject({ kind: "account", role: "viewer", rev: 1 });
    expect(h.status().detached).toEqual([]);
    expect(h.local.size).toBe(1);
  });

  it("uploads work that has not reached the account over an empty copy that was saved in the meantime", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("mine", project("mine", { stepData: { q: "months of work" }, updatedAt: 1_000 }));
    setLink("mine", accountLink({ serverId: "s1", rev: 0 }));
    // Another device opened the still empty project and saved it as it was, later by its clock.
    h.serverRow("s1", { rev: 1, content: content({}), content_updated_at: 2_000 });
    h.engine.bind();
    await h.synced();

    expect(h.local.get("mine")?.stepData).toEqual({ q: "months of work" });
    expect(h.rows.get("s1")).toMatchObject({ rev: 2, content: content({ q: "months of work" }) });
    expect(getLink("mine")).toMatchObject({ kind: "account", serverId: "s1", rev: 2, synced: fingerprint(content({ q: "months of work" })) });
    expect(h.status().detached).toEqual([]);
  });

  it("keeps work that has not reached the account when its first upload is refused as stale", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("mine", project("mine", { title: "Review", stepData: { q: "months of work" }, updatedAt: 1_000 }));
    setLink("mine", accountLink({ serverId: "s1", rev: 0 }));
    const row = h.serverRow("s1", { rev: 0, content: null, content_updated_at: null });
    // The list says nobody has uploaded. Before this device's upload lands, a collaborator's does.
    h.hooks.afterList = () => {
      h.hooks.afterList = undefined;
      row.rev = 1;
      row.content = content({ q: "theirs" });
      row.content_updated_at = 2_000;
    };
    h.engine.bind();
    await h.synced();

    expect(h.local.get("mine")?.stepData).toEqual({ q: "months of work" });
    expect(getLink("mine")).toEqual({ kind: "device", asked: true });
    expect(h.rows.get("s1")).toMatchObject({ rev: 1, content: content({ q: "theirs" }) });
  });

  it("does not call a project added until its content is in the account, and uploads again when asked", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("mine", project("mine", { stepData: { q: "kept here until now" } }));
    setLink("mine", { kind: "device", asked: false });
    h.engine.bind();
    await h.synced();

    // The project is created in the account, and then the connection drops.
    h.fail.put = new SyncError(0, "network");
    await expect(h.engine.ensureRemote("mine")).rejects.toMatchObject({ code: "network" });
    const link = getLink("mine") as AccountLink;
    expect(link).toMatchObject({ kind: "account", owner: ADA, created: true, rev: 0 });
    expect(awaitsFirstUpload(link)).toBe(true);
    expect(h.rows.get(link.serverId)?.content).toBeNull();

    h.fail.put = null;
    await expect(h.engine.ensureRemote("mine")).resolves.toBe(link.serverId);
    expect(h.count("create")).toBe(1);
    expect(awaitsFirstUpload(getLink("mine"))).toBe(false);
    expect(h.rows.get(link.serverId)?.content).toBe(content({ q: "kept here until now" }));
  });

  it("reports a sync in which a first upload failed as failed, and uploads at the next one", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1", { stepData: { q: "mine" } }));
    h.fail.put = new SyncError(500, "server_error");
    h.engine.bind();
    await h.synced();

    const link = getLink("p1") as AccountLink;
    expect(awaitsFirstUpload(link)).toBe(true);
    expect(h.status()).toMatchObject({ state: "error", errorCode: "server_error", lastSyncedAt: null });

    h.fail.put = null;
    await h.engine.reconcile();
    expect(h.rows.get(link.serverId)).toMatchObject({ rev: 1, content: content({ q: "mine" }) });
    expect(h.status().state).toBe("idle");
  });

  it("refuses a project that is too large for the account before anything is created there", async () => {
    const h = harness(signedIn(ADA), { maxContentBytes: 200 });
    h.local.set("big", project("big", { stepData: { q: "x".repeat(400) } }));
    setLink("big", { kind: "device", asked: false });
    h.engine.bind();
    await h.synced();

    await expect(h.engine.ensureRemote("big")).rejects.toMatchObject({ code: "too_large" });
    expect(getLink("big")).toEqual({ kind: "device", asked: false });
    expect(h.count("create")).toBe(0);
    expect(h.rows.size).toBe(0);
  });

  it("creates nothing in the account for a project made while signed in that is too large", async () => {
    const h = harness(signedIn(ADA), { maxContentBytes: 200 });
    h.engine.bind();
    await h.synced();

    h.ui.create(project("fresh", { stepData: { q: "x".repeat(400) } }));
    await h.settle();
    await h.engine.reconcile();

    expect(h.count("create")).toBe(0);
    expect(h.rows.size).toBe(0);
    expect(awaitsFirstUpload(getLink("fresh"))).toBe(true);
    expect(h.status()).toMatchObject({ state: "error", errorCode: "too_large" });
  });

  it("says so when a project in the account has grown too large to upload, and sends nothing", async () => {
    const h = harness(signedIn(ADA), { maxContentBytes: 200 });
    h.local.set("p1", project("p1", { stepData: { q: "x".repeat(400) }, updatedAt: 900 }));
    setLink("p1", accountLink({ rev: 1, synced: fingerprint(content({ q: "v1" })) }));
    h.serverRow("s1", { rev: 1, content: content({ q: "v1" }), content_updated_at: 500 });
    h.engine.bind();
    await h.synced();

    expect(h.count("put")).toBe(0);
    expect(h.status()).toMatchObject({ state: "error", errorCode: "too_large" });
    expect(h.local.get("p1")?.stepData).toEqual({ q: "x".repeat(400) });
  });

  // --- A leave never becomes a delete ---

  it("only leaves for a queued 'Leave project', even when the person has since been made an owner", async () => {
    const h = harness(signedIn(BOB));
    // Bob left as an editor while offline. Before his next sync he was made an owner.
    h.serverRow("s1", { role: "owner" });
    localStorage.setItem(TOMBSTONES_KEY, JSON.stringify([{ serverId: "s1", owner: BOB, action: "leave" }]));
    h.engine.bind();
    await h.synced();

    expect(h.calls).toContain("leave:s1");
    expect(h.count("delete")).toBe(0);
    expect(localStorage.getItem(TOMBSTONES_KEY)).toBeNull();
  });

  it("treats a queued deletion that does not say what was confirmed as a leave", async () => {
    const h = harness(signedIn(BOB));
    h.serverRow("s1", { role: "owner" });
    localStorage.setItem(TOMBSTONES_KEY, JSON.stringify([{ serverId: "s1", owner: BOB }]));
    h.engine.bind();
    await h.synced();

    expect(h.calls).toContain("leave:s1");
    expect(h.count("delete")).toBe(0);
  });

  it("does not delete for everyone when a queued leave is refused because the person is now the only owner", async () => {
    const h = harness(signedIn(BOB));
    h.serverRow("s1", { role: "owner", title: "Sleep" });
    h.fail.leave = new SyncError(409, "last_owner");
    localStorage.setItem(TOMBSTONES_KEY, JSON.stringify([{ serverId: "s1", owner: BOB, action: "leave" }]));
    h.engine.bind();
    await h.synced();

    expect(h.count("delete")).toBe(0);
    expect(h.rows.has("s1")).toBe(true);
    expect(localStorage.getItem(TOMBSTONES_KEY)).toBeNull();
    // The project is theirs alone now: it is on this device again, and they are told.
    expect(h.local.has("s1")).toBe(true);
    expect(getLink("s1")).toMatchObject({ kind: "account", owner: BOB, role: "owner" });
    expect(h.status().returned).toEqual([{ serverId: "s1", title: "Sleep" }]);
    h.status().dismissReturned();
    expect(h.status().returned).toEqual([]);
  });

  it("removes nothing when 'Leave project' is refused at once, and never falls back to deleting", async () => {
    const h = harness(signedIn(BOB));
    h.local.set("p1", project("p1", { stepData: { q: "v1" } }));
    // No sync has run since Bob became the only owner: this device still says editor.
    setLink("p1", accountLink({ owner: BOB, role: "editor" }));
    h.serverRow("s1", { role: "owner" });
    h.fail.list = offline();
    h.engine.bind();
    await h.synced();
    h.fail.list = null;
    h.fail.leave = new SyncError(409, "last_owner");

    await expect(h.engine.deleteProjectEverywhere("p1", "leave")).rejects.toMatchObject({ code: "last_owner" });
    await h.synced();

    expect(h.count("delete")).toBe(0);
    expect(h.rows.has("s1")).toBe(true);
    expect(h.local.get("p1")?.stepData).toEqual({ q: "v1" });
    expect(localStorage.getItem(TOMBSTONES_KEY)).toBeNull();
    // The sync that follows brings the role up to date, so the next question is the right one.
    expect(getLink("p1")).toMatchObject({ kind: "account", role: "owner" });
    expect(deletionEffect(getLink("p1"))).toBe("everyone");
  });

  it("carries out what was confirmed, not more, when the role changed while the question was open", async () => {
    const h = harness(signedIn(BOB));
    h.local.set("p1", project("p1"));
    setLink("p1", accountLink({ owner: BOB, role: "owner" }));
    h.serverRow("s1", { role: "owner" });
    h.engine.bind();
    await h.synced();

    // "Leave project?" was on screen. The link says owner by the time it is confirmed.
    await expect(h.engine.deleteProjectEverywhere("p1", "leave")).resolves.toBe("left");
    expect(h.calls).toContain("leave:s1");
    expect(h.count("delete")).toBe(0);

    // "Delete project?" was confirmed for a project that was only on this device, and it is in the account by now.
    h.local.set("p2", project("p2"));
    setLink("p2", accountLink({ owner: BOB, serverId: "s2", role: "owner" }));
    h.serverRow("s2", { role: "owner" });
    await expect(h.engine.deleteProjectEverywhere("p2", "device")).rejects.toMatchObject({ code: "conflict" });
    expect(h.local.has("p2")).toBe(true);
    expect(h.rows.has("s2")).toBe(true);
  });

  it("queues a leave made offline as a leave", async () => {
    const h = harness(signedIn(BOB));
    h.local.set("p1", project("p1"));
    setLink("p1", accountLink({ owner: BOB, role: "editor" }));
    h.serverRow("s1", { role: "editor" });
    h.engine.bind();
    await h.synced();

    h.fail.leave = offline();
    await expect(h.engine.deleteProjectEverywhere("p1", "leave")).resolves.toBe("queued");
    expect(h.local.has("p1")).toBe(false);
    expect(parseTombstones(localStorage.getItem(TOMBSTONES_KEY))).toEqual([{ serverId: "s1", owner: BOB, action: "leave" }]);
  });

  // --- A sync that overlaps with something the person does ---

  it("does not take a project that is added to the account during a sync for one whose server copy is gone", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("mine", project("mine", { stepData: { q: 1 } }));
    setLink("mine", { kind: "device", asked: false });
    h.engine.bind();
    await h.synced();

    // A sync has asked for the account's projects. The answer is on its way...
    let release = () => {};
    h.hooks.listHold = new Promise<void>((resolve) => (release = resolve));
    const pass = h.engine.reconcile();
    await h.settle();
    // ...when "Add to my account" finishes.
    const serverId = await h.engine.ensureRemote("mine");
    release();
    await pass;
    await h.settle();

    expect(getLink("mine")).toMatchObject({ kind: "account", serverId, created: true, rev: 1 });
    expect(h.status().detached).toEqual([]);
    await h.engine.reconcile();
    expect(h.local.size).toBe(1);
    expect(h.rows.size).toBe(1);
  });

  it("does not download a project again that is deleted while a sync is under way", async () => {
    const h = harness(signedIn(ADA));
    h.local.set("p1", project("p1"));
    setLink("p1", accountLink({ serverId: "s1", role: "owner" }));
    h.serverRow("s0");
    h.serverRow("s1");
    // An earlier deletion is still waiting to be sent.
    localStorage.setItem(TOMBSTONES_KEY, JSON.stringify([{ serverId: "s0", owner: ADA, action: "delete" }]));
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    h.hooks.before = async (op, id) => {
      if (op === "delete" && id === "s0") await held; // the sync is busy sending it
      if (op === "delete" && id === "s1") throw new SyncError(503, "server_error"); // and the new one cannot be sent yet
    };
    h.engine.bind();
    await h.settle();
    expect(h.calls).toContain("delete:s0");

    await expect(h.engine.deleteProjectEverywhere("p1")).resolves.toBe("queued");
    release();
    await h.synced();

    expect(h.local.size).toBe(0);
    expect(h.calls).not.toContain("get:s1");
    expect(parseTombstones(localStorage.getItem(TOMBSTONES_KEY))).toEqual([{ serverId: "s1", owner: ADA, action: "delete" }]);
  });

  it("does not hand a project the person has just left back to them through another account's copy", async () => {
    const h = harness(signedIn(BOB));
    // Two members share this device. Ada's copy of the shared project is here, clean and hidden.
    h.local.set("shared", project("shared", { stepData: { q: "v1" }, updatedAt: 500 }));
    setLink("shared", accountLink({ owner: ADA, serverId: "s-shared", rev: 1, role: "owner", synced: fingerprint(content({ q: "v1" })) }));
    h.serverRow("s-shared", { rev: 1, role: "editor", content: content({ q: "v1" }), content_updated_at: 500 });
    // Bob deleted his own copy while offline.
    localStorage.setItem(TOMBSTONES_KEY, JSON.stringify([{ serverId: "s-shared", owner: BOB, action: "leave" }]));
    h.engine.bind();
    await h.synced();

    expect(h.calls).toEqual(["list", "leave:s-shared"]);
    expect(getLink("shared")).toMatchObject({ kind: "account", owner: ADA, role: "owner" });
    await h.engine.reconcile();
    expect(getLink("shared")).toMatchObject({ kind: "account", owner: ADA, role: "owner" });
    expect(h.status().detached).toEqual([]);
  });

  // --- From viewer to editor ---

  it("does not upload what was typed as a viewer once the person is made an editor", async () => {
    const h = harness(signedIn(BOB));
    h.local.set("p1", project("p1", { stepData: { q: "v1" }, updatedAt: 500 }));
    setLink("p1", accountLink({ owner: BOB, rev: 1, role: "viewer", synced: fingerprint(content({ q: "v1" })) }));
    const row = h.serverRow("s1", { rev: 1, role: "viewer", content: content({ q: "v1" }), content_updated_at: 500 });
    h.engine.bind();
    await h.synced();
    h.ui.open("p1");

    // Typed under "changes you make here are not saved to the shared project".
    h.state.clock = 9_000;
    h.ui.type("q", "a scribble");
    h.ui.save();
    await h.settle();
    await h.engine.reconcile();
    expect(h.count("put")).toBe(0);

    row.role = "editor";
    await h.engine.reconcile();
    await h.settle();

    expect(h.count("put")).toBe(0);
    expect(h.rows.get("s1")).toMatchObject({ rev: 1, content: content({ q: "v1" }) });
    expect(h.local.get("p1")?.stepData).toEqual({ q: "v1" });
    expect(h.state.open?.stepData).toEqual({ q: "v1" });
    expect(getLink("p1")).toMatchObject({ role: "editor", rev: 1 });

    // From here on they are an editor, and what they type is the team's.
    h.state.clock = 10_000;
    h.ui.type("q", "an editor's edit");
    await h.settle();
    expect(h.rows.get("s1")).toMatchObject({ rev: 2, content: content({ q: "an editor's edit" }) });
  });

  it("does not upload what a viewer typed and had not even saved to the device when they were made an editor", async () => {
    const h = harness(signedIn(BOB));
    h.local.set("p1", project("p1", { stepData: { q: "v1" }, updatedAt: 500 }));
    setLink("p1", accountLink({ owner: BOB, rev: 1, role: "viewer", synced: fingerprint(content({ q: "v1" })) }));
    const row = h.serverRow("s1", { rev: 1, role: "viewer", content: content({ q: "v1" }), content_updated_at: 500 });
    h.engine.bind();
    await h.synced();
    h.ui.open("p1");

    // Typed, and still only in the open step: the runner saves on leaving a field or a step.
    h.state.clock = 9_000;
    h.ui.type("q", "a scribble");
    await h.settle();
    expect(h.local.get("p1")?.stepData).toEqual({ q: "v1" });

    row.role = "editor";
    await h.engine.reconcile();
    await h.settle();
    expect(h.state.open?.stepData).toEqual({ q: "v1" });
    expect(getLink("p1")).toMatchObject({ role: "editor" });

    // The runner saves what is open, and the next sync has nothing to send.
    h.state.clock = 9_500;
    h.ui.save();
    await h.engine.reconcile();
    expect(h.count("put")).toBe(0);
    expect(h.rows.get("s1")).toMatchObject({ rev: 1, content: content({ q: "v1" }) });
  });

  it("makes a viewer whose copy is the team's an editor without asking the backend for anything more", async () => {
    const h = harness(signedIn(BOB));
    h.local.set("p1", project("p1", { stepData: { q: "v1" }, updatedAt: 500 }));
    setLink("p1", accountLink({ owner: BOB, rev: 1, role: "viewer", synced: fingerprint(content({ q: "v1" })) }));
    h.serverRow("s1", { rev: 1, role: "editor", content: content({ q: "v1" }), content_updated_at: 500 });
    h.engine.bind();
    await h.synced();

    expect(h.calls).toEqual(["list"]);
    expect(getLink("p1")).toMatchObject({ role: "editor" });
  });

  it("unbinding stops everything", async () => {
    const h = harness(signedIn(ADA));
    const unbind = h.engine.bind();
    expect(h.engine.bind()).toBe(unbind);
    await h.synced();
    const lists = h.count("list");

    unbind();
    h.fire("online");
    h.account.signIn(BOB);
    await h.settle();
    expect(h.count("list")).toBe(lists);
  });
});
