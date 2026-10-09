/**
 * Local-first project sync. The research core keeps every project in Dexie and
 * works from there. For a signed-in person this layer mirrors the projects of
 * their account between this device and the backend, so work follows them
 * across installs and reaches their collaborators. It is a removable layer:
 * the offline core never imports it.
 *
 * The rules, in the words used for people: projects in your account appear
 * only while you are signed in; projects kept on this device always appear and
 * are never uploaded unless you choose "Add to my account".
 *
 * What that means here:
 * - Only projects linked to the signed-in account, and projects made while
 *   signed in, are ever synced (`selectSyncable`). Work done as a guest is
 *   pinned to the device the moment someone signs in, before the first sync.
 * - Content is whole-project, last writer wins, decided by revision and edit
 *   time. A save that changed nothing is not an edit and is never uploaded.
 *   The server copy is only ever taken when its revision has moved on: at the
 *   revision this device last synced from, nothing there can be newer.
 * - Work that has never reached the account is never replaced by somebody
 *   else's copy. If the two cannot both stand, this device keeps its own as a
 *   separate copy.
 * - Viewers and supervisors never upload. They receive the team's copy, and
 *   what they typed meanwhile is not uploaded later either.
 * - A project whose server copy has gone is kept as a device-only copy. It is
 *   never re-created and never deleted.
 * - A project deleted on this device is deleted in the account too (or left,
 *   for a member who is not an owner), now or at the next sync. What is sent
 *   is what the person confirmed: a "leave" never becomes a "delete".
 */
import { create } from "zustand";
import { useSession } from "@/lib/account/session-store";
import type { SessionData } from "@/lib/account/session-logic";
import { db, type Project, type StudyTypeId } from "@/lib/db/schema";
import { useProject } from "@/lib/study/project-store";
import { isConnectivityError, unauthenticatedError } from "@/lib/supabase/errors";
import { reconcileCollab, startCollabSync, stopCollabSync } from "./collab-sync";
import { onInvitationAccepted, useInvitations } from "./invitations";
import {
  TOMBSTONES_KEY,
  awaitsFirstUpload,
  getLink,
  isVisible,
  listLinks,
  newServerProjectId,
  pinUnlinked,
  removeLink,
  selectSyncable,
  setLink,
  type AccountLink,
  type Link,
} from "./links";
import {
  SyncError,
  canEdit,
  serializeContent,
  sync,
  type ConflictPayload,
  type ListedProject,
  type ServerContent,
  type SyncApi,
} from "./sync";

// --- Pure sync planner (unit-tested) -----------------------------------------

export interface LocalMeta {
  localId: string;
  updatedAt: number;
  /**
   * The link to the server copy: its id, the revision last synced from, and
   * whether the server has confirmed the project exists. `null` for a new
   * project that has no record yet.
   */
  link: { serverId: string; rev: number; created: boolean } | null;
}
export interface ServerMeta {
  id: string;
  rev: number;
  /** When the content was last edited (the editing device's clock). 0 before the first upload. */
  updatedAt: number;
  /** Whether the signed-in person may upload: editors and owners. */
  canPush: boolean;
}

export type SyncAction =
  | { type: "createRemote"; localId: string }
  | { type: "push"; localId: string; serverId: string; baseRev: number }
  | { type: "pull"; localId: string; serverId: string; rev: number }
  | { type: "pullNew"; serverId: string; rev: number }
  | { type: "detach"; localId: string; serverId: string };

/**
 * Decide, purely, what to upload and download. `local` is only what the
 * signed-in person may sync (see `syncableMeta`); `server` is their project
 * list; `tombstones` are server ids deleted on this device whose deletion has
 * not reached the server yet.
 *
 *   no record, or not confirmed on the server     -> createRemote
 *   linked, but gone from the server list         -> detach (never re-created)
 *   may not upload                                -> pull when the server revision advanced
 *   server still at the revision synced from      -> push if saved at another time, never pull
 *   local edited later than the server copy       -> push (local newer wins)
 *   server revision advanced, and edited later    -> pull
 *   in the server list with no local copy         -> pullNew, unless tombstoned
 *
 * A planned push is only a candidate: the engine uploads it if the content
 * really changed (`settlePush`).
 */
export function planSync(
  local: readonly LocalMeta[],
  server: readonly ServerMeta[],
  tombstones: Iterable<string> = [],
): SyncAction[] {
  const serverById = new Map(server.map((s) => [s.id, s]));
  const deleted = new Set(tombstones);
  const linked = new Set<string>();
  const actions: SyncAction[] = [];

  for (const l of local) {
    if (!l.link) {
      actions.push({ type: "createRemote", localId: l.localId });
      continue;
    }
    linked.add(l.link.serverId);
    // Being deleted: nothing more goes either way.
    if (deleted.has(l.link.serverId)) continue;
    if (!l.link.created) {
      // The create may or may not have arrived. Repeating it is harmless.
      actions.push({ type: "createRemote", localId: l.localId });
      continue;
    }
    const s = serverById.get(l.link.serverId);
    if (!s) {
      // Deleted by its owner, or this person was removed or left elsewhere.
      actions.push({ type: "detach", localId: l.localId, serverId: l.link.serverId });
      continue;
    }
    if (!s.canPush) {
      if (s.rev > l.link.rev) actions.push({ type: "pull", localId: l.localId, serverId: s.id, rev: s.rev });
      continue;
    }
    if (s.rev === l.link.rev) {
      // The server copy is the one this device last synced from, so only this
      // device can hold anything newer, whatever the two clocks say. Taking
      // the server copy here could only throw local work away.
      if (l.updatedAt !== s.updatedAt) actions.push({ type: "push", localId: l.localId, serverId: s.id, baseRev: l.link.rev });
    } else if (l.updatedAt > s.updatedAt) {
      actions.push({ type: "push", localId: l.localId, serverId: s.id, baseRev: l.link.rev });
    } else if (s.rev > l.link.rev || s.updatedAt > l.updatedAt) {
      actions.push({ type: "pull", localId: l.localId, serverId: s.id, rev: s.rev });
    }
  }

  for (const s of server) {
    if (!linked.has(s.id) && !deleted.has(s.id)) actions.push({ type: "pullNew", serverId: s.id, rev: s.rev });
  }
  return actions;
}

/**
 * What the planner sees of this device: only the projects the signed-in person
 * may sync. Projects pinned to the device and projects of another account are
 * left out, so no action can ever be planned for them.
 */
export function syncableMeta(
  projects: readonly Pick<Project, "id" | "updatedAt">[],
  links: ReadonlyMap<string, Link>,
  userId: string,
): LocalMeta[] {
  return selectSyncable(projects, links, userId).syncable.map((p) => {
    const link = links.get(p.id);
    return {
      localId: p.id,
      updatedAt: p.updatedAt,
      link: link?.kind === "account" ? { serverId: link.serverId, rev: link.rev, created: link.created } : null,
    };
  });
}

