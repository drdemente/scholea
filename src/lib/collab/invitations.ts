/**
 * Project invitations. An owner invites an email address; whoever has
 * confirmed that address sees the invitation in Scholea and accepts or
 * declines it. Accepting is the only way to join someone else's project, so
 * nothing reaches a device without its owner saying yes.
 *
 * Scholea sends no invitation email. A decline is silent: to the inviting
 * owner a declined invitation looks pending until it expires.
 *
 * Like `sync.ts` this is part of the removable account layer, and every call
 * throws `SyncError`.
 */
import { create } from "zustand";
import { SyncError, callRpc, describeSyncError, toMs, type Member, type ProjectRole, type RpcCaller } from "./sync";

// --- Types -------------------------------------------------------------------------

/** Roles an invitation can carry. Ownership is given to someone who is already a member. */
export type InviteRole = Exclude<ProjectRole, "owner">;

export const INVITE_ROLES: readonly InviteRole[] = ["viewer", "editor", "supervisor"];
export const DEFAULT_INVITE_ROLE: InviteRole = "editor";

/** What inviting returns. Times are epoch milliseconds. */
export interface ProjectInvitation {
  id: string;
  project_id: string;
  email: string;
  role: InviteRole;
  created_at: number;
  expires_at: number;
}

/** An open invitation as the project's owners see it. It has no status: see the note on declines above. */
export interface PendingInvitation {
  id: string;
  email: string;
  role: InviteRole;
  invited_by_name: string;
  created_at: number;
  expires_at: number;
}

/** An invitation waiting for the signed-in person. */
export interface MyInvitation {
  id: string;
  project_id: string;
  project_title: string;
  study_type: string;
  role: InviteRole;
  inviter_name: string;
  inviter_email: string;
  created_at: number;
  expires_at: number;
}

// --- Email addresses (pure) ----------------------------------------------------------

/** The form the backend stores and compares: trimmed and in lower case. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The same shape check the backend applies, so a typo is caught before a request is made. */
export function isValidEmail(email: string): boolean {
  const e = normaliseEmail(email);
  return e.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
}

// --- Reading what the backend returns (pure) ---------------------------------------

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function inviteRole(v: unknown): InviteRole {
  // An unreadable role is shown as the least one.
  return INVITE_ROLES.includes(v as InviteRole) ? (v as InviteRole) : "viewer";
}

function list<T>(v: unknown, read: (row: unknown) => T | null): T[] {
  return (Array.isArray(v) ? v : []).map(read).filter((x): x is T => x !== null);
}

function sentInvitation(row: unknown): ProjectInvitation | null {
  const r = record(row);
  if (!r || typeof r.id !== "string") return null;
  return {
    id: r.id,
    project_id: text(r.project_id),
    email: text(r.email),
    role: inviteRole(r.role),
    created_at: toMs(r.created_at) ?? 0,
    expires_at: toMs(r.expires_at) ?? 0,
  };
}

function pendingInvitation(row: unknown): PendingInvitation | null {
  const r = record(row);
  if (!r || typeof r.id !== "string") return null;
  return {
    id: r.id,
    email: text(r.email),
    role: inviteRole(r.role),
    invited_by_name: text(r.invited_by_name),
    created_at: toMs(r.created_at) ?? 0,
    expires_at: toMs(r.expires_at) ?? 0,
  };
}

function myInvitation(row: unknown): MyInvitation | null {
  const r = record(row);
  if (!r || typeof r.id !== "string") return null;
  return {
    id: r.id,
    project_id: text(r.project_id),
    project_title: text(r.project_title),
    study_type: text(r.study_type),
    role: inviteRole(r.role),
    inviter_name: text(r.inviter_name),
    inviter_email: text(r.inviter_email),
    created_at: toMs(r.created_at) ?? 0,
    expires_at: toMs(r.expires_at) ?? 0,
  };
}

// --- The calls -----------------------------------------------------------------------

