/**
 * The link between a project on this device and the signed-in person's account.
 * Kept in localStorage, out of the offline data model, one record per local
 * project under `scholea.link.<localId>`:
 *
 * - `account`: the project belongs to an account. `owner` is that account's
 *   user id, so a second account on the same device never sees or uploads it.
 * - `device`: the person chose to keep it on this device only. Never uploaded.
 * - no record: a new project. It is uploaded if someone is signed in.
 *
 * The rule for people: projects in your account appear only while you are
 * signed in; projects kept on this device always appear and are never uploaded
 * unless you choose "Add to my account".
 *
 * This one store replaces the two older ones (`scholea.sync.*` and
 * `scholea.shared.*`), which could each point the same project at a different
 * server copy.
 */
import { useSyncExternalStore } from "react";
import type { ProjectRole } from "./sync";

export interface AccountLink {
  kind: "account";
  /** User id of the account this project belongs to on this device. */
  owner: string;
  /** Server project id, generated on this device before the first upload. */
  serverId: string;
  /** Server revision last synced from. 0 before the first sync. */
  rev: number;
  /** False until the server has confirmed the project exists. */
  created: boolean;
  /** This person's role on the project, refreshed from the server's list. */
  role: ProjectRole;
  /**
   * Fingerprint of the content as it was last uploaded or downloaded. Lets the
   * sync layer tell a real edit from a save that changed nothing. Absent until
   * the first sync.
   */
  synced?: string;
}

export interface DeviceLink {
  kind: "device";
  /** True once the person has answered "Keep on this device only". */
  asked: boolean;
}

export type Link = AccountLink | DeviceLink;

const PREFIX = "scholea.link.";
/** Reserved inside the link namespace: deletions waiting to reach the server. Not a link. */
export const TOMBSTONES_KEY = "scholea.link.tombstones";

const ROLES: readonly ProjectRole[] = ["viewer", "editor", "supervisor", "owner"];

// --- Server project ids ---------------------------------------------------------

/** Server project ids are made on the device, so a retried create is harmless. */
export const SERVER_PROJECT_ID = /^proj_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isServerProjectId(id: string): boolean {
  return SERVER_PROJECT_ID.test(id);
}

/** The part of the platform's `crypto` that id generation needs. */
export interface RandomSource {
  getRandomValues(array: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
  randomUUID?: () => string;
}

/** A random version 4 UUID in lowercase. */
export function uuidV4(source: RandomSource = globalThis.crypto): string {
  if (typeof source.randomUUID === "function") return source.randomUUID().toLowerCase();
  // Older webviews have no randomUUID; build one from random bytes.
  const b = source.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A fresh server project id (`proj_<uuid>`). Write it into the link record
 * before the first network call, so a retry reuses the same id.
 */
export function newServerProjectId(): string {
  return `proj_${uuidV4()}`;
}

// --- Storage ---------------------------------------------------------------------

function parseLink(raw: string | null): Link | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown> | null;
    if (typeof v !== "object" || v === null) return null;
    if (v.kind === "device") return { kind: "device", asked: v.asked === true };
    if (
      v.kind === "account" &&
      typeof v.owner === "string" &&
      v.owner !== "" &&
      typeof v.serverId === "string" &&
      v.serverId !== "" &&
      typeof v.rev === "number" &&
      Number.isFinite(v.rev) &&
      ROLES.includes(v.role as ProjectRole)
    ) {
      return {
        kind: "account",
        owner: v.owner,
        serverId: v.serverId,
        rev: v.rev,
        created: v.created === true,
        role: v.role as ProjectRole,
        ...(typeof v.synced === "string" && v.synced !== "" ? { synced: v.synced } : {}),
      };
    }
  } catch {
    /* fall through: a record that cannot be read counts as absent */
  }
  return null;
}

function readRaw(localId: string): string | null {
  try {
    return localStorage.getItem(PREFIX + localId);
  } catch {
    return null;
  }
}

// The parsed record is remembered against its raw text, so repeated reads of an
// unchanged record return the same object. `useLink` relies on that.
const parsed = new Map<string, { raw: string | null; link: Link | null }>();
const listeners = new Set<() => void>();
let watchingStorage = false;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** The link for a local project, or `null` when it has none. Synchronous. */
export function getLink(localId: string): Link | null {
  const raw = readRaw(localId);
  const hit = parsed.get(localId);
  if (hit && hit.raw === raw) return hit.link;
  const link = parseLink(raw);
  parsed.set(localId, { raw, link });
  return link;
}

export function setLink(localId: string, link: Link): void {
  const record: Link =
    link.kind === "device"
      ? { kind: "device", asked: link.asked }
      : {
          kind: "account",
          owner: link.owner,
          serverId: link.serverId,
          rev: link.rev,
          created: link.created,
          role: link.role,
          ...(link.synced ? { synced: link.synced } : {}),
        };
  try {
    localStorage.setItem(PREFIX + localId, JSON.stringify(record));
  } catch {
    /* storage full or unavailable: the next reconcile writes it again */
  }
  notify();
}

