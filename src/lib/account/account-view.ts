/**
 * What the account menu and Projects home show about the account, worked out
 * from the session, the sync status and the project links. All pure, so the
 * wording and the rules behind it are unit-tested without a screen.
 */
import { awaitsFirstUpload, type Link } from "@/lib/collab/links";
import { SyncError, describeSyncError } from "@/lib/collab/sync";
import type { DeviceAccount, SessionNotice, SessionPhase } from "./types";

// --- Where a project lives -----------------------------------------------------------

/**
 * `device`: only on this device. `waiting`: on its way into the person's
 * account, but its content has not been uploaded yet. `account`: the person's
 * own, in their account. `shared`: someone else's.
 */
export type ProjectChip = "device" | "waiting" | "account" | "shared";

export const CHIP_LABEL: Record<ProjectChip, string> = {
  device: "This device only",
  waiting: "Not uploaded yet",
  account: "In your account",
  shared: "Shared with you",
};

export function projectChip(link: Link | null | undefined): ProjectChip {
  if (link?.kind !== "account") return "device";
  // Until its content has reached the account it is not said to be there.
  if (awaitsFirstUpload(link)) return "waiting";
  return link.role === "owner" ? "account" : "shared";
}

// --- Work done before signing in -----------------------------------------------------

/**
 * The projects to ask about after someone signs in: they were on the device
 * already, and the person has not yet said whether they belong in the account.
 */
export function adoptableIds(projectIds: readonly string[], linkOf: (id: string) => Link | null): string[] {
  return projectIds.filter((id) => {
    const link = linkOf(id);
    return link?.kind === "device" && !link.asked;
  });
}

/**
 * Whether a failure to add one project to the account would be the same for
 * every other project: there is no connection, or the account cannot be used
 * right now. Anything else is about that one project (it is too large, say),
 * and the others are still worth adding.
 */
export function stopsAdoption(e: unknown): boolean {
  if (!(e instanceof SyncError)) return true;
  return ["network", "offline", "not_configured", "unauthenticated", "account_suspended", "password_reset_required", "rate_limited"].includes(e.code);
}

export function adoptionMessage(count: number): string {
  return count === 1
    ? "1 project on this device isn't in your account yet."
    : `${count} projects on this device aren't in your account yet.`;
}

// --- Banners ---------------------------------------------------------------------------

/**
 * Whether to invite a guest to make an account. Never in a build with no
 * backend, never to someone who has an account on this device, and never
 * again once dismissed.
 */
export function shouldShowPromo(input: {
  phase: SessionPhase;
  deviceAccount: DeviceAccount | null;
  dismissed: boolean;
}): boolean {
  return input.phase === "anon" && input.deviceAccount === null && !input.dismissed;
}

/** The account that was signed out without the person asking, or `null`. */
export function signedOutAccount(input: { phase: SessionPhase; deviceAccount: DeviceAccount | null }): DeviceAccount | null {
  return input.phase === "anon" ? input.deviceAccount : null;
}

/** What to tell someone whose session ended without them asking. */
export function signedOutMessage(notice: SessionNotice, email: string): string {
  const who = email || "your account";
  if (notice === "suspended") {
    return `${who} has been suspended, so you've been signed out. Your projects are still on this device but won't sync. Contact an administrator.`;
  }
  if (notice === "removed") {
    return `The account ${who} no longer exists, so you've been signed out. Your projects are still on this device but won't sync.`;
  }
  return `You've been signed out of ${who}. Your projects are still on this device but won't sync until you sign in again.`;
}

/** What to tell someone whose projects were kept as copies when their server copy went away. */
export function detachedMessage(titles: readonly string[]): string {
  if (titles.length === 1) {
    const title = titles[0].trim() || "A project";
    return `${title} is no longer in your account. It was kept here as a copy on this device only.`;
  }
  return `${titles.length} projects are no longer in your account. They were kept here as copies on this device only.`;
}

/**
 * What to tell someone whose own version of a project was kept apart: somebody
 * else wrote to the copy in the account before this device had ever uploaded.
 */
