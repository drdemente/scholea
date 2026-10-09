import { describe, expect, it } from "vitest";
import { SyncError } from "@/lib/supabase/errors";
import {
  ROLE_LABEL,
  SyncError as ReExported,
  TITLE_MAX,
  activityFromRow,
  canEdit,
  createRpcCaller,
  createSync,
  describeSyncError,
  memberFromRow,
  projectFromRow,
  serializeContent,
  serverTitle,
  summarizeActivity,
  toMs,
  type ActivityEntry,
  type SyncClient,
} from "./sync";

/** An en dash or an em dash. Copy uses plain sentences instead. */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

describe("toMs", () => {
  it("keeps epoch milliseconds as they are", () => {
    expect(toMs(1_760_000_000_000)).toBe(1_760_000_000_000);
    expect(toMs(0)).toBe(0);
  });

  it("accepts a numeric string and an ISO date", () => {
    expect(toMs("1760000000000")).toBe(1_760_000_000_000);
    expect(toMs(" 42 ")).toBe(42);
    expect(toMs("2026-01-02T03:04:05Z")).toBe(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(toMs("2026-01-02T03:04:05+00:00")).toBe(Date.UTC(2026, 0, 2, 3, 4, 5));
  });

  it("is null for anything that is not a time", () => {
    for (const v of [null, undefined, "", "   ", "soon", NaN, Infinity, {}, [], true]) expect(toMs(v)).toBeNull();
  });
});

describe("serverTitle", () => {
  it("trims, and never sends an empty title", () => {
    expect(serverTitle("  My review  ")).toBe("My review");
    expect(serverTitle("")).toBe("Untitled project");
    expect(serverTitle("   ")).toBe("Untitled project");
    expect(serverTitle(null)).toBe("Untitled project");
    expect(serverTitle(undefined)).toBe("Untitled project");
  });

  it("cuts a long title to the limit without splitting a character", () => {
    expect(TITLE_MAX).toBe(300);
    expect(serverTitle("x".repeat(300))).toHaveLength(300);
    expect(serverTitle("x".repeat(301))).toHaveLength(300);
    // 300 emoji are 600 UTF-16 units but 300 characters: all of them fit.
    const emoji = "😀".repeat(300);
    expect(serverTitle(emoji)).toBe(emoji);
    const cut = serverTitle("😀".repeat(301));
    expect(Array.from(cut)).toHaveLength(300);
    expect(cut.endsWith("😀")).toBe(true);
  });
});

describe("serializeContent", () => {
  it("is exactly the two maps, in a fixed order", () => {
    const p = { id: "p1", title: "T", stepStatus: { q: { complete: true, needsAttention: false } }, stepData: { q: { a: 1 } }, updatedAt: 5 };
    expect(serializeContent(p)).toBe('{"stepData":{"q":{"a":1}},"stepStatus":{"q":{"complete":true,"needsAttention":false}}}');
  });
});

describe("reading rows", () => {
  it("reads a project row and normalises its times", () => {
    expect(
      projectFromRow({
        id: "proj_1",
        title: "T",
        study_type: "cohort",
        owner_id: "u1",
        role: "editor",
        rev: 3,
        content_updated_at: "1700000000000",
        created_at: 10,
        updated_at: "2026-01-02T03:04:05Z",
        collab_updated_at: null,
        content: "must never be carried along",
      }),
    ).toEqual({
      id: "proj_1",
      title: "T",
      study_type: "cohort",
      owner_id: "u1",
      role: "editor",
      rev: 3,
      content_updated_at: 1_700_000_000_000,
      created_at: 10,
      updated_at: Date.UTC(2026, 0, 2, 3, 4, 5),
      collab_updated_at: null,
    });
  });

  it("has no role when the row carries none or an unknown one, and no negative revision", () => {
    expect(projectFromRow({ id: "p", rev: -4 })).toMatchObject({ rev: 0, content_updated_at: null, created_at: 0 });
    expect(projectFromRow({ id: "p" })).not.toHaveProperty("role");
    expect(projectFromRow({ id: "p", role: "admin" })).not.toHaveProperty("role");
  });

  it("drops rows that have no id", () => {
    for (const row of [null, undefined, "x", 3, [], {}, { id: "" }, { id: 7 }]) expect(projectFromRow(row)).toBeNull();
    for (const row of [null, {}, { user_id: "" }]) expect(memberFromRow(row)).toBeNull();
    for (const row of [null, {}, { id: null }]) expect(activityFromRow(row)).toBeNull();
  });

  it("reads a member and an activity entry", () => {
    expect(memberFromRow({ project_id: "p", user_id: "u1", role: "supervisor", added_at: 5, email: "a@example.test", name: "Ada" })).toEqual({
      project_id: "p",
      user_id: "u1",
      role: "supervisor",
      added_at: 5,
      email: "a@example.test",
      name: "Ada",
    });
    // A deleted account keeps its row with an empty email.
    expect(memberFromRow({ user_id: "u2", role: "nonsense" })).toMatchObject({ email: "", name: "", role: "viewer" });
    expect(activityFromRow({ id: 12, project_id: "p", actor_id: null, actor_name: "Deleted user", action: "comment.add", detail: null, created_at: 9 })).toEqual({
      id: "12",
      project_id: "p",
      actor_id: null,
      actor_name: "Deleted user",
      action: "comment.add",
      detail: null,
      created_at: 9,
    });
  });
});

describe("summarizeActivity", () => {
  const entry = (actor_id: string | null, actor_name: string, created_at: number): ActivityEntry => ({
    id: `${actor_id}-${created_at}`,
    project_id: "p",
    actor_id,
    actor_name,
    action: "content.sync",
    detail: null,
    created_at,
  });

  it("is empty for an empty ledger", () => {
    expect(summarizeActivity([])).toEqual([]);
  });

  it("counts per account, busiest first, with the latest time", () => {
    const out = summarizeActivity([entry("u1", "Ada", 10), entry("u2", "Bob", 50), entry("u1", "Ada", 30), entry("u1", "Ada", 20)]);
    expect(out).toEqual([
      { actor: "Ada", actorId: "u1", count: 3, lastAt: 30 },
      { actor: "Bob", actorId: "u2", count: 1, lastAt: 50 },
    ]);
  });

  it("breaks a tie on count by who acted last", () => {
    const out = summarizeActivity([entry("u1", "Ada", 10), entry("u2", "Bob", 50)]);
    expect(out.map((c) => c.actorId)).toEqual(["u2", "u1"]);
  });

  it("tells two people with one name apart, and follows one person through a rename", () => {
    const out = summarizeActivity([entry("u1", "Sam", 10), entry("u2", "Sam", 20), entry("u1", "Samira", 30)]);
    expect(out).toEqual([
      { actor: "Samira", actorId: "u1", count: 2, lastAt: 30 },
      { actor: "Sam", actorId: "u2", count: 1, lastAt: 20 },
    ]);
  });

  it("groups entries of accounts that are gone by the name they were written under", () => {
    const out = summarizeActivity([entry(null, "Deleted user", 10), entry(null, "Deleted user", 20), entry(null, "Old name", 5)]);
    expect(out).toEqual([
      { actor: "Deleted user", actorId: null, count: 2, lastAt: 20 },
      { actor: "Old name", actorId: null, count: 1, lastAt: 5 },
    ]);
  });
});

describe("roles", () => {
  it("lets editors and owners change content, and nobody else", () => {
    expect(canEdit("owner")).toBe(true);
    expect(canEdit("editor")).toBe(true);
    expect(canEdit("supervisor")).toBe(false);
    expect(canEdit("viewer")).toBe(false);
    expect(canEdit(null)).toBe(false);
    expect(canEdit(undefined)).toBe(false);
  });

  it("labels every role", () => {
    expect(ROLE_LABEL).toEqual({ viewer: "Viewer", editor: "Editor", supervisor: "Supervisor", owner: "Owner" });
  });
});

describe("describeSyncError", () => {
  const codes = [
    "invalid_credentials",
    "unauthenticated",
    "account_suspended",
    "password_reset_required",
    "not_configured",
    "offline",
    "network",
    "server_error",
    "rate_limited",
    "forbidden",
    "not_found",
    "not_a_member",
    "last_owner",
    "conflict",
    "invalid_role",
    "invalid_input",
  ];
  const GENERIC = "Something went wrong. Try again in a moment.";

  it("has its own sentence for every code the sync layer meets", () => {
    const seen = new Set<string>();
    for (const code of codes) {
      const copy = describeSyncError(new SyncError(400, code));
      expect(copy, code).not.toBe(GENERIC);
      expect(copy, code).toMatch(/^[A-Z].*\.$/);
      expect(copy, code).not.toMatch(DASHES);
      seen.add(copy);
    }
    expect(seen.size).toBe(codes.length);
  });

  it("says the exact words for the common cases", () => {
    expect(describeSyncError(new SyncError(401, "unauthenticated"))).toBe("Your session has ended. Please sign in again.");
    expect(describeSyncError(new SyncError(0, "offline"))).toBe("You're offline. Connect to the internet and try again.");
    expect(describeSyncError(new SyncError(403, "forbidden"))).toBe("You don't have permission to do that.");
    expect(describeSyncError(new SyncError(409, "last_owner"))).toBe("A project needs at least one owner. Make someone else an owner first.");
  });

  it("never shows a raw code or an internal message", () => {
    expect(describeSyncError(new SyncError(418, "some_new_code"))).toBe(GENERIC);
    expect(describeSyncError(new Error("ECONNRESET at socket 4"))).toBe(GENERIC);
    expect(describeSyncError(undefined)).toBe(GENERIC);
    expect(describeSyncError("constructor")).toBe(GENERIC);
    expect(describeSyncError(new SyncError(400, "constructor"))).toBe(GENERIC);
  });

  it("no longer says whether an email has an account", () => {
    // People join by invitation now; the old add-by-email answer is gone.
    expect(describeSyncError(new SyncError(404, "user_not_found"))).toBe(GENERIC);
  });

  it("recognises errors from the shared error module", () => {
    expect(ReExported).toBe(SyncError);
  });
});

// --- The calls, through a hand-written stand-in for the backend client ---------------

interface Reply {
  data: unknown;
  error: unknown;
  status: number;
}

function fakeClient(replies: Record<string, Reply | (() => Reply)> = {}) {
  const calls: Array<{ fn: string; args?: Record<string, unknown> }> = [];
  const state = { session: { access_token: "t" } as unknown, sessionError: null as unknown, sessionReads: 0 };
  const client: SyncClient = {
    auth: {
      async getSession() {
        state.sessionReads += 1;
        return { data: { session: state.session }, error: state.sessionError };
      },
    },
    rpc(fn, args) {
      calls.push(args === undefined ? { fn } : { fn, args });
      const reply = replies[fn];
      if (!reply) return Promise.resolve({ data: null, error: { code: "PGRST202", message: "no such function" }, status: 404 });
      return Promise.resolve(typeof reply === "function" ? reply() : reply);
    },
  };
  return { client, calls, state };
}

const ok = (data: unknown): Reply => ({ data, error: null, status: 200 });
const refused = (code: string, status: number): Reply => ({ data: null, error: { code, message: code, details: null, hint: null }, status });

async function rejection(promise: Promise<unknown>): Promise<SyncError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(SyncError);
    return e as SyncError;
  }
  throw new Error("expected the call to throw");
}

