/**
 * Pure session rules: given the current session state and something that
 * happened, what is the next state and what should the store do about it.
 * No backend, no storage and no clock in here, so every rule is unit-tested.
 *
 * The rule that matters most: only an explicit sign-out or a blocked profile
 * ever leaves `ready`. Starting up offline with an expired token reports "no
 * session" while the refresh token is still there, and that must not sign the
 * person out.
 */
import type {
  AccountStatus,
  DeviceAccount,
  InstanceRole,
  Profile,
  ProfileSource,
  SessionNotice,
  SessionPhase,
  SessionUser,
} from "./types";

export interface SessionData {
  phase: SessionPhase;
  /** Non-null exactly when `phase` is `ready`. */
  profile: Profile | null;
  profileSource: ProfileSource;
  deviceAccount: DeviceAccount | null;
  notice: SessionNotice;
  /**
   * True from the moment an emailed code (sign-up, recovery or invitation) is
   * accepted until the account's password is known to be the one this person
   * chose. If someone else registered the address first, the account still has
   * their password, so the app keeps asking until one is set, and uploads
   * nothing into the account meanwhile. Kept across launches.
   */
  passwordPending: boolean;
}

/** What is kept on the device between launches. Never the access token. */
export interface AccountCache {
  v: 1;
  profile: Profile | null;
  deviceAccount: DeviceAccount | null;
  notice: SessionNotice;
  passwordPending: boolean;
}

export type SessionSignal =
  /**
   * The backend client holds a session for this user (sign-in, refresh,
   * recovery, start-up). `owesPassword`: the session came from an emailed
   * code, so the password is owed from this very moment. It is part of this
   * signal, not a second one, so the device never holds a record of such a
   * session without it.
   */
  | { type: "signed-in"; user: SessionUser; owesPassword?: boolean }
  /** Start-up finished and the client reported no usable session. */
  | { type: "initial-none" }
  /** The session ended. `voluntary` when the person asked for it. */
  | { type: "signed-out"; voluntary: boolean; notice?: SessionNotice }
  | { type: "profile-loaded"; profile: Profile }
  /** The backend answered and there is no profile row for this user. */
  | { type: "profile-missing"; userId: string }
  /** The profile could not be read (offline, server error). Nothing changes. */
  | { type: "profile-failed"; userId: string }
  | { type: "forget-device-account" }
  | { type: "dismiss-notice" }
  /** The password is now settled (`false`), or is owed after all (`true`). */
  | { type: "password-pending"; pending: boolean };

export type SessionEffect =
  | { type: "load-profile"; userId: string }
  /** Drop the local session without telling other devices. */
  | { type: "local-sign-out" }
  /**
   * Put the account name into the local identity. `replace` always writes it.
   * `fill` writes it only when the identity is blank or still shows `email`.
   */
  | { type: "seed-identity"; name: string; mode: "replace" | "fill"; email: string }
  /** Blank the local identity so nothing carries over to another account. */
  | { type: "reset-identity" };

export interface SessionStep {
  next: SessionData;
  effects: SessionEffect[];
}

const ROLES: readonly InstanceRole[] = ["researcher", "supervisor", "admin", "master_admin"];
const STATUSES: readonly AccountStatus[] = ["active", "suspended", "deleted"];
const NOTICES: readonly SessionNotice[] = [null, "expired", "suspended", "removed"];
const NAME_MAX = 200;

const SIGNED_OUT: SessionData = {
  phase: "anon",
  profile: null,
  profileSource: null,
  deviceAccount: null,
  notice: null,
  passwordPending: false,
};

function deviceAccountOf(p: Profile): DeviceAccount {
  return { id: p.id, email: p.email, name: p.name };
}

/** Display name for the local identity: the account name, or the email when there is none. */
function identityName(p: Pick<Profile, "name" | "email">): string {
  return p.name.trim() || p.email;
}

/**
 * A stand-in profile built from the session alone, used until the real row
 * loads. It always carries the least privileged role.
 */
export function provisionalProfile(user: SessionUser): Profile {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    institution: "",
    role: "researcher",
    status: "active",
    mustSetPassword: false,
    createdAt: user.createdAt,
  };
}