export function divergedMessage(titles: readonly string[]): string {
  if (titles.length === 1) {
    const title = titles[0].trim() || "A project";
    return `${title} was changed in your account before this device had uploaded its own version. Your version was kept here as a separate copy on this device only, and the account's version was downloaded beside it.`;
  }
  return `${titles.length} projects were changed in your account before this device had uploaded its own versions. Your versions were kept here as separate copies on this device only, and the account's versions were downloaded beside them.`;
}

/** What to tell someone who asked to leave a project and turned out to be its only owner by then. */
export function notLeftMessage(titles: readonly string[]): string {
  if (titles.length === 1) {
    const title = titles[0].trim() || "a project";
    return `You are now the only owner of ${title}, so you could not leave it. It is on this device again. Make someone else an owner first, or delete it for everyone.`;
  }
  return `You are now the only owner of ${titles.length} projects, so you could not leave them. They are on this device again. Make someone else an owner first, or delete them for everyone.`;
}

// --- Deleting ----------------------------------------------------------------------------

/** See `deletionEffect` in `project-sync.ts`. */
export type DeletionEffect = "device" | "everyone" | "leave";

export interface DeleteCopy {
  heading: string;
  /** Follows the project's title in the sentence. */
  rest: string;
  confirmLabel: string;
  /** Extra sentence when the account cannot be told right now. */
  later: string | null;
}

/**
 * The wording of the delete confirmation. `reachable` says whether the account
 * the project belongs to can be told now (its owner is signed in and online).
 */
export function deleteCopy(effect: DeletionEffect, reachable: boolean): DeleteCopy {
  const later = reachable ? null : "This device can't reach your account right now. The change is sent the next time you sync here.";
  if (effect === "everyone") {
    return {
      heading: "Delete project for everyone?",
      rest: "will be deleted from your account, for you and for everyone it is shared with, and removed from this device. This can't be undone.",
      confirmLabel: "Delete for everyone",
      later,
    };
  }
  if (effect === "leave") {
    return {
      heading: "Leave project?",
      rest: "will be removed from this device and you'll no longer be a member. The other members keep it.",
      confirmLabel: "Leave project",
      later,
    };
  }
  return {
    heading: "Delete project?",
    rest: "and all its saved progress will be permanently removed from this device. This can't be undone.",
    confirmLabel: "Delete",
    later: null,
  };
}

/**
 * What to say once a project is gone. `result` is what `deleteProjectEverywhere`
 * resolved with. It says what was really done: someone who was asked about
 * deleting for everyone and is no longer an owner has only left.
 */
export function deletionNotice(effect: DeletionEffect, result: "local" | "deleted" | "left" | "queued"): { kind: "success" | "info"; text: string } {
  if (result === "queued") {
    return { kind: "info", text: "Removed from this device. Your account is updated the next time you sync here." };
  }
  if (result === "left" || (result === "deleted" && effect === "leave")) return { kind: "success", text: "You left the project." };
  if (result === "deleted" && effect === "everyone") return { kind: "success", text: "Project deleted from your account." };
  return { kind: "success", text: "Project deleted." };
}

/** Why a project could not be deleted or left. Nothing was removed. */
export function describeDeleteError(e: unknown): string {
  if (e instanceof SyncError && e.code === "last_owner") {
    return "You are the only owner of this project now, so you can't leave it. Make someone else an owner first, or delete it for everyone.";
  }
  if (e instanceof SyncError && e.code === "conflict") {
    return "This project was added to your account in the meantime. Check what deleting it does now, then try again.";
  }
  return "The project could not be removed from this device. Try again.";
}

// --- Sync status --------------------------------------------------------------------------

export type SyncTone = "synced" | "syncing" | "offline" | "error" | "waiting";

