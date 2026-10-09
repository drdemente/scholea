/**
 * The account session: who is signed in on this device, if anyone. The account
 * is optional, so the research app never waits on this store. A build with no
 * backend reports `unconfigured` and every action refuses with
 * `not_configured`.
 *
 * All state changes go through the pure rules in `session-logic.ts`; this file
 * only talks to the backend client and to storage. It never looks inside the
 * stored session and never keeps a token: every request goes through the
 * client, which supplies a fresh token itself. At sign-out the stored session
 * is taken off the device at once and handed on, unopened, to be ended on the
 * server.
 *
 * Every action throws `SyncError`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { create } from "zustand";
import { resetIdentity, useIdentity } from "@/lib/collab/identity-store";
import { AUTH_STORAGE_KEY, revokeStoredSession, supabase } from "@/lib/supabase/client";
import { supabaseConfig } from "@/lib/supabase/config";
import { SyncError, isConnectivityError, notConfiguredError, toSyncError, unauthenticatedError } from "@/lib/supabase/errors";
import {
  accountCacheOf,
  authEventKind,
  initialSession,
  nextSession,
  parseAccountCache,
  profileFromRow,
  sessionUserFrom,
  type AuthEventKind,
  type AuthSessionLike,
  type SessionData,
  type SessionEffect,
  type SessionSignal,
} from "./session-logic";
import type { Profile, SessionUser } from "./types";

/** localStorage key for the device record: `{ v, profile, deviceAccount, notice, passwordPending }`. */
export const ACCOUNT_KEY = "scholea.account";

/**
 * localStorage key for a short note, `{ v, email }`: an emailed code is being
 * checked for this address. It is written before the code goes to the backend
 * and removed once the device record says that the password is owed. The
 * client stores the session a code earns before this store hears of it, so
 * without the note an app that closed in that moment would come back signed in
 * with nothing owed.
 */
export const CODE_INTENT_KEY = "scholea.account.code";

/**
 * The client repeats its "signed in" event whenever the window regains focus.
 * A profile the backend confirmed this recently is not asked for again.
 */
export const PROFILE_RECHECK_MS = 60_000;

/**
 * Backend function that returns the caller's own account record, or `null`
 * when the account no longer exists. See `profileFromRow` for its keys.
 */
export const ACCOUNT_RPC = "my_account";

// --- What the store needs from the backend client ------------------------------
// A narrow structural view of the Supabase client, so tests can pass a plain
// hand-written object.

interface AuthResult<T> {
  data: T;
  error: unknown;
}
interface DataResult {
  data: unknown;
  error: unknown;
  status: number;
}

export interface SessionClient {
  auth: {
    onAuthStateChange(callback: (event: string, session: AuthSessionLike | null) => void): unknown;
    getSession(): Promise<AuthResult<{ session: AuthSessionLike | null }>>;
    signInWithPassword(credentials: { email: string; password: string }): Promise<AuthResult<{ session: AuthSessionLike | null }>>;
    signUp(credentials: {
      email: string;
      password: string;
      options?: { data?: Record<string, unknown> };
    }): Promise<AuthResult<{ session: AuthSessionLike | null }>>;
    verifyOtp(params: {
      email: string;
      token: string;
      type: "email" | "recovery" | "invite";
    }): Promise<AuthResult<{ session: AuthSessionLike | null }>>;
    resend(params: { type: "signup"; email: string }): Promise<AuthResult<unknown>>;
    resetPasswordForEmail(email: string): Promise<AuthResult<unknown>>;
    updateUser(attributes: { password?: string; current_password?: string }): Promise<AuthResult<unknown>>;
    signOut(options: { scope: "local" }): Promise<{ error: unknown }>;
  };
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<DataResult>;
}

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The local collaborator identity, as far as the session needs it. */
export interface IdentityPort {
  getName(): string;
  setName(name: string): void;
  reset(): void;
}