/** What the planner sees of the server list. */
export function serverMetaOf(listed: readonly ListedProject[]): ServerMeta[] {
  // Deliberately not `updated_at`: that is the server's clock and also moves
  // for reasons other than an edit, so it cannot be compared to an edit time.
  return listed.map((s) => ({ id: s.id, rev: s.rev, updatedAt: s.content_updated_at ?? 0, canPush: canEdit(s.role) }));
}

/**
 * Links to rewrite after reading the server list.
 *
 * A link of the signed-in person to a project in their list gets their current
 * role and is known to exist.
 *
 * A link of ANOTHER account to such a project is the case of two members of
 * one shared project using the same device. The second person takes that copy
 * over, instead of downloading a duplicate, but only when it is safe: the copy
 * holds nothing its owner has not uploaded (`isClean`), and this person has no
 * copy of the project yet. Otherwise the other account's copy is left exactly
 * as it is, hidden, and the project is downloaded separately.
 *
 * `leaving` are the server projects this person has deleted or left on this
 * device. The list may still name them (it was read before the server was
 * told), and nobody else's copy is taken over for one of those.
 */
export function linkUpdates(
  links: ReadonlyMap<string, Link>,
  listed: readonly Pick<ListedProject, "id" | "role">[],
  userId: string,
  isClean: (localId: string, link: AccountLink) => boolean = () => true,
  leaving: ReadonlySet<string> = new Set(),
): Map<string, AccountLink> {
  const roleById = new Map(listed.map((s) => [s.id, s.role]));
  /** Server projects this person already has a copy of on this device. */
  const mine = new Set<string>();
  for (const link of links.values()) {
    if (link.kind === "account" && link.owner === userId) mine.add(link.serverId);
  }

  const out = new Map<string, AccountLink>();
  for (const [localId, link] of links) {
    if (link.kind !== "account") continue;
    const role = roleById.get(link.serverId);
    if (role === undefined) continue;
    if (link.owner !== userId) {
      if (mine.has(link.serverId) || leaving.has(link.serverId) || !isClean(localId, link)) continue;
      mine.add(link.serverId);
      out.set(localId, { ...link, owner: userId, role, created: true });
    } else if (link.role !== role || !link.created) {
      out.set(localId, { ...link, role, created: true });
    }
  }
  return out;
}

export type ProjectContent = Pick<Project, "stepData" | "stepStatus">;

function plainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read a content document from the server. `null` when there is none yet or it
 * is not a document this app can use: the local copy is then left alone.
 */
export function parseContent(raw: string | null | undefined): ProjectContent | null {
  if (!raw) return null;
  try {
    const doc: unknown = JSON.parse(raw);
    if (!plainObject(doc) || !plainObject(doc.stepData) || !plainObject(doc.stepStatus)) return null;
    return { stepData: doc.stepData, stepStatus: doc.stepStatus as Project["stepStatus"] };
  } catch {
    return null;
  }
}

/** The content of a project nobody has written anything into. */
export const EMPTY_CONTENT: ProjectContent = { stepData: {}, stepStatus: {} };

/** Whether a content document holds no work at all. */
export function isBlank(content: ProjectContent): boolean {
  return Object.keys(content.stepData).length === 0 && Object.keys(content.stepStatus).length === 0;
}

/** The largest content document the account accepts, in bytes (20 MB). */
export const MAX_CONTENT_BYTES = 20 * 1024 * 1024;

/**
 * Whether a content document is larger than the account accepts. The account
 * counts bytes, and a character takes up to three of them.
 */
export function tooLarge(content: string, max = MAX_CONTENT_BYTES): boolean {
  if (content.length > max) return true;
  if (content.length * 3 <= max) return false;
  return new TextEncoder().encode(content).length > max;
}

/**
 * A short fingerprint of a content document. Two documents with the same
 * fingerprint are taken to be the same content. Not for security.
 */
export function fingerprint(content: string): string {
  // Two independent 32-bit mixes over the text (the widely used "cyrb53"
  // scheme), with the length in front.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const mixed = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `${content.length.toString(36)}.${mixed.toString(36)}`;
}

/**
 * What to do with a planned upload once the content has been looked at. Local
 * saves stamp a new edit time even when nothing changed (moving between steps
 * does it), so "edited later" alone would let a person who only read a project
 * overwrite a collaborator's newer work. Unchanged content is never uploaded:
 * if the server has moved on, its copy is taken instead.
 */
export function settlePush(unchanged: boolean, serverRev: number, linkRev: number): "push" | "pull" | "skip" {
  if (!unchanged) return "push";
  return serverRev > linkRev ? "pull" : "skip";
}

/**
 * The local id for a project downloaded for the first time: the server id,
 * unless a project with that id is already on the device (a detached copy of
 * the same project, kept on purpose), which must not be overwritten.
 */
export function localIdForPull(serverId: string, taken: ReadonlySet<string>, fresh: () => string): string {
  if (!taken.has(serverId)) return serverId;
  for (;;) {
    const id = fresh();
    if (!taken.has(id)) return id;
  }
}

/** A deletion made on this device that the server has not been told about yet. */
export interface Tombstone {
  serverId: string;
  /** The account that deleted it. Only that account may carry it out. */
  owner: string;
  /**
   * What the person confirmed: `delete` removes the project for everyone,
   * `leave` only takes the person out of it. It is never carried out as more
   * than this, whatever role the person has by the time it is sent.
   */
  action: "leave" | "delete";
}

export function parseTombstones(raw: string | null | undefined): Tombstone[] {
  if (!raw) return [];
  try {
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const out: Tombstone[] = [];
    for (const item of list) {
      if (!plainObject(item)) continue;
      const { serverId, owner } = item;
      if (typeof serverId !== "string" || serverId === "" || typeof owner !== "string" || owner === "") continue;
      // One that does not say what was confirmed is carried out as the lesser of the two.
      const action = item.action === "delete" ? "delete" : "leave";
      if (!out.some((t) => t.serverId === serverId && t.owner === owner)) out.push({ serverId, owner, action });
    }
    return out;
  } catch {
    return [];
  }
}

export function withTombstone(list: readonly Tombstone[], t: Tombstone): Tombstone[] {
  return list.some((x) => x.serverId === t.serverId && x.owner === t.owner) ? [...list] : [...list, t];
}

export function withoutTombstone(list: readonly Tombstone[], t: Tombstone): Tombstone[] {
  return list.filter((x) => !(x.serverId === t.serverId && x.owner === t.owner));
}

/**
 * What deleting a project on this device does beyond the device, for the
 * wording of the confirmation: `device` nothing (it is only here), `everyone`
 * removes it from the account for every member (the person owns it), `leave`
 * takes the person out of a project that others keep.
 */
export type DeletionEffect = "device" | "everyone" | "leave";

export function deletionEffect(link: Link | null | undefined): DeletionEffect {
  if (link?.kind !== "account") return "device";
  return link.role === "owner" ? "everyone" : "leave";
}