export function createInvitationsApi(call: RpcCaller) {
  return {
    /**
     * Owner only. The answer is the same whether or not the address has an
     * account. Inviting an address again changes the role of its open invitation.
     */
    async invite(projectId: string, email: string, role: InviteRole): Promise<{ invitation: ProjectInvitation }> {
      const address = normaliseEmail(email);
      if (!isValidEmail(address)) throw new SyncError(400, "invalid_email");
      const data = record(await call("invite_project_member", { p_project_id: projectId, p_email: address, p_role: role }));
      const invitation = sentInvitation(data?.invitation);
      if (!invitation) throw new SyncError(500, "server_error");
      return { invitation };
    },

    /** Owner only. The project's open invitations, oldest first. */
    async listForProject(projectId: string): Promise<{ invitations: PendingInvitation[] }> {
      const data = record(await call("list_project_invitations", { p_project_id: projectId }));
      return { invitations: list(data?.invitations, pendingInvitation) };
    },

    /** Owner of the invitation's project. */
    async cancel(invitationId: string): Promise<{ ok: true }> {
      await call("cancel_project_invitation", { p_invitation_id: invitationId });
      return { ok: true };
    },

    /** The invitations waiting for the signed-in person, newest first. */
    async listMine(): Promise<{ invitations: MyInvitation[] }> {
      const data = record(await call("list_my_invitations"));
      return { invitations: list(data?.invitations, myInvitation) };
    },

    /** Join the project. The next sync downloads it. */
    async accept(invitationId: string): Promise<{ projectId: string; role: ProjectRole }> {
      const data = record(await call("accept_project_invitation", { p_invitation_id: invitationId }));
      const projectId = text(data?.project_id);
      if (!projectId) throw new SyncError(500, "server_error");
      return { projectId, role: inviteRole(data?.role) };
    },

    async decline(invitationId: string): Promise<{ ok: true }> {
      await call("decline_project_invitation", { p_invitation_id: invitationId });
      return { ok: true };
    },
  };
}

export type InvitationsApi = ReturnType<typeof createInvitationsApi>;

export const invitations: InvitationsApi = createInvitationsApi(callRpc);

// --- Lists and labels (pure) ---------------------------------------------------------

/** The list without one invitation. Returns the same array when the id is not in it. */
export function removeInvitation<T extends { id: string }>(items: readonly T[], id: string): T[] {
  const next = items.filter((item) => item.id !== id);
  return next.length === items.length ? (items as T[]) : next;
}

export type MemberRow =
  | { kind: "member"; key: string; userId: string; email: string; name: string; role: ProjectRole }
  | {
      kind: "invitation";
      key: string;
      invitationId: string;
      email: string;
      role: InviteRole;
      invitedByName: string;
      expiresAt: number;
    };

/**
 * One list for the Share dialog: the members first, in the order given, then
 * the open invitations. An invitation whose address already belongs to a
 * member is left out (the two lists were read a moment apart).
 */
export function memberRows(members: readonly Member[], pending: readonly PendingInvitation[]): MemberRow[] {
  const joined = new Set(members.map((m) => normaliseEmail(m.email)).filter((e) => e !== ""));
  const out: MemberRow[] = members.map((m) => ({
    kind: "member",
    key: `member:${m.user_id}`,
    userId: m.user_id,
    email: m.email,
    name: m.name,
    role: m.role,
  }));
  for (const i of pending) {
    if (joined.has(normaliseEmail(i.email))) continue;
    out.push({
      kind: "invitation",
      key: `invitation:${i.id}`,
      invitationId: i.id,
      email: i.email,
      role: i.role,
      invitedByName: i.invited_by_name,
      expiresAt: i.expires_at,
    });
  }
  return out;
}

/** Accessible name for the "Invitations" entry and its count pill. */
export function invitationBadgeLabel(count: number): string {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return n === 0 ? "Invitations" : `Invitations, ${n} pending`;
}

const INVITE_COPY: Record<string, string> = {
  already_member: "That person is already a member of this project.",
  too_many_invitations: "This project already has 20 pending invitations. Cancel one before inviting someone else.",
  invite_rate_limited: "You have sent a lot of invitations today. Try again tomorrow.",
  invalid_email: "Enter a valid email address.",
  invalid_role: "Choose Viewer, Editor or Supervisor.",
  invitation_expired: "This invitation has expired. Ask the project owner to invite you again.",
  invitation_invalid: "This invitation is no longer valid.",
};