export interface SessionDeps {
  /** The backend client, or `null` in a build with no backend. */
  client: SessionClient | null;
  storage: StorageLike;
  identity?: IdentityPort;
  /** Runs a callback later, outside the auth callback. Tests pass a queue. */
  defer?: (run: () => void) => void;
  /** The clock, in epoch milliseconds. Tests pass their own. */
  now?: () => number;
  /**
   * Ends on the server a session this device has already forgotten. It is
   * given the stored session exactly as the client kept it. Best effort: its
   * failure changes nothing here.
   */
  revoke?: (stored: string) => Promise<void>;
}

export interface SessionState extends SessionData {
  /** Start listening to the backend client. Safe to call more than once. */
  init(): void;
  signIn(email: string, password: string): Promise<void>;
  /** `confirm` when a code was emailed; `signedIn` when the server needs no confirmation. */
  signUp(input: { name: string; email: string; password: string }): Promise<"confirm" | "signedIn">;
  confirmSignUp(email: string, code: string): Promise<void>;
  resendSignUpCode(email: string): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  verifyEmailCode(email: string, code: string, kind: "recovery" | "invite"): Promise<void>;
  /** Set a password on a session that came from a recovery or invitation code. */
  setPassword(next: string): Promise<void>;
  /**
   * Make sure the signed-in account's password is the one this person typed.
   * Run straight after a sign-up code is accepted: if someone else registered
   * the address first, the account would otherwise keep their password.
   * Throws `invalid_credentials` when the server insists on the current
   * password and it is a different one; the caller then falls back to a
   * recovery code.
   */
  securePassword(password: string): Promise<void>;
  /** Save the caller's own name or institution, then reload the profile. */
  updateMyProfile(patch: { name?: string; institution?: string }): Promise<void>;
  changePassword(current: string, next: string): Promise<void>;
  /**
   * Re-read the caller's profile from the backend. Resolves with it, or with
   * `null` when nobody is signed in (including when the fresh profile turned
   * out to be suspended or removed). Throws when the backend cannot be reached.
   */
  refreshProfile(): Promise<Profile | null>;
  /** Voluntary. Signs out this device only and always clears local state. */
  signOut(): Promise<void>;
  /** Stop showing a signed-out account's projects on this device. */
  forgetDeviceAccount(): void;
  dismissNotice(): void;
}

type LoadResult = { kind: "loaded"; profile: Profile } | { kind: "missing" } | { kind: "failed"; error: SyncError };

async function fetchProfile(client: SessionClient, userId: string): Promise<LoadResult> {
  try {
    // With no live session the request would go out with the public key and
    // could look like "no such profile". Only a signed-in read may conclude that.
    const current = await client.auth.getSession();
    if (sessionUserFrom(current.data.session)?.id !== userId) {
      // A session that could not be refreshed because the backend is out of
      // reach is a connection problem, not a sign-out.
      const why = current.error ? toSyncError(current.error) : null;
      return { kind: "failed", error: why && isConnectivityError(why) ? why : unauthenticatedError() };
    }

    // The one backend function that still answers a suspended or removed
    // account, so the person can be told why they were signed out. The backend
    // lets no client read a table directly.
    const { data, error, status } = await client.rpc(ACCOUNT_RPC);
    if (error) return { kind: "failed", error: toSyncError(error, status) };
    if (data === null || data === undefined) return { kind: "missing" };
    const profile = profileFromRow(data);
    if (!profile || profile.id !== userId) return { kind: "failed", error: new SyncError(500, "server_error") };
    return { kind: "loaded", profile };
  } catch (e) {
    return { kind: "failed", error: toSyncError(e) };
  }
}