/** State at launch, decided synchronously so an offline start is instant. */
export function initialSession(input: { configured: boolean; hasToken: boolean; cache: AccountCache | null }): SessionData {
  const { configured, hasToken, cache } = input;
  const profile = cache?.profile ?? null;
  const deviceAccount = cache?.deviceAccount ?? (profile ? deviceAccountOf(profile) : null);

  if (!configured) {
    // No backend in this build. Keep showing the projects already on the device.
    return { ...SIGNED_OUT, phase: "unconfigured", deviceAccount };
  }
  if (hasToken && profile) {
    return {
      phase: "ready",
      profile,
      profileSource: "cache",
      deviceAccount: deviceAccountOf(profile),
      notice: null,
      passwordPending: cache?.passwordPending === true,
    };
  }
  if (hasToken) {
    return { ...SIGNED_OUT, phase: "loading", deviceAccount, notice: cache?.notice ?? null };
  }
  // No session on the device. If an account was in use, it ended without the
  // person asking, so its projects stay visible and a notice explains.
  return { ...SIGNED_OUT, deviceAccount, notice: deviceAccount ? (cache?.notice ?? "expired") : null };
}

export function nextSession(prev: SessionData, signal: SessionSignal): SessionStep {
  const same: SessionStep = { next: prev, effects: [] };
  if (prev.phase === "unconfigured") return same;

  switch (signal.type) {
    case "signed-in": {
      const user = signal.user;
      if (prev.phase === "ready" && prev.profile?.id === user.id) {
        // Same person (token refresh, password change): just re-check the
        // profile. A password that is owed stays owed; this never settles it.
        const next = signal.owesPassword === true && !prev.passwordPending ? { ...prev, passwordPending: true } : prev;
        return { next, effects: [{ type: "load-profile", userId: user.id }] };
      }
      const profile = provisionalProfile(user);
      const effects: SessionEffect[] = [];
      // A different account than the device last showed: start its identity clean.
      if (prev.deviceAccount?.id !== user.id) effects.push({ type: "reset-identity" });
      effects.push({ type: "seed-identity", name: identityName(profile), mode: "replace", email: profile.email });
      effects.push({ type: "load-profile", userId: user.id });
      return {
        next: {
          phase: "ready",
          profile,
          profileSource: "cache",
          deviceAccount: deviceAccountOf(profile),
          notice: null,
          passwordPending: signal.owesPassword === true,
        },
        effects,
      };
    }

    case "initial-none":
      if (prev.phase !== "loading") return same;
      return { next: { ...prev, phase: "anon", profile: null, profileSource: null }, effects: [] };

    case "signed-out": {
      if (signal.voluntary) {
        const hadAccount = prev.phase === "ready" || prev.deviceAccount !== null;
        if (!hadAccount && prev.phase === "anon" && prev.notice === null) return same;
        return { next: SIGNED_OUT, effects: hadAccount ? [{ type: "reset-identity" }] : [] };
      }
      if (prev.phase === "ready" && prev.profile) {
        return {
          next: {
            ...SIGNED_OUT,
            deviceAccount: prev.deviceAccount ?? deviceAccountOf(prev.profile),
            notice: signal.notice ?? "expired",
          },
          effects: [],
        };
      }
      if (prev.phase === "loading") {
        const notice = prev.notice ?? (prev.deviceAccount ? (signal.notice ?? "expired") : null);
        return { next: { ...prev, phase: "anon", profile: null, profileSource: null, notice }, effects: [] };
      }
      return same;
    }

    case "profile-loaded": {
      const profile = signal.profile;
      if (prev.phase !== "ready" || prev.profile?.id !== profile.id) return same;
      if (profile.status === "active") {
        const effects: SessionEffect[] =
          prev.profileSource === "server"
            ? []
            : [{ type: "seed-identity", name: identityName(profile), mode: "fill", email: profile.email }];
        return {
          next: { ...prev, profile, profileSource: "server", deviceAccount: deviceAccountOf(profile), notice: null },
          effects,
        };
      }
      return {
        next: {
          ...SIGNED_OUT,
          deviceAccount: prev.deviceAccount ?? deviceAccountOf(prev.profile),
          notice: profile.status === "suspended" ? "suspended" : "removed",
        },
        effects: [{ type: "local-sign-out" }],
      };
    }

    case "profile-missing": {
      if (prev.phase !== "ready" || prev.profile?.id !== signal.userId) return same;
      return {
        next: { ...SIGNED_OUT, deviceAccount: prev.deviceAccount ?? deviceAccountOf(prev.profile), notice: "removed" },
        effects: [{ type: "local-sign-out" }],
      };
    }

    case "profile-failed":
      return same;

    case "forget-device-account":
      if (prev.phase !== "anon" || (prev.deviceAccount === null && prev.notice === null)) return same;
      return { next: SIGNED_OUT, effects: prev.deviceAccount ? [{ type: "reset-identity" }] : [] };

    case "dismiss-notice":
      if (prev.notice === null) return same;
      return { next: { ...prev, notice: null }, effects: [] };

    case "password-pending":
      if (prev.phase !== "ready" || prev.passwordPending === signal.pending) return same;
      return { next: { ...prev, passwordPending: signal.pending }, effects: [] };
  }
}

