/**
 * The account side of a project: the calls that keep a project in a signed-in
 * person's account, share it, and read its team ledger. A clean, removable
 * layer. The offline research core never imports it, and a build with no
 * backend never makes a request.
 *
 * Every call goes to a backend function (`supabase.rpc`). The backend lets no
 * client read a table. Before any request a call checks, in this order: a
 * backend is configured, the device is online, and somebody is signed in.
 * The last check matters: without it a request would go out with the public
 * key alone and be refused in a way that says nothing about why.
 *
 * Every call throws `SyncError`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import { SyncError, notConfiguredError, toSyncError, unauthenticatedError } from "@/lib/supabase/errors";

export { SyncError };

// --- Types -------------------------------------------------------------------------

export type ProjectRole = "viewer" | "editor" | "supervisor" | "owner";

/** A project as the backend describes it. Times are epoch milliseconds. Never carries the content. */
export interface ServerProject {
  id: string;
  title: string;
  study_type: string;
  owner_id: string;
  /** The caller's own role on the project, where the call reports it. */
  role?: ProjectRole;
  /** Content revision. 0 until the first upload. */
  rev: number;
  /** When the content was last edited, by the editing device's clock. Null until the first upload. */
  content_updated_at: number | null;
  created_at: number;
  updated_at: number;
  /** Moves whenever a comment or sign-off of the project is written. Null until the first one. */
  collab_updated_at: number | null;
}

/** A row of the caller's own project list: always carries their role. */
export type ListedProject = ServerProject & { role: ProjectRole };

export interface Member {
  project_id: string;
  user_id: string;
  /** Empty for an account that has been deleted. */
  email: string;
  name: string;
  role: ProjectRole;
  added_at: number;
}

export interface ActivityEntry {
  id: string;
  project_id: string;
  /** The account that acted. Null once that account is gone. */
  actor_id: string | null;
  actor_name: string;
  action: string;
  detail: string | null;
  created_at: number;
}

export interface Contributor {
  /** Display name. Names are free text: tell people apart by `actorId`. */
  actor: string;
  actorId: string | null;
  count: number;
  lastAt: number;
}

export interface ContentPayload {
  stepData: Record<string, unknown>;
  stepStatus: Record<string, { complete: boolean; needsAttention: boolean }>;
  title?: string;
  /** The server revision this device last synced from. */
  baseRev: number;
  /** When this copy was last edited, by this device's clock. */
  updatedAt: number;
  /** `serializeContent` of the two maps above, when the caller already has it. */
  content?: string;
}

export interface ServerContent {
  /** The content document as a JSON string. Null until the first upload. */
  content: string | null;
  rev: number;
  updatedAt: number | null;
}

/** What a refused upload carries in `SyncError.payload`: the newer server copy. */
export type ConflictPayload = ServerContent;

// --- Reading what the backend returns (pure) ---------------------------------------

const ROLES: readonly ProjectRole[] = ["viewer", "editor", "supervisor", "owner"];