export function createSessionStore(deps: SessionDeps) {
  const { client, storage } = deps;
  const identity = deps.identity ?? null;
  const defer = deps.defer ?? ((run: () => void) => void setTimeout(run, 0));
  const now = deps.now ?? (() => Date.now());

  // Storage can be unavailable (private mode, quota). The session still works.
  const read = (key: string): string | null => {
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  };
  const remove = (key: string): void => {
    try {
      storage.removeItem(key);
    } catch {
      /* ignore */
    }
  };
  const sameAddress = (a: string, b: string): boolean => a.trim() !== "" && a.trim().toLowerCase() === b.trim().toLowerCase();

  /** An emailed code is about to be checked for this address. See `CODE_INTENT_KEY`. */
  const noteCode = (email: string): void => {
    try {
      storage.setItem(CODE_INTENT_KEY, JSON.stringify({ v: 1, email: email.trim().toLowerCase() }));
    } catch {
      /* ignore */
    }
  };
  /** Whether a code was being checked for this address when a session for it turned up. */
  const codeNoted = (email: string): boolean => {
    const raw = read(CODE_INTENT_KEY);
    if (!raw) return false;
    try {
      const note = JSON.parse(raw) as { email?: unknown } | null;
      return typeof note?.email === "string" && sameAddress(note.email, email);
    } catch {
      return false;
    }
  };
  const persist = (next: SessionData): void => {
    const record = accountCacheOf(next);
    if (!record) return remove(ACCOUNT_KEY);
    try {
      storage.setItem(ACCOUNT_KEY, JSON.stringify(record));
    } catch {
      /* ignore */
    }
  };

  let started = false;
  /** Set by `signOut()` so the sign-out event it causes is known to be voluntary. */
  let voluntary = false;
  /** Above zero while this store is dropping the local session. */
  let dropping = 0;
  /** Sign-outs the client has not finished yet. */
  const leaving = new Set<Promise<void>>();
  /** Profile reads in flight, one per user. */
  const loads = new Map<string, Promise<LoadResult>>();
  /** Whose profile the backend last confirmed, and when. */
  let confirmed: { userId: string; at: number } | null = null;

  return create<SessionState>((set, get) => {
    const data = (): SessionData => {
      const s = get();
      return {
        phase: s.phase,
        profile: s.profile,
        profileSource: s.profileSource,
        deviceAccount: s.deviceAccount,
        notice: s.notice,
        passwordPending: s.passwordPending,
      };
    };

    function dispatch(signal: SessionSignal): void {
      const prev = data();
      const { next, effects } = nextSession(prev, signal);
      if (next !== prev) {
        set(next);
        persist(next);
      }
      for (const effect of effects) runEffect(effect);
    }

    function runEffect(effect: SessionEffect): void {
      switch (effect.type) {
        case "load-profile":
          void loadProfile(effect.userId);
          break;
        case "local-sign-out":
          void dropLocalSession();
          break;
        case "seed-identity": {
          if (!identity || !effect.name) break;
          const current = identity.getName().trim();
          if (effect.mode === "fill" && current !== "" && current !== effect.email) break;
          if (current !== effect.name) identity.setName(effect.name);
          break;
        }
        case "reset-identity":
          identity?.reset();
          break;
      }
    }

    /**
     * Sign out this device only. The stored session goes first, before
     * anything is waited for, so closing the app a moment later cannot sign
     * the person back in. Then the client is told, which can take a while when
     * it is busy refreshing a token, and the server is asked to end the
     * session (`revoke`), which needs a connection. Neither is needed for this
     * device to be signed out. Resolves when the client has finished.
     */
    function dropLocalSession(): Promise<void> {
      const stored = read(AUTH_STORAGE_KEY);
      remove(AUTH_STORAGE_KEY);
      remove(CODE_INTENT_KEY);
      dropping += 1;
      const told = (async () => {
        try {
          await client?.auth.signOut({ scope: "local" });
        } catch {
          /* nothing was left for it to remove */
        }
      })();
      const done: Promise<void> = told.finally(() => {
        // Whatever is stored by now, a refresh that was in flight wrote back.
        // It cannot be a new sign-in: those wait for this (`left`).
        remove(AUTH_STORAGE_KEY);
        dropping -= 1;
        leaving.delete(done);
      });
      leaving.add(done);
      if (stored !== null && deps.revoke) {
        const revoke = deps.revoke;
        void Promise.resolve()
          .then(() => revoke(stored))
          .catch(() => {});
      }
      return done;
    }

    /**
     * Wait for the client to finish any sign-out before signing in. When it
     * gets to it, the client removes whatever session it finds, so one that
     * was stored in the meantime would be signed out with it.
     */
    async function left(): Promise<void> {
      while (leaving.size > 0) await Promise.allSettled([...leaving]);
    }

    /**
     * Read the profile and apply the result. Concurrent calls for one user share
     * a read; `fresh` waits for the read in flight and then starts a new one, so
     * the result reflects a change that was just saved.
     */
    function loadProfile(userId: string, fresh = false): Promise<LoadResult> {
      if (!client) return Promise.resolve<LoadResult>({ kind: "failed", error: notConfiguredError() });
      const running = loads.get(userId);
      if (running && !fresh) return running;
      const start = (): Promise<LoadResult> =>
        fetchProfile(client, userId).then((result) => {
          if (result.kind === "loaded") {
            confirmed = { userId, at: now() };
            dispatch({ type: "profile-loaded", profile: result.profile });
          } else if (result.kind === "missing") dispatch({ type: "profile-missing", userId });
          else dispatch({ type: "profile-failed", userId });
          return result;
        });
      const load: Promise<LoadResult> = (running ? running.then(start, start) : start()).finally(() => {
        if (loads.get(userId) === load) loads.delete(userId);
      });
      loads.set(userId, load);
      return load;
    }

    /**
     * A call on the client succeeded with a session: adopt it and confirm the
     * profile. `owesPassword` is for a session an emailed code earned: the
     * state write that adopts it also says the password is owed, so the
     * device record never shows such a session without it, however long the
     * profile takes to arrive.
     */
    async function enter(user: SessionUser | null, owesPassword = false): Promise<void> {
      if (!user) throw new SyncError(500, "server_error");
      voluntary = false;
      dispatch({ type: "signed-in", user, ...(owesPassword ? { owesPassword: true } : {}) });
      await loadProfile(user.id);
      const s = get();
      if (s.phase !== "ready" || s.profile?.id !== user.id) {
        // The profile turned out to be blocked, and the session was dropped.
        throw s.notice === "suspended" ? new SyncError(403, "account_suspended") : unauthenticatedError();
      }
    }

    function onAuthEvent(kind: AuthEventKind | null, user: SessionUser | null): void {
      if (kind === "signed-in") {
        if (dropping > 0) {
          // The session is being dropped. A refresh that was in flight has
          // just written it back: it goes again, at once.
          remove(AUTH_STORAGE_KEY);
          return;
        }
        // Skip a late event for a session this store has already dropped.
        if (!user || read(AUTH_STORAGE_KEY) === null) return;
        voluntary = false;
        // A code was being checked for this address when the app last closed,
        // or its answer is still on the way: the password is owed.
        const owes = codeNoted(user.email);
        // For the person already signed in this event only means "check the
        // profile again". Skip that when it was confirmed moments ago.
        const s = get();
        const sameUser = s.phase === "ready" && s.profile?.id === user.id && s.profileSource === "server";
        const settled = !owes || s.passwordPending;
        if (sameUser && settled && confirmed?.userId === user.id && now() - confirmed.at < PROFILE_RECHECK_MS) return;
        dispatch({ type: "signed-in", user, ...(owes ? { owesPassword: true } : {}) });
        // The device record says it now, and keeps saying it.
        if (owes) remove(CODE_INTENT_KEY);
      } else if (kind === "initial-none") {
        dispatch({ type: "initial-none" });
      } else if (kind === "signed-out") {
        // The client removes its session before it says so. If one is stored,
        // this is the end of an earlier session, heard late: somebody has
        // signed in since.
        if (read(AUTH_STORAGE_KEY) !== null) return;
        // Voluntary when we asked for it, or when the device record is gone
        // (the person signed out in another window).
        const raw = read(ACCOUNT_KEY);
        const wasVoluntary = voluntary || raw === null;
        voluntary = false;
        dispatch({ type: "signed-out", voluntary: wasVoluntary, notice: parseAccountCache(raw)?.notice ?? undefined });
      }
    }

    function requireClient(): SessionClient {
      if (!client) throw notConfiguredError();
      return client;
    }

    /** Run an auth call and return its data, or throw the mapped `SyncError`. */
    async function auth<T>(run: () => Promise<AuthResult<T>>): Promise<T> {
      let result: AuthResult<T>;
      try {
        result = await run();
      } catch (e) {
        throw toSyncError(e);
      }
      if (result.error) throw toSyncError(result.error);
      return result.data;
    }

    /** Reload the profile after a change. A connection problem is not an error here. */
    async function reloadQuietly(): Promise<void> {
      const id = get().profile?.id;
      if (id) await loadProfile(id, true);
    }

    /**
     * Exchange an emailed code for a session. Whatever the code was for, the
     * address is confirmed from here on and the person is signed in, while the
     * account's password may still be one that somebody else chose. So the
     * password is owed until this person has saved their own.
     */
    async function redeem(email: string, code: string, type: "email" | "recovery" | "invite"): Promise<void> {
      const c = requireClient();
      await left();
      noteCode(email);
      try {
        const result = await auth(() => c.auth.verifyOtp({ email, token: code, type }));
        await enter(sessionUserFrom(result.session), true);
      } finally {
        // Refused, or the device record has taken over from the note.
        remove(CODE_INTENT_KEY);
      }
    }

    const initial = initialSession({
      configured: client !== null,
      hasToken: read(AUTH_STORAGE_KEY) !== null,
      cache: parseAccountCache(read(ACCOUNT_KEY)),
    });

    return {
      ...initial,

      init() {
        if (started || !client) return;
        started = true;
        const s = get();
        if (s.phase === "ready" && s.profile) {
          // Launching already signed in: fill in the identity only if it is blank.
          runEffect({ type: "seed-identity", name: s.profile.name.trim() || s.profile.email, mode: "fill", email: s.profile.email });
        }
        client.auth.onAuthStateChange((event, session) => {
          // This runs inside the client's own lock. Calling the client here, or
          // waiting on it, can deadlock, so only note what happened and return.
          const kind = authEventKind(event, session !== null);
          const user = sessionUserFrom(session);
          defer(() => onAuthEvent(kind, user));
        });
      },

      async signIn(email, password) {
        const c = requireClient();
        await left();
        // A password sign-in is not a code. A note left by a code that never finished says nothing about it.
        remove(CODE_INTENT_KEY);
        const result = await auth(() => c.auth.signInWithPassword({ email, password }));
        await enter(sessionUserFrom(result.session));
        // The account accepted the password this person typed, so it is theirs.
        dispatch({ type: "password-pending", pending: false });
      },

      async signUp({ name, email, password }) {
        const c = requireClient();
        await left();
        remove(CODE_INTENT_KEY);
        const result = await auth(() => c.auth.signUp({ email, password, options: { data: { name } } }));
        // Deliberately not looking at whether the address already had an
        // account: the answer must be the same either way.
        const user = sessionUserFrom(result.session);
        if (!user) return "confirm";
        await enter(user);
        return "signedIn";
      },

      async confirmSignUp(email, code) {
        await redeem(email, code, "email");
      },

      async resendSignUpCode(email) {
        const c = requireClient();
        await auth(() => c.auth.resend({ type: "signup", email }));
      },

      async requestPasswordReset(email) {
        const c = requireClient();
        await auth(() => c.auth.resetPasswordForEmail(email));
      },

      async verifyEmailCode(email, code, kind) {
        await redeem(email, code, kind);
      },

      async setPassword(next) {
        const c = requireClient();
        try {
          await auth(() => c.auth.updateUser({ password: next }));
        } catch (e) {
          // The account already has this very password, so it is this
          // person's and nothing is owed. They are still told to choose another.
          if (e instanceof SyncError && e.code === "same_password") dispatch({ type: "password-pending", pending: false });
          throw e;
        }
        dispatch({ type: "password-pending", pending: false });
        await reloadQuietly();
      },

      async securePassword(password) {
        const c = requireClient();
        try {
          await auth(() => c.auth.updateUser({ password, current_password: password }));
        } catch (e) {
          // "Same password" means it already is the account's password, which
          // is exactly what this call is here to establish.
          if (!(e instanceof SyncError && e.code === "same_password")) throw e;
        }
        dispatch({ type: "password-pending", pending: false });
      },

      async updateMyProfile(patch) {
        const c = requireClient();
        const args: Record<string, unknown> = {};
        if (patch.name !== undefined) args.p_name = patch.name;
        if (patch.institution !== undefined) args.p_institution = patch.institution;
        let result: DataResult;
        try {
          result = await c.rpc("update_my_profile", args);
        } catch (e) {
          throw toSyncError(e);
        }
        if (result.error) throw toSyncError(result.error, result.status);
        if (patch.name && identity && identity.getName() !== patch.name) identity.setName(patch.name);
        await reloadQuietly();
      },

      async changePassword(current, next) {
        const c = requireClient();
        const email = get().profile?.email;
        if (get().phase !== "ready" || !email) throw unauthenticatedError();
        // Signing in again proves the current password whatever the server's own
        // rules are, and makes the session fresh enough for a password change.
        await auth(() => c.auth.signInWithPassword({ email, password: current }));
        await auth(() => c.auth.updateUser({ password: next, current_password: current }));
        dispatch({ type: "password-pending", pending: false });
      },

      async refreshProfile() {
        requireClient();
        const before = get();
        if (before.phase !== "ready" || !before.profile) return null;
        const result = await loadProfile(before.profile.id, true);
        if (result.kind === "failed") throw result.error;
        const after = get();
        return after.phase === "ready" ? after.profile : null;
      },

      async signOut() {
        if (!client) return;
        voluntary = true;
        // Local state and the stored session go first and at once, so this
        // works offline and never waits on the network. What the client and
        // the server still have to do is not waited for.
        dispatch({ type: "signed-out", voluntary: true });
        void dropLocalSession();
      },

      forgetDeviceAccount() {
        dispatch({ type: "forget-device-account" });
      },

      dismissNotice() {
        dispatch({ type: "dismiss-notice" });
      },
    };
  });
}