describe("the three checks before every request", () => {
  it("refuses with not_configured when the build has no backend", async () => {
    const call = createRpcCaller({ client: null });
    expect(await rejection(call("list_my_projects"))).toMatchObject({ code: "not_configured", status: 0 });
    expect(await rejection(createSync({ client: null }).listProjects())).toMatchObject({ code: "not_configured" });
  });

  it("refuses with offline before looking at the session", async () => {
    const f = fakeClient({ list_my_projects: ok({ projects: [] }) });
    const sync = createSync({ client: f.client, online: () => false });
    expect(await rejection(sync.listProjects())).toMatchObject({ code: "offline", status: 0 });
    expect(f.state.sessionReads).toBe(0);
    expect(f.calls).toEqual([]);
  });

  it("refuses with unauthenticated, and makes no request, when nobody is signed in", async () => {
    const f = fakeClient({ list_my_projects: ok({ projects: [] }) });
    f.state.session = null;
    const sync = createSync({ client: f.client, online: () => true });
    expect(await rejection(sync.listProjects())).toMatchObject({ code: "unauthenticated", status: 401 });
    expect(f.calls).toEqual([]);
  });

  it("calls a session that could not be refreshed a connection problem, not a sign-out", async () => {
    const f = fakeClient({ list_my_projects: ok({ projects: [] }) });
    f.state.session = null;
    f.state.sessionError = { name: "AuthRetryableFetchError", message: "Failed to fetch", status: 0 };
    const sync = createSync({ client: f.client, online: () => true });
    expect(await rejection(sync.listProjects())).toMatchObject({ code: "network", status: 0 });
    expect(f.calls).toEqual([]);
  });

  it("maps a client that throws instead of answering", async () => {
    const f = fakeClient();
    f.client.auth.getSession = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await rejection(createSync({ client: f.client, online: () => true }).listProjects())).toMatchObject({ code: "network" });
  });

  it("runs the checks in order: backend, connection, session", async () => {
    const f = fakeClient();
    f.state.session = null;
    expect(await rejection(createRpcCaller({ client: f.client, online: () => false })("x"))).toMatchObject({ code: "offline" });
    expect(await rejection(createRpcCaller({ client: null, online: () => false })("x"))).toMatchObject({ code: "not_configured" });
  });
});