/** Titles the backend accepts are 1 to 300 characters long. */
export const TITLE_MAX = 300;
const UNTITLED = "Untitled project";

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function rows(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function roleOf(v: unknown): ProjectRole | undefined {
  return ROLES.includes(v as ProjectRole) ? (v as ProjectRole) : undefined;
}

/**
 * A time from the backend as epoch milliseconds. The backend sends numbers;
 * a numeric string or an ISO date is accepted too. Anything else is `null`.
 */
export function toMs(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  const parsed = Date.parse(v);
  return Number.isNaN(parsed) ? null : parsed;
}

/** A title the backend will accept: trimmed, never empty, at most 300 characters. */
export function serverTitle(title: string | null | undefined): string {
  const trimmed = (title ?? "").trim();
  if (trimmed === "") return UNTITLED;
  // Counted in whole characters, so a long title is never cut inside an emoji.
  const chars = Array.from(trimmed);
  return chars.length <= TITLE_MAX ? trimmed : chars.slice(0, TITLE_MAX).join("");
}

/** The content document exactly as it is uploaded and stored. */
export function serializeContent(content: Pick<ContentPayload, "stepData" | "stepStatus">): string {
  return JSON.stringify({ stepData: content.stepData, stepStatus: content.stepStatus });
}

/** A project row, or `null` when it has no usable id. */
export function projectFromRow(row: unknown): ServerProject | null {
  const r = record(row);
  if (!r || typeof r.id !== "string" || r.id === "") return null;
  const role = roleOf(r.role);
  return {
    id: r.id,
    title: text(r.title),
    study_type: text(r.study_type),
    owner_id: text(r.owner_id),
    ...(role ? { role } : {}),
    rev: count(r.rev),
    content_updated_at: toMs(r.content_updated_at),
    created_at: toMs(r.created_at) ?? 0,
    updated_at: toMs(r.updated_at) ?? 0,
    collab_updated_at: toMs(r.collab_updated_at),
  };
}

/** A row of the caller's list. An unreadable role counts as the least one, so it can never upload. */
function listedFromRow(row: unknown): ListedProject | null {
  const project = projectFromRow(row);
  return project ? { ...project, role: project.role ?? "viewer" } : null;
}

export function memberFromRow(row: unknown): Member | null {
  const r = record(row);
  if (!r || typeof r.user_id !== "string" || r.user_id === "") return null;
  return {
    project_id: text(r.project_id),
    user_id: r.user_id,
    email: text(r.email),
    name: text(r.name),
    role: roleOf(r.role) ?? "viewer",
    added_at: toMs(r.added_at) ?? 0,
  };
}

function members(v: unknown): Member[] {
  return rows(v)
    .map(memberFromRow)
    .filter((m): m is Member => m !== null);
}

export function activityFromRow(row: unknown): ActivityEntry | null {
  const r = record(row);
  if (!r || (typeof r.id !== "string" && typeof r.id !== "number")) return null;
  return {
    id: String(r.id),
    project_id: text(r.project_id),
    actor_id: typeof r.actor_id === "string" && r.actor_id !== "" ? r.actor_id : null,
    actor_name: text(r.actor_name),
    action: text(r.action),
    detail: typeof r.detail === "string" ? r.detail : null,
    created_at: toMs(r.created_at) ?? 0,
  };
}

function contributorFromRow(row: unknown): Contributor | null {
  const r = record(row);
  if (!r) return null;
  return {
    actor: text(r.actor),
    actorId: typeof r.actorId === "string" && r.actorId !== "" ? r.actorId : null,
    count: count(r.count),
    lastAt: toMs(r.lastAt) ?? 0,
  };
}

/**
 * Collapse a ledger into one line per person, busiest first. People are told
 * apart by account, not by name: two members may share a name, and one member
 * may have changed theirs. The newest name is shown. Entries whose account is
 * gone are grouped by the name they were written under.
 */
export function summarizeActivity(entries: readonly ActivityEntry[]): Contributor[] {
  const byActor = new Map<string, Contributor & { nameAt: number }>();
  for (const e of entries) {
    const key = e.actor_id !== null ? `id:${e.actor_id}` : `name:${e.actor_name}`;
    const cur = byActor.get(key) ?? { actor: e.actor_name, actorId: e.actor_id, count: 0, lastAt: 0, nameAt: -Infinity };
    cur.count += 1;
    cur.lastAt = Math.max(cur.lastAt, e.created_at);
    if (e.created_at > cur.nameAt) {
      cur.actor = e.actor_name;
      cur.nameAt = e.created_at;
    }
    byActor.set(key, cur);
  }
  return [...byActor.values()]
    .map(({ actor, actorId, count, lastAt }) => ({ actor, actorId, count, lastAt }))
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt || a.actor.localeCompare(b.actor));
}

function contentFromRow(row: unknown): ServerContent {
  const r = record(row) ?? {};
  return { content: typeof r.content === "string" ? r.content : null, rev: count(r.rev), updatedAt: toMs(r.updatedAt) };
}

// --- The guarded call --------------------------------------------------------------
// A narrow structural view of the Supabase client, so tests can pass a plain
// hand-written object.

export interface SyncClient {
  auth: {
    getSession(): Promise<{ data: { session: unknown }; error: unknown }>;
  };
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown; status: number }>;
}