// --- The app's own session -----------------------------------------------------

const deviceStorage: StorageLike = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: (key) => localStorage.removeItem(key),
};

const localIdentity: IdentityPort = {
  getName: () => useIdentity.getState().name,
  setName: (name) => useIdentity.getState().setName(name),
  reset: resetIdentity,
};

/**
 * The real client seen through the narrow view above. Written out call by call:
 * the client's own generic types are too deep to compare structurally, and
 * calling through `c.auth` keeps each method bound to its object.
 */
export function sessionClientOf(c: SupabaseClient | null): SessionClient | null {
  if (!c) return null;
  return {
    auth: {
      onAuthStateChange: (callback) => c.auth.onAuthStateChange((event, session) => callback(event, session)),
      getSession: () => c.auth.getSession(),
      signInWithPassword: (credentials) => c.auth.signInWithPassword(credentials),
      signUp: (credentials) => c.auth.signUp(credentials),
      verifyOtp: (params) => c.auth.verifyOtp(params),
      resend: (params) => c.auth.resend(params),
      resetPasswordForEmail: (email) => c.auth.resetPasswordForEmail(email),
      updateUser: (attributes) => c.auth.updateUser(attributes),
      signOut: (options) => c.auth.signOut(options),
    },
    rpc: (fn, args) => c.rpc(fn, args),
  };
}

export const useSession = createSessionStore({
  client: sessionClientOf(supabase),
  storage: deviceStorage,
  identity: localIdentity,
  revoke: (stored) => revokeStoredSession(supabaseConfig, stored),
});