/**
 * What to carry out when a deletion is confirmed: what the project's link
 * says now, but never more than the person was asked about. `confirmed` is the
 * effect that was on screen. `null` means the project has since moved into an
 * account, which nobody agreed to remove it from: nothing is done.
 */
export function settleDeletion(now: DeletionEffect, confirmed: DeletionEffect | undefined): DeletionEffect | null {
  if (confirmed === undefined || confirmed === now) return now;
  if (confirmed === "device") return null;
  // Asked to leave and an owner by now: still only a leave. Asked to delete
  // for everyone and no longer an owner: leaving is all that is left to do.
  return now === "device" ? "device" : "leave";
}

/** A window that regains focus syncs at most this often. */
export const FOCUS_SYNC_MS = 60_000;

export function shouldSyncOnFocus(now: number, lastSyncAt: number, minGap = FOCUS_SYNC_MS): boolean {
  return now - lastSyncAt >= minGap;
}

/** What sync needs to know about the session. */
export interface SessionView {
  /** Who to sync for, or `null` when sync must not run. */
  userId: string | null;
  /** Who is signed in, whether or not sync may run for them yet. */
  signedInId: string | null;
  /** The account whose projects this device shows. */
  deviceAccountId: string | null;
}

export function sessionView(s: Pick<SessionData, "phase" | "profile" | "deviceAccount" | "passwordPending">): SessionView {
  const profile = s.phase === "ready" ? s.profile : null;
  return {
    // An invited person who has not chosen a password yet is refused by the
    // backend, so sync waits for them. So does it after a code was accepted
    // and before the password is settled: until then the account may open
    // with a password somebody else set, and nothing is uploaded into it.
    userId: profile && !profile.mustSetPassword && !s.passwordPending ? profile.id : null,
    signedInId: profile?.id ?? null,
    deviceAccountId: s.deviceAccount?.id ?? null,
  };
}

// --- Status for the UI ---------------------------------------------------------

export type SyncState = "idle" | "syncing" | "offline" | "error";

export interface SyncStatus {
  state: SyncState;
  /** When this device and the account last agreed (epoch ms). Null until the first sync after signing in. */
  lastSyncedAt: number | null;
  /**
   * Goes up whenever sync changed a project or a project's link on this
   * device. Lists of projects should be read again when it changes.
   */
  revision: number;
  /** Why the last sync failed, as a `SyncError` code. Null unless `state` is `error`. */
  errorCode: string | null;
  /**
   * Projects that were kept as a device-only copy, for a notice. `gone`: the
   * server copy went away (deleted by its owner, or this person left or was
   * removed). `diverged`: somebody else wrote to the server copy before this
   * device's own work had ever reached it, so that work was kept apart.
   */
  detached: { localId: string; title: string; reason: DetachReason }[];
  dismissDetached(): void;
  /**
   * Projects the person asked to leave that are still theirs, and on this
   * device again: by the time the request was sent they were the only owner.
   */
  returned: { serverId: string; title: string }[];
  dismissReturned(): void;
}

export type DetachReason = "gone" | "diverged";

// --- What the engine needs from the rest of the app ------------------------------
// Narrow views, so the engine can be driven in tests with plain objects.

export interface LocalProjects {
  list(): Promise<Project[]>;
  get(id: string): Promise<Project | undefined>;
  put(project: Project): Promise<void>;
  update(id: string, patch: Partial<Project>): Promise<void>;
  /** Remove a project from this device, closing it if it is open. */
  remove(id: string): Promise<void>;
}

/** The project that is open in the runner. */
export interface OpenProject {
  current(): { project: Project | null; stepId: string };
  /** Called on every change of the runner's state with the open project before and after. */
  subscribe(listener: (next: Project | null, prev: Project | null) => void): () => void;
  /** Write the open project, with its unsaved edits, to the device. */
  persist(): Promise<void>;
  /** Read the open project from the device again and return to the given step. */
  reload(id: string, stepId: string): Promise<void>;
  close(): void;
}

export interface SessionPort {
  get(): SessionView;
  subscribe(listener: () => void): () => void;
  /** Ask the session to check the account again (the backend just refused it). */
  recheck(): void;
}

export interface DevicePort {
  online(): boolean;
  now(): number;
  onOnline(listener: () => void): () => void;
  onOffline(listener: () => void): () => void;
  onFocus(listener: () => void): () => void;
}

export interface SyncPorts {
  api: Pick<SyncApi, "listProjects" | "createProject" | "getContent" | "putContent" | "deleteProject" | "leaveProject">;
  projects: LocalProjects;
  editor: OpenProject;
  session: SessionPort;
  invitations: { refresh(): Promise<void>; clear(): void; onAccepted(listener: () => Promise<void>): () => void };
  /**
   * Runs at the end of every sync that reached the backend, with the person's
   * project list as just read. For layers that sync more per project.
   */
  afterSync?(listed: readonly ListedProject[]): void | Promise<void>;
  /** Runs when sync starts for a person, and when it stops. For the same layers. */
  onStart?(user: string): void;
  onStop?(): void;
  device: DevicePort;
  /** Where the queue of pending deletions is kept. */
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** How long after an edit the upload starts. */
  pushDelayMs?: number;
  /** The largest content document the account accepts, in bytes. */
  maxContentBytes?: number;
}

const PUSH_DELAY_MS = 1500;
const AUTH_REFUSALS = ["unauthenticated", "account_suspended", "password_reset_required"];

// --- Engine ------------------------------------------------------------------------