export interface SyncDeps {
  /** The backend client, or `null` in a build with no backend. */
  client: SyncClient | null;
  /** Whether the device reports a connection. Tests pass their own. */
  online?: () => boolean;
}

/** Calls one backend function for the signed-in person and returns its answer. */
export type RpcCaller = <T = unknown>(fn: string, args?: Record<string, unknown>) => Promise<T>;

function deviceOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/** The real client seen through the narrow view above. */
export function syncClientOf(c: SupabaseClient | null): SyncClient | null {
  if (!c) return null;
  return {
    auth: { getSession: () => c.auth.getSession() },
    rpc: (fn, args) => c.rpc(fn, args),
  };
}

export function createRpcCaller(deps: SyncDeps): RpcCaller {
  const online = deps.online ?? deviceOnline;
  return async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
    const client = deps.client;
    if (!client) throw notConfiguredError();
    if (!online()) throw new SyncError(0, "offline");

    let session: unknown;
    try {
      const current = await client.auth.getSession();
      // A session that could not be refreshed because the backend is out of
      // reach is a connection problem, not a sign-out.
      if (current.error) {
        const mapped = toSyncError(current.error, undefined, { online: online() });
        if (mapped.code === "network" || mapped.code === "offline") throw mapped;
      }
      session = current.data.session;
    } catch (e) {
      throw toSyncError(e, undefined, { online: online() });
    }
    if (!session) throw unauthenticatedError();

    let result: { data: unknown; error: unknown; status: number };
    try {
      result = await (args === undefined ? client.rpc(fn) : client.rpc(fn, args));
    } catch (e) {
      throw toSyncError(e, undefined, { online: online() });
    }
    if (result.error) throw toSyncError(result.error, result.status, { online: online() });
    return result.data as T;
  };
}

// --- The calls -----------------------------------------------------------------------

export function createSync(deps: SyncDeps) {
  const call = createRpcCaller(deps);

  return {
    /** The projects in the caller's account, most recently touched first. An empty list really means none. */
    async listProjects(): Promise<{ projects: ListedProject[] }> {
      const data = record(await call("list_my_projects"));
      return {
        projects: rows(data?.projects)
          .map(listedFromRow)
          .filter((p): p is ListedProject => p !== null),
      };
    },

    /**
     * Create the server copy under an id made on this device (`newServerProjectId`).
     * Safe to repeat: the same id returns the same project.
     */
    async createProject(id: string, title: string, studyType: string): Promise<{ project: ListedProject }> {
      const data = record(await call("create_project", { p_id: id, p_title: serverTitle(title), p_study_type: studyType }));
      const project = listedFromRow(data?.project);
      if (!project) throw new SyncError(500, "server_error");
      return { project: { ...project, role: "owner" } };
    },

    async getContent(id: string): Promise<ServerContent> {
      return contentFromRow(await call("get_project_content", { p_project_id: id }));
    },

    /**
     * Upload the whole content. Editors and owners only. When the server holds
     * a newer copy the upload is refused with `SyncError(409, "conflict")`,
     * whose payload is that copy (`ConflictPayload`).
     */
    async putContent(id: string, payload: ContentPayload): Promise<{ ok: true; rev: number }> {
      const args: Record<string, unknown> = {
        p_project_id: id,
        p_content: payload.content ?? serializeContent(payload),
        p_base_rev: count(payload.baseRev),
        p_updated_at: Math.max(0, Math.round(payload.updatedAt) || 0),
      };
      if (payload.title !== undefined && payload.title.trim() !== "") args.p_title = serverTitle(payload.title);
      const data = record(await call("put_project_content", args));
      if (data?.ok === true) return { ok: true, rev: count(data.rev) };
      if (data?.ok === false) throw new SyncError(409, "conflict", contentFromRow(data) satisfies ConflictPayload);
      throw new SyncError(500, "server_error");
    },

    async getProject(id: string): Promise<{ project: ServerProject; role: ProjectRole; members: Member[] }> {
      const data = record(await call("get_project", { p_project_id: id }));
      const project = projectFromRow(data?.project);
      const role = roleOf(data?.role);
      if (!project || !role) throw new SyncError(500, "server_error");
      return { project: { ...project, role }, role, members: members(data?.members) };
    },

    async listMembers(id: string): Promise<{ members: Member[] }> {
      const data = record(await call("list_project_members", { p_project_id: id }));
      return { members: members(data?.members) };
    },

    /** Owner only. Returns the whole member list. */
    async setMemberRole(id: string, userId: string, role: ProjectRole): Promise<{ members: Member[] }> {
      const data = record(await call("set_project_member_role", { p_project_id: id, p_user_id: userId, p_role: role }));
      return { members: members(data?.members) };
    },

    /** Owner only. */
    async removeMember(id: string, userId: string): Promise<{ ok: true }> {
      await call("remove_project_member", { p_project_id: id, p_user_id: userId });
      return { ok: true };
    },

    /** Any member removes themselves. The only owner gets `last_owner`. */
    async leaveProject(id: string): Promise<{ ok: true }> {
      await call("leave_project", { p_project_id: id });
      return { ok: true };
    },

    /** Owner only. Removes the project for every member. */
    async deleteProject(id: string): Promise<{ ok: true }> {
      await call("delete_project", { p_project_id: id });
      return { ok: true };
    },

    /** The team ledger, newest first, with one summary line per person. */
    async activity(id: string): Promise<{ entries: ActivityEntry[]; contributors: Contributor[] }> {
      const data = record(await call("get_project_activity", { p_project_id: id }));
      const entries = rows(data?.entries)
        .map(activityFromRow)
        .filter((e): e is ActivityEntry => e !== null);
      // The backend sends the summary; an answer without one is summarised here.
      const summary = data?.contributors;
      const contributors = Array.isArray(summary)
        ? summary.map(contributorFromRow).filter((c): c is Contributor => c !== null)
        : summarizeActivity(entries);
      return { entries, contributors };
    },
  };
}