/**
 * The sentence to show for a failed invitation action. `respond` is the
 * invited person accepting or declining; `manage` is an owner inviting or
 * cancelling. The two differ in what "not found" refers to.
 */
export function describeInviteError(e: unknown, context: "respond" | "manage" = "respond"): string {
  if (e instanceof SyncError) {
    if (Object.hasOwn(INVITE_COPY, e.code)) return INVITE_COPY[e.code];
    if (e.code === "not_found" && context === "respond") return INVITE_COPY.invitation_invalid;
    if (e.code === "forbidden" && context === "manage") return "Only an owner can invite people to this project.";
  }
  return describeSyncError(e);
}

/** An invitation that failed with one of these can never be answered: it leaves the list. */
function isDead(e: unknown): boolean {
  return e instanceof SyncError && ["invitation_expired", "invitation_invalid", "not_found"].includes(e.code);
}

// --- The signed-in person's invitations ----------------------------------------------

export interface InvitationsState {
  /** Invitations waiting for the signed-in person, newest first. */
  items: MyInvitation[];
  /** True once the backend has answered for this person. */
  loaded: boolean;
  /** Read the list again. Never throws: when the backend cannot be reached the list stays as it is. */
  refresh(): Promise<void>;
  /** Join the project. The sync layer then downloads it in the background. Throws `SyncError`. */
  accept(id: string): Promise<{ projectId: string; role: ProjectRole }>;
  /** Throws `SyncError`. */
  decline(id: string): Promise<void>;
  /** Forget everything. Run when the person signs out. */
  clear(): void;
}

export interface InvitationsDeps {
  api: Pick<InvitationsApi, "listMine" | "accept" | "decline">;
  /** Runs after an invitation is accepted, so the project is downloaded. */
  afterAccept?: () => void | Promise<void>;
}

export function createInvitationsStore(deps: InvitationsDeps) {
  // Bumped by clear(), so an answer that arrives after a sign-out is dropped.
  let epoch = 0;

  return create<InvitationsState>((set, get) => ({
    items: [],
    loaded: false,

    async refresh() {
      const at = epoch;
      try {
        const { invitations: items } = await deps.api.listMine();
        if (at === epoch) set({ items, loaded: true });
      } catch (e) {
        // Signed out, or no backend in this build: nothing is waiting for anyone.
        const gone = e instanceof SyncError && (e.code === "unauthenticated" || e.code === "not_configured");
        if (gone && at === epoch) set({ items: [], loaded: false });
      }
    },

    async accept(id) {
      const at = epoch;
      let result: { projectId: string; role: ProjectRole };
      try {
        result = await deps.api.accept(id);
      } catch (e) {
        if (isDead(e) && at === epoch) set({ items: removeInvitation(get().items, id) });
        throw e;
      }
      if (at === epoch) set({ items: removeInvitation(get().items, id) });
      // Not waited for: the answer is already "you are in", and the download
      // can take a while. If it fails, the next sync downloads the project.
      void Promise.resolve()
        .then(() => deps.afterAccept?.())
        .catch(() => {});
      return result;
    },

    async decline(id) {
      const at = epoch;
      try {
        await deps.api.decline(id);
      } catch (e) {
        if (isDead(e) && at === epoch) set({ items: removeInvitation(get().items, id) });
        throw e;
      }
      if (at === epoch) set({ items: removeInvitation(get().items, id) });
    },

    clear() {
      epoch += 1;
      set({ items: [], loaded: false });
    },
  }));
}

const acceptedListeners = new Set<() => void | Promise<void>>();

/**
 * Be told when the signed-in person accepts an invitation. The sync layer uses
 * this to download the project straight away. Returns the unsubscribe.
 */
export function onInvitationAccepted(listener: () => void | Promise<void>): () => void {
  acceptedListeners.add(listener);
  return () => {
    acceptedListeners.delete(listener);
  };
}

export const useInvitations = createInvitationsStore({
  api: invitations,
  afterAccept: async () => {
    await Promise.all([...acceptedListeners].map((listener) => listener()));
  },
});