export function createProjectSync(ports: SyncPorts) {
  const pushDelay = ports.pushDelayMs ?? PUSH_DELAY_MS;
  const maxBytes = ports.maxContentBytes ?? MAX_CONTENT_BYTES;

  const status = create<SyncStatus>((set) => ({
    state: "idle",
    lastSyncedAt: null,
    revision: 0,
    errorCode: null,
    detached: [],
    dismissDetached: () => set({ detached: [] }),
    returned: [],
    dismissReturned: () => set({ returned: [] }),
  }));
  const bump = () => status.setState((s) => ({ revision: s.revision + 1 }));

  /** Who sync is running for. `null` while stopped. */
  let activeUser: string | null = null;
  /**
   * Goes up on every start and stop. Work captures it when it begins and
   * checks it after every wait, so a pass that is still in flight when the
   * person changes gives up instead of writing into the next person's data.
   */
  let generation = 0;
  const alive = (gen: number) => gen === generation;

  /** True from the moment someone signs in until the guest projects on the device have been pinned. */
  let needsPin = false;
  let pinning: Promise<void> | null = null;
  /** Reconcile passes and edit uploads run one at a time. */
  let chain: Promise<void> = Promise.resolve();
  let running: { loop: Promise<void>; gen: number } | null = null;
  let queued = false;
  let lastPassAt = -Infinity;

  /** Projects edited on this device since their last upload began. */
  const pending = new Set<string>();
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while this engine itself replaces the open project. That is not an edit. */
  let applyingRemote = false;
  /** Server copies being created, one request per project. */
  const creating = new Map<string, Promise<string | null>>();
  /** Projects whose content was found unchanged, and the edit time it was checked at. */
  const unchangedAt = new Map<string, number>();
  /**
   * What changed on the server through this device since the sync in flight
   * asked for the project list. That list may not show it yet: a server copy
   * confirmed here (`confirmed`) is not taken for one that has gone, and one
   * deleted or left here (`gone`) is not downloaded again. Both start empty
   * with every sync, before it asks.
   */
  const confirmed = new Set<string>();
  const gone = new Set<string>();
  let detachers: Array<() => void> = [];
  let unbind: (() => void) | null = null;

  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Resolves once nothing done as a guest can be uploaded any more: after a
   * sign-in, every project that has no record is pinned to this device first.
   * Everything that uploads waits here. If the device's projects cannot be
   * read, this rejects and is tried again by the next caller, so the way stays
   * shut rather than letting guest work through.
   */
  function guestsPinned(): Promise<void> {
    if (!needsPin) return Promise.resolve();
    pinning ??= ports.projects
      .list()
      .then((all) => {
        needsPin = false;
        if (pinUnlinked(all.map((p) => p.id)).length > 0) bump();
      })
      .finally(() => {
        pinning = null;
      });
    return pinning;
  }

  // --- Links and tombstones ---

  function ownLink(localId: string, user: string): AccountLink | null {
    const link = getLink(localId);
    return link?.kind === "account" && link.owner === user ? link : null;
  }

  /**
   * Update a link, but only if it still points this account at that server
   * copy. A request that finishes after the project was deleted, detached or
   * taken over by another account therefore changes nothing.
   */
  function patchLink(
    localId: string,
    user: string,
    serverId: string,
    patch: Partial<Pick<AccountLink, "rev" | "created" | "role" | "synced">>,
  ): boolean {
    const link = ownLink(localId, user);
    if (!link || link.serverId !== serverId) return false;
    setLink(localId, { ...link, ...patch });
    return true;
  }

  function readTombstones(): Tombstone[] {
    try {
      return parseTombstones(ports.storage.getItem(TOMBSTONES_KEY));
    } catch {
      return [];
    }
  }

  function writeTombstones(list: Tombstone[]): void {
    try {
      if (list.length === 0) ports.storage.removeItem(TOMBSTONES_KEY);
      else ports.storage.setItem(TOMBSTONES_KEY, JSON.stringify(list));
    } catch {
      /* storage unavailable: the project may come back at the next sync */
    }
  }

  /**
   * Carry out a deletion on the server: what the person confirmed, never more.
   * "Delete for everyone" deletes if they are still an owner and otherwise
   * leaves. "Leave" only ever leaves. Resolves with which of the two it was.
   * Throws when it has to be tried again later, and `last_owner` when a leave
   * is refused for good: the person is the only owner by now, and the project
   * stays theirs.
   */
  async function settleTombstone(t: Tombstone, role: AccountLink["role"]): Promise<"deleted" | "left"> {
    const deleting = t.action === "delete" && role === "owner";
    try {
      if (deleting) await ports.api.deleteProject(t.serverId);
      else await ports.api.leaveProject(t.serverId);
    } catch (e) {
      const code = e instanceof SyncError ? e.code : "";
      // Refused for good. Nothing is deleted in its place, and it is not asked again.
      if (code === "last_owner") writeTombstones(withoutTombstone(readTombstones(), t));
      // Already gone, or never reached the server: nothing left to do.
      if (code !== "not_found") throw e;
    }
    gone.add(t.serverId);
    writeTombstones(withoutTombstone(readTombstones(), t));
    return deleting ? "deleted" : "left";
  }

  // --- Failures ---

  interface Outcome {
    offline: boolean;
    code: string | null;
  }

  function note(outcome: Outcome, e: unknown): void {
    if (isConnectivityError(e)) outcome.offline = true;
    else if (outcome.code === null) outcome.code = e instanceof SyncError ? e.code : "server_error";
  }

  function report(outcome: Outcome): void {
    if (outcome.offline) status.setState({ state: "offline", errorCode: null });
    else if (outcome.code !== null) status.setState({ state: "error", errorCode: outcome.code });
    else status.setState({ state: "idle", errorCode: null, lastSyncedAt: ports.device.now() });
  }

  // --- Moving content ---

  async function reloadIfOpen(localId: string): Promise<void> {
    const { project, stepId } = ports.editor.current();
    if (project?.id !== localId) return;
    applyingRemote = true;
    try {
      await ports.editor.reload(localId, stepId);
    } finally {
      applyingRemote = false;
    }
  }

  /**
   * Keep a project as a copy on this device only, because the copy in the
   * account is somebody else's work and this one has never been uploaded.
   * Neither replaces the other: the account's copy is downloaded beside it.
   */
  function keepApart(localId: string, user: string, serverId: string, title: string): void {
    if (ownLink(localId, user)?.serverId !== serverId) return;
    setLink(localId, { kind: "device", asked: true });
    status.setState((s) => ({ detached: [...s.detached.filter((d) => d.localId !== localId), { localId, title, reason: "diverged" }] }));
    unchangedAt.delete(localId);
    bump();
    // The account's copy no longer has one here. The next sync downloads it.
    void reconcile();
  }

  /**
   * Replace the local copy with the server's. Resolves true when the local
   * copy now is the server's.
   *
   * Refused while the project has edits that have not been uploaded yet:
   * those go up first and the two copies are settled then.
   *
   * Also refused for a copy that has never been synced and holds work the
   * account has never seen (its first upload has not succeeded). Replacing it
   * would lose that work for good, as no other copy of it exists. An empty
   * server copy is written over instead; any other is somebody's work too, so
   * this copy is kept apart from it (`keepApart`). This is for people who may
   * upload: what a viewer typed was never going to be saved.
   *
   * `discard` is for a viewer or supervisor who has just been made an editor:
   * what they typed meanwhile was never theirs to save, so the server copy is
   * taken whatever it is, and an account that holds no content yet counts as
   * the empty project.
   */
  async function acceptServerCopy(
    localId: string,
    user: string,
    serverId: string,
    copy: ServerContent,
    gen: number,
    title?: string,
    discard = false,
  ): Promise<boolean> {
    if (!alive(gen) || pending.has(localId)) return false;
    const content = parseContent(copy.content) ?? (discard && copy.content === null ? EMPTY_CONTENT : null);
    if (!content) {
      patchLink(localId, user, serverId, { rev: copy.rev });
      return false;
    }
    const link = ownLink(localId, user);
    if (link?.serverId !== serverId) return false;
    const theirs = serializeContent(content);

    if (link.rev === 0 && canEdit(link.role) && !discard) {
      const local = await ports.projects.get(localId);
      if (!alive(gen) || pending.has(localId) || ownLink(localId, user)?.serverId !== serverId) return false;
      if (local && !isBlank(local)) {
        const mine = serializeContent(local);
        const print = fingerprint(mine);
        if (print !== link.synced && print !== fingerprint(theirs)) {
          if (isBlank(content)) {
            // Nothing is lost by writing over a project with nothing in it.
            await upload(local, user, serverId, copy.rev, gen, mine);
          } else {
            keepApart(localId, user, serverId, local.title);
          }
          return false;
        }
      }
    }

    const patch: Partial<Project> = {
      stepData: content.stepData,
      stepStatus: content.stepStatus,
      updatedAt: copy.updatedAt ?? (copy.content === null ? 0 : ports.device.now()),
    };
    if (title) patch.title = title;
    await ports.projects.update(localId, patch);
    patchLink(localId, user, serverId, { rev: copy.rev, synced: fingerprint(theirs) });
    unchangedAt.delete(localId);
    await reloadIfOpen(localId);
    bump();
    return true;
  }

  /**
   * Upload a project's content. A refusal because the server copy is newer is
   * settled by taking that copy. Throws `too_large`, before anything is sent,
   * for a project bigger than the account accepts.
   */
  async function upload(
    p: Project,
    user: string,
    serverId: string,
    baseRev: number,
    gen: number,
    content = serializeContent(p),
  ): Promise<void> {
    if (tooLarge(content, maxBytes)) throw new SyncError(413, "too_large");
    try {
      const res = await ports.api.putContent(serverId, {
        stepData: p.stepData,
        stepStatus: p.stepStatus,
        title: p.title,
        baseRev,
        updatedAt: p.updatedAt,
        content,
      });
      // Bookkeeping about a request that succeeded. Safe after a change of
      // person too: the link is only touched if it is still this account's.
      patchLink(p.id, user, serverId, { rev: res.rev, synced: fingerprint(content) });
    } catch (e) {
      if (!(e instanceof SyncError && e.code === "conflict")) throw e;
      await acceptServerCopy(p.id, user, serverId, e.payload as ConflictPayload, gen);
    }
  }

  /**
   * Make sure a project is in this account: its server copy exists and its
   * content has been uploaded to it at least once. Resolves its server id, or
   * `null` when the project is not this account's to upload: it belongs to
   * another account, or it is kept on this device. Only `adopt`, the person's
   * own choice, turns a device project into an account project.
   *
   * Throws when either step fails. The server copy may exist by then with
   * nothing in it: the link says so (`awaitsFirstUpload`), the project is not
   * shown as being in the account, and the next sync or the next call uploads
   * it. A project too large for the account is refused before anything is
   * created. One request per project however many callers ask.
   */
  function ensure(localId: string, user: string, adopt: boolean): Promise<string | null> {
    const inFlight = creating.get(localId);
    if (inFlight) return inFlight;
    const gen = generation;

    const task = (async () => {
      const p = await ports.projects.get(localId);
      if (!p) throw new SyncError(404, "not_found");
      if (!alive(gen)) throw unauthenticatedError();

      let link = getLink(localId);
      if (link?.kind === "account") {
        if (link.owner !== user) return null;
        if (!awaitsFirstUpload(link)) return link.serverId;
      } else if (link?.kind === "device" && !adopt) {
        return null;
      }
      // Refused before anything is created: an empty project in the account
      // would be all there is to show for it.
      if (!(link?.kind === "account" && link.created) && tooLarge(serializeContent(p), maxBytes)) throw new SyncError(413, "too_large");
      if (link?.kind !== "account") {
        // The id is made here and written down before the request, so a retry
        // after a lost answer asks for the same project again.
        link = { kind: "account", owner: user, serverId: newServerProjectId(), rev: 0, created: false, role: "owner" };
        setLink(localId, link);
        bump();
      }

      let serverId = link.serverId;
      if (!link.created) {
        try {
          await ports.api.createProject(serverId, p.title, p.studyType);
        } catch (e) {
          if (!(e instanceof SyncError && e.code === "conflict")) throw e;
          // The id belongs to somebody else's project. Take a new one.
          serverId = newServerProjectId();
          if (!patchLinkId(localId, user, link.serverId, serverId)) throw e;
          await ports.api.createProject(serverId, p.title, p.studyType);
        }
        // Noted before the link says so: a sync that asked for the project
        // list earlier must not take this copy for one that has gone.
        confirmed.add(serverId);
        patchLink(localId, user, serverId, { created: true, role: "owner" });
        bump();
      }

      // The first upload. Until it has worked the account holds an empty
      // project, which is why nobody can be invited to it yet.
      const current = (await ports.projects.get(localId)) ?? p;
      if (!alive(gen)) throw unauthenticatedError();
      await upload(current, user, serverId, 0, gen);
      const after = ownLink(localId, user);
      // Somebody else wrote to it first, and this copy was kept apart from theirs.
      if (after?.serverId !== serverId || awaitsFirstUpload(after)) throw new SyncError(409, "conflict");
      return serverId;
    })().finally(() => {
      if (creating.get(localId) === task) creating.delete(localId);
    });

    creating.set(localId, task);
    return task;
  }

  function patchLinkId(localId: string, user: string, from: string, to: string): boolean {
    const link = ownLink(localId, user);
    if (!link || link.serverId !== from || link.created) return false;
    setLink(localId, { ...link, serverId: to });
    return true;
  }

  /** Whether an edit of this project may be uploaded by this person. */
  function uploadable(localId: string, user: string): boolean {
    const link = getLink(localId);
    if (!link) return true; // made while signed in
    if (link.kind !== "account" || link.owner !== user) return false;
    return !link.created || canEdit(link.role);
  }

  /** Upload one edited project, creating its server copy first if it has none. */
  async function pushLocal(localId: string, user: string, gen: number): Promise<void> {
    const p = await ports.projects.get(localId);
    if (!p || !alive(gen) || !uploadable(localId, user)) return;
    const link = ownLink(localId, user);
    if (!link || !link.created) {
      await ensure(localId, user, false); // uploads the content as well
      return;
    }
    const content = serializeContent(p);
    if (link.synced === fingerprint(content)) return; // typed and undone: nothing to send
    await upload(p, user, link.serverId, link.rev, gen, content);
  }

  /** Upload the projects edited since the last upload. Resolves true when there was anything to send. */
  async function flush(gen: number, user: string, outcome: Outcome): Promise<boolean> {
    await guestsPinned();
    if (!alive(gen)) return false;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = null;
    const ids = [...pending].filter((id) => uploadable(id, user));
    pending.clear();
    if (ids.length === 0) return false;

    status.setState({ state: "syncing" });
    const open = ports.editor.current().project;
    if (open && ids.includes(open.id)) await ports.editor.persist();
    for (const id of ids) {
      if (!alive(gen)) return false;
      try {
        await pushLocal(id, user, gen);
      } catch (e) {
        // The edit is safe on this device. The next sync sees it is newer and uploads it.
        note(outcome, e);
      }
    }
    return true;
  }

  function schedule(localId: string): void {
    pending.add(localId);
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      const gen = generation;
      const user = activeUser;
      if (!user) return;
      void exclusive(async () => {
        const outcome: Outcome = { offline: false, code: null };
        const sent = await flush(gen, user, outcome);
        if (sent && alive(gen)) report(outcome);
      }).catch(() => {
        if (alive(gen)) report({ offline: false, code: "storage_error" });
      });
    }, pushDelay);
  }

  function onEdit(next: Project | null, prev: Project | null): void {
    if (applyingRemote || !next || !activeUser) return;
    if (prev && prev.id === next.id) {
      // Moving between steps changes the runner's state but not the project.
      if (next.stepData === prev.stepData && next.stepStatus === prev.stepStatus && next.title === prev.title) return;
      schedule(next.id);
      return;
    }
    // A project was opened or has just been created. One with no record was
    // made while signed in, so it belongs to this account: say so at once,
    // then upload it. Guest projects are pinned first, which keeps them out.
    const gen = generation;
    const user = activeUser;
    const localId = next.id;
    void guestsPinned()
      .then(() => {
        if (!alive(gen) || getLink(localId)) return;
        setLink(localId, { kind: "account", owner: user, serverId: newServerProjectId(), rev: 0, created: false, role: "owner" });
        bump();
        schedule(localId);
      })
      .catch(() => {});
  }

  // --- One reconcile pass ---

  async function pass(gen: number, user: string): Promise<void> {
    if (!alive(gen)) return;
    status.setState({ state: "syncing" });
    lastPassAt = ports.device.now();
    const outcome: Outcome = { offline: false, code: null };
    // From here on, whatever this device changes on the server is noted, in
    // case the list this sync is about to ask for does not show it yet.
    confirmed.clear();
    gone.clear();

    // Guest projects are pinned, and edits made here go up, before anything
    // is compared: a project with edits waiting is never overwritten.
    try {
      await flush(gen, user, outcome);
    } catch {
      // The projects on this device could not be read. Nothing can be synced.
      if (alive(gen)) report({ offline: false, code: "storage_error" });
      return;
    }
    if (!alive(gen)) return;

    let listed: ListedProject[];
    try {
      listed = (await ports.api.listProjects()).projects;
    } catch (e) {
      if (!alive(gen)) return;
      // Not fatal: sync stays on, edits keep being saved here, and the next
      // trigger tries again.
      note(outcome, e);
      report(outcome);
      if (e instanceof SyncError && AUTH_REFUSALS.includes(e.code)) ports.session.recheck();
      return;
    }
    if (!alive(gen)) return;
    const serverById = new Map(listed.map((s) => [s.id, s]));

    // Deletions made on this device, possibly offline. They are sent now, and
    // their projects are not downloaded again in the meantime.
    const waiting = () => readTombstones().filter((t) => t.owner === user);
    for (const t of waiting()) {
      const onServer = serverById.get(t.serverId);
      try {
        if (onServer) await settleTombstone(t, onServer.role);
        else writeTombstones(withoutTombstone(readTombstones(), t));
      } catch (e) {
        if (onServer && e instanceof SyncError && e.code === "last_owner") {
          // They asked to leave and are the only owner by now. Nothing is
          // deleted for them: the project is downloaded again below, and they are told.
          status.setState((s) => ({
            returned: [...s.returned.filter((r) => r.serverId !== t.serverId), { serverId: t.serverId, title: onServer.title }],
          }));
        } else {
          note(outcome, e);
        }
      }
      if (!alive(gen)) return;
    }

    let projects: Project[];
    try {
      projects = await ports.projects.list();
    } catch {
      if (alive(gen)) report({ offline: false, code: "storage_error" });
      return;
    }
    if (!alive(gen)) return;

    // What this person deleted or left here: still waiting to be sent, or
    // sent a moment ago. Read again now, after the device's projects, because
    // a project can be deleted while this sync is under way. The list above
    // may still name any of them.
    const leaving = new Set([...waiting().map((t) => t.serverId), ...gone]);

    const localById = new Map(projects.map((p) => [p.id, p]));
    /** Whether the copy on this device is exactly what was last synced. */
    const isSynced = (localId: string, link: AccountLink) => {
      const p = localById.get(localId);
      return p !== undefined && link.synced !== undefined && link.synced === fingerprint(serializeContent(p));
    };
    const before = listLinks();
    const updates = linkUpdates(
      before,
      listed,
      user,
      // Another account's copy may be taken over only if everything in it has been uploaded.
      isSynced,
      leaving,
    );
    /**
     * A viewer or supervisor who has just been made an editor, with a copy
     * that is not the team's: what they typed was never theirs to save, so it
     * must not be uploaded now. They stay a viewer on this device until the
     * team's copy has been taken.
     */
    const promotions = new Map<string, AccountLink>();
    // What is typed into the open project is saved to the device only when
    // the person leaves a field or a step, so it is looked at as well.
    const open = ports.editor.current().project;
    let changed = false;
    for (const [localId, link] of updates) {
      const was = before.get(localId);
      const promoted = was?.kind === "account" && was.owner === user && was.created && !canEdit(was.role) && canEdit(link.role);
      if (promoted && localById.has(localId)) {
        const typed = open?.id === localId && was.synced !== fingerprint(serializeContent(open));
        if (typed || !isSynced(localId, was)) {
          promotions.set(localId, link);
          continue;
        }
      }
      setLink(localId, link);
      changed = true;
    }
    if (changed) bump();

    const taken = new Set(localById.keys());
    const actions = planSync(syncableMeta(projects, listLinks(), user), serverMetaOf(listed), leaving);

    for (const [localId, link] of promotions) {
      if (!alive(gen)) return;
      if (outcome.offline) break;
      try {
        const copy = await ports.api.getContent(link.serverId);
        if (await acceptServerCopy(localId, user, link.serverId, copy, gen, serverById.get(link.serverId)?.title, true)) {
          if (patchLink(localId, user, link.serverId, { role: link.role })) bump();
        }
      } catch (e) {
        note(outcome, e);
      }
    }

    for (const a of actions) {
      if (!alive(gen)) return;
      if (outcome.offline) break; // the rest would fail the same way
      if (a.type !== "pullNew" && promotions.has(a.localId)) continue; // settled above, or at the next sync
      try {
        if (a.type === "createRemote") {
          // Does nothing for a project pinned to the device since the plan was made.
          await ensure(a.localId, user, false);
        } else if (a.type === "push") {
          const p = await ports.projects.get(a.localId);
          const link = ownLink(a.localId, user);
          const server = serverById.get(a.serverId);
          if (!p || !link || !server || link.serverId !== a.serverId || !alive(gen)) continue;
          let unchanged = unchangedAt.get(p.id) === p.updatedAt;
          let content: string | undefined;
          if (!unchanged) {
            content = serializeContent(p);
            unchanged = link.synced === fingerprint(content);
            if (unchanged) unchangedAt.set(p.id, p.updatedAt);
          }
          const verdict = settlePush(unchanged, server.rev, link.rev);
          if (verdict === "push") {
            await upload(p, user, a.serverId, link.rev, gen, content);
          } else if (verdict === "pull") {
            await acceptServerCopy(a.localId, user, a.serverId, await ports.api.getContent(a.serverId), gen, server.title);
          }
        } else if (a.type === "pull") {
          if (pending.has(a.localId)) continue;
          const copy = await ports.api.getContent(a.serverId);
          await acceptServerCopy(a.localId, user, a.serverId, copy, gen, serverById.get(a.serverId)?.title);
        } else if (a.type === "pullNew") {
          const meta = serverById.get(a.serverId);
          if (!meta) continue;
          const copy = await ports.api.getContent(a.serverId);
          if (!alive(gen)) return;
          const content = parseContent(copy.content);
          const localId = localIdForPull(a.serverId, taken, newServerProjectId);
          taken.add(localId);
          const now = ports.device.now();
          // The link first: a project without one would be uploaded as new.
          // It always says what was downloaded, the empty project included:
          // saving that copy again without a change is then not an edit, and
          // it is never uploaded over the author's work.
          setLink(localId, {
            kind: "account",
            owner: user,
            serverId: a.serverId,
            rev: copy.rev,
            created: true,
            role: meta.role,
            synced: fingerprint(serializeContent(content ?? EMPTY_CONTENT)),
          });
          await ports.projects.put({
            id: localId,
            title: meta.title || "Untitled project",
            studyType: meta.study_type as StudyTypeId,
            stepData: content?.stepData ?? {},
            stepStatus: content?.stepStatus ?? {},
            createdAt: meta.created_at || now,
            // A project nobody has uploaded yet must not look edited here, or
            // this device would upload its empty copy over the author's work.
            updatedAt: content ? (copy.updatedAt ?? now) : 0,
          });
          bump();
        } else {
          const link = ownLink(a.localId, user);
          if (!link || link.serverId !== a.serverId) continue;
          // Put into the account after this sync asked for the list: it is not gone, the list is old.
          if (confirmed.has(a.serverId)) continue;
          const title = localById.get(a.localId)?.title ?? "";
          setLink(a.localId, { kind: "device", asked: true });
          status.setState((s) => ({
            detached: [...s.detached.filter((d) => d.localId !== a.localId), { localId: a.localId, title, reason: "gone" }],
          }));
          bump();
        }
      } catch (e) {
        // One project failing does not stop the others. It is tried again next time.
        note(outcome, e);
      }
    }

    if (!alive(gen)) return;
    report(outcome);
    if (outcome.offline) return;
    await ports.invitations.refresh().catch(() => {});
    if (!alive(gen)) return;
    try {
      await ports.afterSync?.(listed);
    } catch {
      /* a layer on top failing is not a failure of project sync */
    }
  }

  // --- Public surface ---

  /**
   * One full sync: upload local edits, then bring this device and the account
   * into line. Single-flight: a call made while a sync is running makes it run
   * once more and resolves when that is done. Never rejects; the outcome is in
   * the status store. Does nothing while nobody is signed in.
   */
  function reconcile(): Promise<void> {
    const user = activeUser;
    if (!user) return Promise.resolve();
    const gen = generation;
    if (running && running.gen === gen) {
      queued = true;
      return running.loop;
    }
    queued = false;
    const loop: Promise<void> = (async () => {
      do {
        queued = false;
        await exclusive(() => pass(gen, user));
      } while (queued && alive(gen));
    })()
      .catch(() => {
        if (alive(gen)) status.setState({ state: "error", errorCode: "server_error" });
      })
      .finally(() => {
        if (running?.loop === loop) running = null;
      });
    running = { loop, gen };
    return loop;
  }

  /**
   * Start syncing for a signed-in person: listen for edits, then run the first
   * sync. Listening comes first, so an offline start still uploads later.
   * Resolves when the first sync has finished, whatever its outcome.
   */
  function start(user: string): Promise<void> {
    if (activeUser === user) return running?.loop ?? Promise.resolve();
    stop();
    generation += 1;
    activeUser = user;
    lastPassAt = -Infinity;
    status.setState({ state: ports.device.online() ? "idle" : "offline", errorCode: null, lastSyncedAt: null });
    ports.onStart?.(user);
    detachers = [
      ports.editor.subscribe(onEdit),
      ports.device.onOnline(() => void reconcile()),
      ports.device.onOffline(() => {
        if (status.getState().state !== "syncing") status.setState({ state: "offline", errorCode: null });
      }),
      ports.device.onFocus(() => {
        if (shouldSyncOnFocus(ports.device.now(), lastPassAt)) void reconcile();
      }),
    ];
    return reconcile();
  }

  /** Stop syncing. Nothing on the device is removed. */
  function stop(): void {
    if (activeUser === null) return;
    // Edits that were waiting to upload are written to the device, so they are
    // still there, and go up, the next time this person signs in.
    const open = ports.editor.current().project;
    if (open && pending.has(open.id)) void ports.editor.persist().catch(() => {});
    generation += 1;
    activeUser = null;
    ports.onStop?.();
    for (const off of detachers) off();
    detachers = [];
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = null;
    pending.clear();
    unchangedAt.clear();
    queued = false;
    confirmed.clear();
    gone.clear();
    status.setState({ state: "idle", errorCode: null, lastSyncedAt: null, detached: [], returned: [] });
    ports.invitations.clear();
  }

  /**
   * Put a project into the signed-in person's account (if it is not there
   * already) and return the id of its server copy. This is the person's own
   * choice ("Add to my account", or sharing), so it also takes over a project
   * that was kept on this device. Throws `SyncError`.
   */
  function ensureRemote(localId: string): Promise<string> {
    const user = activeUser;
    if (!user) {
      const waiting = ports.session.get().signedInId !== null;
      return Promise.reject(waiting ? new SyncError(403, "password_reset_required") : unauthenticatedError());
    }
    return guestsPinned()
      .then(() => ensure(localId, user, true))
      .then((serverId) => {
        // Another account's project: not this person's to share.
        if (serverId === null) throw new SyncError(403, "forbidden");
        return serverId;
      });
  }

  /**
   * Delete a project from this device and, if it is in an account, from the
   * account as well: an owner deletes it for everyone, any other member leaves
   * it. `asked` is what the person was asked to confirm, and nothing more than
   * that is carried out, whatever the project's link says by now
   * (`settleDeletion`). When the server cannot be reached the deletion is
   * queued and sent at the next sync, and the project is not downloaded again
   * in between.
   *
   * Resolves `local` for a project that was only on this device, `deleted`
   * when it is gone from the account for everyone, `left` when the person is
   * out of it and the others keep it, and `queued` when the account is still
   * to be told.
   *
   * Throws, with the project still in place: `last_owner` when the person
   * asked to leave and is the only owner by now, and `conflict` when a project
   * they were asked about as being on this device only is in an account now.
   */
  async function deleteProjectEverywhere(localId: string, asked?: DeletionEffect): Promise<"local" | "deleted" | "left" | "queued"> {
    // A server copy that is being created right now must exist before it can be removed.
    await creating.get(localId)?.catch(() => {});
    const link = getLink(localId);
    const effect = settleDeletion(deletionEffect(link), asked);
    if (effect === null) throw new SyncError(409, "conflict");

    if (link?.kind !== "account") {
      pending.delete(localId);
      unchangedAt.delete(localId);
      await ports.projects.remove(localId);
      removeLink(localId);
      bump();
      return "local";
    }

    // Written down before anything is removed, so the project cannot come
    // back if the app closes or the network fails half way.
    const tombstone: Tombstone = { serverId: link.serverId, owner: link.owner, action: effect === "everyone" ? "delete" : "leave" };
    writeTombstones(withTombstone(readTombstones(), tombstone));
    const reachable = link.owner === activeUser;

    // Leaving can be refused: the only owner of a project cannot leave it, and
    // the role on this device may be out of date. So the account is asked
    // first, while everything is still here to go back to.
    let settled: "deleted" | "left" | null = null;
    if (reachable && tombstone.action === "leave") {
      try {
        settled = await settleTombstone(tombstone, link.role);
      } catch (e) {
        if (e instanceof SyncError && e.code === "last_owner") {
          // Nothing was removed. The next sync brings the role up to date.
          void reconcile();
          throw e;
        }
        // Not reachable right now: it stays queued.
      }
    }

    pending.delete(localId);
    unchangedAt.delete(localId);
    await ports.projects.remove(localId);
    removeLink(localId);
    bump();

    if (settled) return settled;
    if (!reachable || tombstone.action === "leave") return "queued";
    try {
      // Deleted for everyone, or left: the person may no longer be an owner.
      return await settleTombstone(tombstone, link.role);
    } catch {
      return "queued";
    }
  }

  /** Close the open project if this device should not be showing it. */
  function closeIfHidden(): void {
    const open = ports.editor.current().project;
    if (open && !isVisible(getLink(open.id), ports.session.get().deviceAccountId)) ports.editor.close();
  }

  /**
   * Tie sync to the session, once, at launch. Signed in as someone who may
   * sync: start for them. Anything else: stop. Returns the undo.
   */
  function bind(): () => void {
    if (unbind) return unbind;
    let last = ports.session.get();

    const apply = () => {
      const now = ports.session.get();
      const signedIn = now.signedInId !== null && now.signedInId !== last.signedInId;
      const shownChanged = now.deviceAccountId !== last.deviceAccountId;
      last = now;
      // Someone has just signed in: what is on the device without a record is
      // guest work. It is pinned before the first sync can see it. Started
      // now, so a project made a moment later is not taken for guest work.
      if (signedIn) {
        needsPin = true;
        void guestsPinned().catch(() => {});
      }
      if (now.userId !== activeUser) {
        if (now.userId) void start(now.userId);
        else stop();
      }
      // After a sign-out the account's projects are hidden, the open one included.
      if (shownChanged) closeIfHidden();
    };

    const offs = [
      ports.session.subscribe(apply),
      ports.editor.subscribe((next, prev) => {
        if (next && next.id !== prev?.id) closeIfHidden();
      }),
      ports.invitations.onAccepted(() => reconcile()),
    ];
    // Launching already signed in is not a sign-in: nothing is pinned.
    if (last.userId) void start(last.userId);
    closeIfHidden();

    unbind = () => {
      for (const off of offs) off();
      stop();
      unbind = null;
    };
    return unbind;
  }

  return { status, reconcile, start, stop, ensureRemote, deleteProjectEverywhere, bind };
}