export function removeLink(localId: string): void {
  try {
    localStorage.removeItem(PREFIX + localId);
  } catch {
    /* ignore */
  }
  parsed.delete(localId);
  notify();
}

/** Every link on this device, keyed by local project id. */
export function listLinks(): Map<string, Link> {
  const out = new Map<string, Link>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(PREFIX) || key === TOMBSTONES_KEY) continue;
      const localId = key.slice(PREFIX.length);
      const link = getLink(localId);
      if (link) out.set(localId, link);
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** Be told when any link changes, here or in another window. Returns the unsubscribe. */
export function subscribeLinks(listener: () => void): () => void {
  listeners.add(listener);
  if (!watchingStorage && typeof window !== "undefined") {
    watchingStorage = true;
    window.addEventListener("storage", (event) => {
      if (event.key === null || event.key.startsWith(PREFIX)) notify();
    });
  }
  return () => {
    listeners.delete(listener);
  };
}

/** The link for a local project, re-rendering when it changes. */
export function useLink(localId: string | null | undefined): Link | null {
  return useSyncExternalStore(
    subscribeLinks,
    () => (localId ? getLink(localId) : null),
    () => null,
  );
}

// --- Rules (pure) ------------------------------------------------------------------

/**
 * Whether a project shows on this device. `deviceAccountId` is the account whose
 * projects the device currently shows (it outlives an involuntary sign-out).
 */
export function isVisible(link: Link | null | undefined, deviceAccountId: string | null | undefined): boolean {
  return link?.kind !== "account" || link.owner === deviceAccountId;
}

/**
 * Whether a project made on this device is still waiting for its content to
 * reach the account for the first time. Until then the account holds nothing
 * of it (or an empty project), so it is not shown as being in the account and
 * nobody can be invited to it. Only the person who made a project owns it at
 * that point, and a project that was downloaded always carries `synced`, so
 * this is only ever true on the device the project was made on.
 */
export function awaitsFirstUpload(link: Link | null | undefined): boolean {
  if (link?.kind !== "account") return false;
  return !link.created || (link.rev === 0 && link.synced === undefined && link.role === "owner");
}

export interface SyncSelection<T> {
  /** Belongs to the signed-in account, or is new: goes to the sync planner. */
  syncable: T[];
  /** Kept on this device (or nobody is signed in): never uploaded. */
  deviceOnly: T[];
  /** Belongs to a different account: hidden and never touched. */
  otherAccount: T[];
}

/**
 * Split the device's projects by what the signed-in user may sync. This is the
 * guard that stops a second account from uploading the first account's work.
 */
export function selectSyncable<T extends { id: string }>(
  projects: readonly T[],
  links: ReadonlyMap<string, Link>,
  userId: string | null | undefined,
): SyncSelection<T> {
  const out: SyncSelection<T> = { syncable: [], deviceOnly: [], otherAccount: [] };
  for (const project of projects) {
    const link = links.get(project.id) ?? null;
    if (link?.kind === "account") {
      (userId && link.owner === userId ? out.syncable : out.otherAccount).push(project);
    } else if (link?.kind === "device" || !userId) {
      out.deviceOnly.push(project);
    } else {
      out.syncable.push(project);
    }
  }
  return out;
}

/** Ids from the list that have no link record yet. */
export function unlinkedIds(projectIds: readonly string[], links: ReadonlyMap<string, Link>): string[] {
  return projectIds.filter((id) => !links.has(id));
}

/**
 * Pin every project that has no record to this device. Run when someone signs
 * in, before the first sync, so work done as a guest is never uploaded
 * silently: the person is asked first. Returns the ids that were pinned.
 */
export function pinUnlinked(projectIds: readonly string[]): string[] {
  const ids = unlinkedIds(projectIds, listLinks());
  for (const id of ids) setLink(id, { kind: "device", asked: false });
  return ids;
}

// --- Legacy keys --------------------------------------------------------------------

const LEGACY_KEYS = ["scholea.token", "scholea.user", "scholea.apiBase"];
const LEGACY_PREFIXES = ["scholea.sync.", "scholea.shared."];

/**
 * Remove what the old self-hosted server client left behind. Its links point at
 * a database that no longer exists and its token is useless. Returns how many
 * keys were removed. Safe to run on every launch.
 */
export function purgeLegacyKeys(storage: Pick<Storage, "length" | "key" | "removeItem"> = localStorage): number {
  const doomed: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key) continue;
      if (LEGACY_KEYS.includes(key) || LEGACY_PREFIXES.some((p) => key.startsWith(p))) doomed.push(key);
    }
    for (const key of doomed) storage.removeItem(key);
  } catch {
    /* ignore */
  }
  return doomed.length;
}
