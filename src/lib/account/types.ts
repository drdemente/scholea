/**
 * Shared account types. No runtime imports, so UI and tests can use them
 * without pulling in the backend client.
 */

/** A person's role on the whole instance. A project role is a separate thing. */
export type InstanceRole = "researcher" | "supervisor" | "admin" | "master_admin";

export type AccountStatus = "active" | "suspended" | "deleted";

/** The signed-in person's own account record, as the backend returns it. */
export interface Profile {
  id: string;
  email: string;
  name: string;
  institution: string;
  role: InstanceRole;
  status: AccountStatus;
  /**
   * True for an invited person who has entered their code but not chosen a
   * password yet. The backend refuses all data access until they do.
   */
  mustSetPassword: boolean;
  /** Epoch milliseconds. */
  createdAt: number;
}

/**
 * - `unconfigured`: this build has no backend. There is no account UI at all.
 * - `loading`: a saved session exists but nothing is known about it yet.
 * - `anon`: nobody is signed in. The app works fully without an account.
 * - `ready`: signed in. `profile` is set.
 */
export type SessionPhase = "unconfigured" | "loading" | "anon" | "ready";

/** Why the person was signed out without asking for it. */
export type SessionNotice = null | "expired" | "suspended" | "removed";

/**
 * Where the current `profile` came from. `server` means the backend confirmed
 * it during this launch. `cache` means it has not: it was restored from the
 * device or built from the session itself. Anything that grants access must
 * require `server`.
 */
export type ProfileSource = "server" | "cache" | null;

/**
 * The account whose projects this device currently shows. It outlives an
 * involuntary sign-out, so those projects stay visible until the person signs
 * out on purpose or removes the account from the device.
 */
export interface DeviceAccount {
  id: string;
  email: string;
  name: string;
}

/** What the session carries about its user. The access token is never kept. */
export interface SessionUser {
  id: string;
  email: string;
  /** Name given at sign-up, if any. The profile row is the source of truth. */
  name: string;
  /** Epoch milliseconds, or 0 when unknown. */
  createdAt: number;
}