// --- The app's own sync ----------------------------------------------------------

/** localStorage key the project store keeps the open project's id under. */
const ACTIVE_PROJECT_KEY = "scholea.activeProject";

function listen(target: EventTarget | undefined, type: string, listener: () => void): () => void {
  if (!target) return () => {};
  target.addEventListener(type, listener);
  return () => target.removeEventListener(type, listener);
}

const win = typeof window === "undefined" ? undefined : window;

const engine = createProjectSync({
  api: sync,
  projects: {
    list: () => db.projects.toArray(),
    get: (id) => db.projects.get(id),
    put: async (project) => {
      await db.projects.put(project);
    },
    update: async (id, patch) => {
      await db.projects.update(id, patch);
    },
    remove: (id) => useProject.getState().deleteProject(id),
  },
  editor: {
    current: () => {
      const s = useProject.getState();
      return { project: s.project, stepId: s.activeStepId };
    },
    subscribe: (listener) => useProject.subscribe((state, prev) => listener(state.project, prev.project)),
    persist: () => useProject.getState().persist(),
    reload: async (id, stepId) => {
      await useProject.getState().switchProject(id);
      // Opening a project lands on its first step. Go back to where the person was.
      const s = useProject.getState();
      if (s.project?.id === id && stepId && s.config?.steps.some((step) => step.id === stepId)) s.setActiveStep(stepId);
    },
    close: () => {
      try {
        localStorage.removeItem(ACTIVE_PROJECT_KEY);
      } catch {
        /* ignore */
      }
      useProject.setState({ project: null, config: null, activeStepId: "" });
    },
  },
  session: {
    get: () => sessionView(useSession.getState()),
    subscribe: (listener) => useSession.subscribe(() => listener()),
    recheck: () => {
      void useSession
        .getState()
        .refreshProfile()
        .catch(() => {});
    },
  },
  invitations: {
    refresh: () => useInvitations.getState().refresh(),
    clear: () => useInvitations.getState().clear(),
    onAccepted: onInvitationAccepted,
  },
  device: {
    online: () => typeof navigator === "undefined" || navigator.onLine !== false,
    now: () => Date.now(),
    onOnline: (listener) => listen(win, "online", listener),
    onOffline: (listener) => listen(win, "offline", listener),
    onFocus: (listener) => listen(win, "focus", listener),
  },
  storage: {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    removeItem: (key) => localStorage.removeItem(key),
  },
  afterSync: async (listed) => {
    // Comments and sign-offs. They are their own tables and cannot overwrite a
    // project's content, so this runs whether or not edits are waiting to upload.
    await reconcileCollab(listed);
  },
  onStart: startCollabSync,
  onStop: stopCollabSync,
});

/** Sync state for the account menu and the project list. */
export const useSyncStatus = engine.status;

/** One full sync. Single-flight, never rejects. See `createProjectSync`. */
export const reconcile = engine.reconcile;
/** "Sync now". */
export const syncNow = engine.reconcile;
export const ensureRemote = engine.ensureRemote;
export const deleteProjectEverywhere = engine.deleteProjectEverywhere;

/**
 * Call once at launch, after the session store's `init()`. From then on sync
 * starts and stops with the session by itself.
 */
export const bindSyncToSession = engine.bind;