describe("sync calls", () => {
  const setup = (replies: Record<string, Reply | (() => Reply)>) => {
    const f = fakeClient(replies);
    return { ...f, sync: createSync({ client: f.client, online: () => true }) };
  };
  const row = { id: "proj_a", title: "A", study_type: "cohort", owner_id: "u1", rev: 2, content_updated_at: 700, created_at: 1, updated_at: 2, collab_updated_at: null };

  it("lists the caller's projects, each with a role", async () => {
    const s = setup({ list_my_projects: ok({ projects: [{ ...row, role: "editor" }, { ...row, id: "proj_b" }, { title: "no id" }] }) });
    const { projects } = await s.sync.listProjects();
    expect(s.calls).toEqual([{ fn: "list_my_projects" }]);
    expect(projects.map((p) => [p.id, p.role])).toEqual([
      ["proj_a", "editor"],
      // A row without a readable role can never upload.
      ["proj_b", "viewer"],
    ]);
    expect(projects[0]).toMatchObject({ rev: 2, content_updated_at: 700 });
  });

  it("reads an empty or malformed answer as no projects", async () => {
    expect((await setup({ list_my_projects: ok({ projects: [] }) }).sync.listProjects()).projects).toEqual([]);
    expect((await setup({ list_my_projects: ok(null) }).sync.listProjects()).projects).toEqual([]);
  });

  it("creates a project under the id made on the device", async () => {
    const s = setup({ create_project: ok({ project: { ...row, rev: 0, role: "owner" } }) });
    const { project } = await s.sync.createProject("proj_a", "  A  ", "cohort");
    expect(s.calls).toEqual([{ fn: "create_project", args: { p_id: "proj_a", p_title: "A", p_study_type: "cohort" } }]);
    expect(project).toMatchObject({ id: "proj_a", role: "owner", rev: 0 });
  });

  it("reads the content with its revision and edit time", async () => {
    const s = setup({ get_project_content: ok({ content: '{"stepData":{},"stepStatus":{}}', rev: 4, updatedAt: 900 }) });
    expect(await s.sync.getContent("proj_a")).toEqual({ content: '{"stepData":{},"stepStatus":{}}', rev: 4, updatedAt: 900 });
    expect(s.calls).toEqual([{ fn: "get_project_content", args: { p_project_id: "proj_a" } }]);
    const empty = setup({ get_project_content: ok({ content: null, rev: 0, updatedAt: null }) });
    expect(await empty.sync.getContent("proj_a")).toEqual({ content: null, rev: 0, updatedAt: null });
  });

  it("uploads the content as one JSON string with the base revision and edit time", async () => {
    const s = setup({ put_project_content: ok({ ok: true, rev: 5 }) });
    const res = await s.sync.putContent("proj_a", {
      stepData: { q: { a: 1 } },
      stepStatus: { q: { complete: true, needsAttention: false } },
      title: "A",
      baseRev: 4,
      updatedAt: 900.4,
    });
    expect(res).toEqual({ ok: true, rev: 5 });
    expect(s.calls).toEqual([
      {
        fn: "put_project_content",
        args: {
          p_project_id: "proj_a",
          p_content: '{"stepData":{"q":{"a":1}},"stepStatus":{"q":{"complete":true,"needsAttention":false}}}',
          p_base_rev: 4,
          p_updated_at: 900,
          p_title: "A",
        },
      },
    ]);
  });

  it("leaves the title out when there is none, and sends content it was handed as is", async () => {
    const s = setup({ put_project_content: ok({ ok: true, rev: 1 }) });
    await s.sync.putContent("proj_a", { stepData: {}, stepStatus: {}, title: "  ", baseRev: 0, updatedAt: 1, content: "PRE-SERIALISED" });
    expect(s.calls[0].args).toEqual({ p_project_id: "proj_a", p_content: "PRE-SERIALISED", p_base_rev: 0, p_updated_at: 1 });
  });

  it("turns the server's stale-write answer into SyncError(409, conflict) carrying the server copy", async () => {
    const s = setup({ put_project_content: ok({ ok: false, error: "conflict", content: '{"stepData":{"x":1},"stepStatus":{}}', rev: 9, updatedAt: 1234 }) });
    const e = await rejection(s.sync.putContent("proj_a", { stepData: {}, stepStatus: {}, baseRev: 2, updatedAt: 100 }));
    expect(e).toMatchObject({ status: 409, code: "conflict" });
    expect(e.payload).toEqual({ content: '{"stepData":{"x":1},"stepStatus":{}}', rev: 9, updatedAt: 1234 });
  });

  it("does not take an answer it cannot read for success", async () => {
    const s = setup({ put_project_content: ok(null) });
    expect(await rejection(s.sync.putContent("proj_a", { stepData: {}, stepStatus: {}, baseRev: 0, updatedAt: 1 }))).toMatchObject({ code: "server_error" });
  });

  it("reads a project with the caller's role and its members", async () => {
    const member = { project_id: "proj_a", user_id: "u1", role: "owner", added_at: 1, email: "a@example.test", name: "Ada" };
    const s = setup({ get_project: ok({ project: row, role: "supervisor", members: [member, { nope: true }] }) });
    const res = await s.sync.getProject("proj_a");
    expect(s.calls).toEqual([{ fn: "get_project", args: { p_project_id: "proj_a" } }]);
    expect(res.role).toBe("supervisor");
    expect(res.project).toMatchObject({ id: "proj_a", role: "supervisor" });
    expect(res.members).toEqual([member]);
  });

  it("manages members by user id", async () => {
    const member = { project_id: "proj_a", user_id: "u2", role: "viewer", added_at: 1, email: "b@example.test", name: "Bob" };
    const s = setup({
      list_project_members: ok({ members: [member] }),
      set_project_member_role: ok({ members: [{ ...member, role: "editor" }] }),
      remove_project_member: ok({ ok: true }),
      leave_project: ok({ ok: true }),
      delete_project: ok({ ok: true }),
    });
    expect((await s.sync.listMembers("proj_a")).members).toEqual([member]);
    expect((await s.sync.setMemberRole("proj_a", "u2", "editor")).members[0].role).toBe("editor");
    expect(await s.sync.removeMember("proj_a", "u2")).toEqual({ ok: true });
    expect(await s.sync.leaveProject("proj_a")).toEqual({ ok: true });
    expect(await s.sync.deleteProject("proj_a")).toEqual({ ok: true });
    expect(s.calls).toEqual([
      { fn: "list_project_members", args: { p_project_id: "proj_a" } },
      { fn: "set_project_member_role", args: { p_project_id: "proj_a", p_user_id: "u2", p_role: "editor" } },
      { fn: "remove_project_member", args: { p_project_id: "proj_a", p_user_id: "u2" } },
      { fn: "leave_project", args: { p_project_id: "proj_a" } },
      { fn: "delete_project", args: { p_project_id: "proj_a" } },
    ]);
  });

  it("reads the ledger with the server's summary, or makes one when there is none", async () => {
    const e1 = { id: "1", project_id: "proj_a", actor_id: "u1", actor_name: "Ada", action: "content.sync", detail: "rev 2", created_at: 20 };
    const e2 = { ...e1, id: "2", created_at: 10 };
    const withSummary = setup({ get_project_activity: ok({ entries: [e1, e2], contributors: [{ actor: "Ada", actorId: "u1", count: 2, lastAt: 20 }] }) });
    const a = await withSummary.sync.activity("proj_a");
    expect(withSummary.calls).toEqual([{ fn: "get_project_activity", args: { p_project_id: "proj_a" } }]);
    expect(a.entries).toEqual([e1, e2]);
    expect(a.contributors).toEqual([{ actor: "Ada", actorId: "u1", count: 2, lastAt: 20 }]);

    const without = setup({ get_project_activity: ok({ entries: [e1, e2] }) });
    expect((await without.sync.activity("proj_a")).contributors).toEqual([{ actor: "Ada", actorId: "u1", count: 2, lastAt: 20 }]);
  });

  it("passes the backend's own code and status through", async () => {
    const s = setup({
      leave_project: refused("last_owner", 409),
      delete_project: refused("forbidden", 403),
      get_project: refused("not_found", 404),
      list_my_projects: refused("account_suspended", 403),
    });
    expect(await rejection(s.sync.leaveProject("p"))).toMatchObject({ code: "last_owner", status: 409 });
    expect(await rejection(s.sync.deleteProject("p"))).toMatchObject({ code: "forbidden", status: 403 });
    expect(await rejection(s.sync.getProject("p"))).toMatchObject({ code: "not_found", status: 404 });
    expect(await rejection(s.sync.listProjects())).toMatchObject({ code: "account_suspended", status: 403 });
  });

  it("reads a request that never got an answer as a connection problem", async () => {
    // What the client library returns when fetch itself fails.
    const s = setup({ list_my_projects: { data: null, error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" }, status: 0 } });
    expect(await rejection(s.sync.listProjects())).toMatchObject({ code: "network", status: 0 });
  });

  it("reads a call made with the public key alone as not signed in", async () => {
    const s = setup({ list_my_projects: refused("42501", 401) });
    expect(await rejection(s.sync.listProjects())).toMatchObject({ code: "unauthenticated", status: 401 });
  });
});