// --- Auth events --------------------------------------------------------------

/** The part of a Supabase session this app reads. The tokens are never touched. */
export interface AuthSessionLike {
  user: {
    id: string;
    email?: string | null;
    created_at?: string | null;
    user_metadata?: Record<string, unknown> | null;
  };
}

export type AuthEventKind = "signed-in" | "initial-none" | "signed-out";

/**
 * Collapse a Supabase auth event into the three things the session cares about.
 * Every event that carries a session means "signed in", including
 * `PASSWORD_RECOVERY` (a recovery code was accepted) and `TOKEN_REFRESHED`.
 */
export function authEventKind(event: string, hasSession: boolean): AuthEventKind | null {
  if (event === "SIGNED_OUT") return "signed-out";
  if (hasSession) return "signed-in";
  if (event === "INITIAL_SESSION") return "initial-none";
  return null;
}

function toMillis(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

export function sessionUserFrom(session: AuthSessionLike | null | undefined): SessionUser | null {
  const user = session?.user;
  if (!user || typeof user.id !== "string" || user.id === "") return null;
  const metaName = user.user_metadata?.name;
  return {
    id: user.id,
    email: typeof user.email === "string" ? user.email : "",
    name: typeof metaName === "string" ? metaName.trim().slice(0, NAME_MAX) : "",
    createdAt: toMillis(user.created_at),
  };
}

// --- Rows and the device cache -------------------------------------------------

/**
 * Turn the caller's account record into a `Profile`, or `null` when it is not
 * one. The record is what the backend function `my_account()` returns: the keys
 * `id`, `email`, `name`, `institution`, `role`, `status`, `must_set_password`
 * and `created_at`.
 */
export function profileFromRow(row: unknown): Profile | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id === "") return null;
  if (!ROLES.includes(r.role as InstanceRole) || !STATUSES.includes(r.status as AccountStatus)) return null;
  return {
    id: r.id,
    email: typeof r.email === "string" ? r.email : "", // null once the account is deleted
    name: typeof r.name === "string" ? r.name : "",
    institution: typeof r.institution === "string" ? r.institution : "",
    role: r.role as InstanceRole,
    status: r.status as AccountStatus,
    mustSetPassword: r.must_set_password === true,
    createdAt: toMillis(r.created_at),
  };
}

function isProfile(v: unknown): v is Profile {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    p.id !== "" &&
    typeof p.email === "string" &&
    typeof p.name === "string" &&
    typeof p.institution === "string" &&
    ROLES.includes(p.role as InstanceRole) &&
    STATUSES.includes(p.status as AccountStatus) &&
    typeof p.mustSetPassword === "boolean" &&
    typeof p.createdAt === "number"
  );
}

function isDeviceAccount(v: unknown): v is DeviceAccount {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return typeof d.id === "string" && d.id !== "" && typeof d.email === "string" && typeof d.name === "string";
}

/** Read the device record. Anything malformed is treated as absent. */
export function parseAccountCache(raw: string | null | undefined): AccountCache | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown> | null;
    if (typeof v !== "object" || v === null || v.v !== 1) return null;
    const profile = isProfile(v.profile) ? v.profile : null;
    const deviceAccount = isDeviceAccount(v.deviceAccount) ? v.deviceAccount : null;
    const notice = NOTICES.includes(v.notice as SessionNotice) ? (v.notice as SessionNotice) : null;
    if (!profile && !deviceAccount && notice === null) return null;
    return { v: 1, profile, deviceAccount, notice, passwordPending: profile !== null && v.passwordPending === true };
  } catch {
    return null;
  }
}

/** What to keep on the device for this state; `null` means remove the record. */
export function accountCacheOf(data: SessionData): AccountCache | null {
  if (!data.profile && !data.deviceAccount && data.notice === null) return null;
  return {
    v: 1,
    profile: data.profile,
    deviceAccount: data.deviceAccount,
    notice: data.notice,
    passwordPending: data.passwordPending,
  };
}