export interface SyncLine {
  /** Picks the icon, so the state is never told by colour alone. */
  tone: SyncTone;
  text: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Synced just now", "Synced 5 minutes ago", ... */
export function syncedAgo(lastSyncedAt: number, now: number): string {
  // A time slightly in the future (clocks differ) reads as "just now" too.
  const age = now - lastSyncedAt;
  if (age < MINUTE) return "Synced just now";
  if (age < HOUR) {
    const minutes = Math.floor(age / MINUTE);
    return `Synced ${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  }
  if (age < DAY) {
    const hours = Math.floor(age / HOUR);
    return `Synced ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  const days = Math.floor(age / DAY);
  return `Synced ${days} ${days === 1 ? "day" : "days"} ago`;
}

/** The one line about sync in the account menu. */
export function syncLine(
  status: { state: "idle" | "syncing" | "offline" | "error"; lastSyncedAt: number | null; errorCode: string | null },
  now: number,
  /** The person still has to choose a password: the backend refuses them until then. */
  waitingForPassword = false,
): SyncLine {
  if (waitingForPassword) return { tone: "waiting", text: "Sync starts once you choose a password." };
  if (status.state === "syncing") return { tone: "syncing", text: "Syncing…" };
  if (status.state === "offline") return { tone: "offline", text: "Offline. Changes will sync later." };
  if (status.state === "error") {
    if (status.errorCode === "storage_error") {
      return { tone: "error", text: "Scholea couldn't read the projects saved on this device. Sync is paused." };
    }
    return { tone: "error", text: `Sync didn't finish. ${describeSyncError(new SyncError(0, status.errorCode ?? "server_error"))}` };
  }
  if (status.lastSyncedAt === null) return { tone: "waiting", text: "Not synced yet" };
  return { tone: "synced", text: syncedAgo(status.lastSyncedAt, now) };
}

// --- The person's own profile ----------------------------------------------------------------

/** The longest name or institution the account accepts. */
export const PROFILE_FIELD_MAX = 200;

export interface ProfileEdit {
  name: string;
  institution: string;
}

/** Problems with an edited profile, each under the field it belongs to. Empty when there are none. */
export function profileFields(edit: ProfileEdit): Partial<Record<keyof ProfileEdit, string>> {
  const out: Partial<Record<keyof ProfileEdit, string>> = {};
  const name = edit.name.trim();
  // Counted the way the account counts: whole characters.
  if (!name) out.name = "Enter your name.";
  else if (Array.from(name).length > PROFILE_FIELD_MAX) out.name = `Use ${PROFILE_FIELD_MAX} characters or fewer.`;
  if (Array.from(edit.institution.trim()).length > PROFILE_FIELD_MAX) out.institution = `Use ${PROFILE_FIELD_MAX} characters or fewer.`;
  return out;
}

/**
 * What to send when a profile is saved: only what differs from the account as
 * it is, tidied the way the account stores it. Empty when nothing changed.
 */
export function profileChanges(before: ProfileEdit, edit: ProfileEdit): Partial<ProfileEdit> {
  const out: Partial<ProfileEdit> = {};
  if (edit.name.trim() !== before.name.trim()) out.name = edit.name.trim();
  if (edit.institution.trim() !== before.institution.trim()) out.institution = edit.institution.trim();
  return out;
}

/** Why a profile could not be saved. */
export function describeProfileError(e: unknown): string {
  if (e instanceof SyncError && e.code === "invalid_input") return "The server did not accept that. Check the name and institution, then try again.";
  if (e instanceof SyncError && e.code === "rate_limited") return "Your profile was changed many times in the last hour. Try again later.";
  return describeSyncError(e);
}

// --- Small things ---------------------------------------------------------------------------

/** The letter in the avatar. */
export function initialOf(name: string, email: string): string {
  const source = name.trim() || email.trim();
  const first = Array.from(source)[0];
  return first ? first.toUpperCase() : "?";
}

/** The name to greet someone by: their name, or their address when they gave none. */
export function displayName(account: { name: string; email: string }): string {
  return account.name.trim() || account.email;
}

/**
 * The toast for a flow that ran to its end. It always names the account. The
 * name on it is what collaborators see, and after a code somebody else may
 * have chosen it (they registered the address first), so the person should
 * see it at once. It is changed under "Edit profile" in the account menu.
 */
export function outcomeMessage(outcome: "signedIn" | "accountCreated" | "passwordChanged", account: { name: string; email: string } | null): string {
  const who = account ? displayName(account) : "";
  const signedIn = who ? `signed in as ${who}.` : "signed in.";
  if (outcome === "accountCreated") return `Account created. You're ${signedIn}`;
  if (outcome === "passwordChanged") return `Password updated. You're ${signedIn}`;
  return who ? `Signed in as ${who}.` : "Signed in.";
}