export type SyncApi = ReturnType<typeof createSync>;

const deps: SyncDeps = { client: syncClientOf(supabase) };

export const sync = createSync(deps);

/**
 * Call any backend function as the signed-in person, behind the same three
 * checks as `sync`. For the layers built on top (invitations, comments).
 */
export const callRpc: RpcCaller = createRpcCaller(deps);

// --- Roles and copy ------------------------------------------------------------------

export const ROLE_LABEL: Record<ProjectRole, string> = {
  viewer: "Viewer",
  editor: "Editor",
  supervisor: "Supervisor",
  owner: "Owner",
};

/** Whether a role may change a project's content. Viewers and supervisors read; their edits never upload. */
export function canEdit(role: ProjectRole | null | undefined): boolean {
  return role === "editor" || role === "owner";
}

const COPY: Record<string, string> = {
  invalid_credentials: "Email or password is incorrect.",
  unauthenticated: "Your session has ended. Please sign in again.",
  account_suspended: "This account is suspended. Contact an administrator.",
  password_reset_required: "Choose a password to finish setting up your account.",
  not_configured: "Accounts aren't set up in this build of Scholea.",
  offline: "You're offline. Connect to the internet and try again.",
  network: "Can't reach the Scholea server. Check your connection and try again.",
  server_error: "Something went wrong on our side. Try again in a moment.",
  rate_limited: "Too many attempts. Wait a few minutes and try again.",
  forbidden: "You don't have permission to do that.",
  not_found: "This project is no longer in your account.",
  not_a_member: "That person is no longer a member of this project.",
  last_owner: "A project needs at least one owner. Make someone else an owner first.",
  conflict: "A newer copy of this project is already in your account.",
  too_large: "This project is larger than an account can hold (20 MB), so it was not uploaded. It is still saved on this device.",
  invalid_role: "That role can't be used here.",
  invalid_input: "The server did not accept that. Check it and try again.",
};

/** The sentence to show for a failed sync or sharing action. */
export function describeSyncError(e: unknown): string {
  if (e instanceof SyncError && Object.hasOwn(COPY, e.code)) return COPY[e.code];
  return "Something went wrong. Try again in a moment.";
}
