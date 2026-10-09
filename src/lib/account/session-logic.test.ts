import { describe, expect, it } from "vitest";
import {
  accountCacheOf,
  authEventKind,
  initialSession,
  nextSession,
  parseAccountCache,
  profileFromRow,
  provisionalProfile,
  sessionUserFrom,
  type AccountCache,
  type SessionData,
} from "./session-logic";
import type { Profile, SessionUser } from "./types";

const ada: Profile = {
  id: "user-ada",
  email: "ada@example.test",
  name: "Ada Lovelace",
  institution: "Analytical Society",
  role: "researcher",
  status: "active",
  mustSetPassword: false,
  createdAt: 1_700_000_000_000,
};
const adaUser: SessionUser = { id: ada.id, email: ada.email, name: ada.name, createdAt: ada.createdAt };
const adaDevice = { id: ada.id, email: ada.email, name: ada.name };
const bobUser: SessionUser = { id: "user-bob", email: "bob@example.test", name: "", createdAt: 0 };

const anon: SessionData = { phase: "anon", profile: null, profileSource: null, deviceAccount: null, notice: null, passwordPending: false };
const readyCached: SessionData = { ...anon, phase: "ready", profile: ada, profileSource: "cache", deviceAccount: adaDevice };
const readyServer: SessionData = { ...readyCached, profileSource: "server" };
const cacheOf = (over: Partial<AccountCache> = {}): AccountCache => ({
  v: 1,
  profile: ada,
  deviceAccount: adaDevice,
  notice: null,
  passwordPending: false,
  ...over,
});

describe("initialSession", () => {
  it("is unconfigured in a build with no backend, whatever is stored", () => {
    const s = initialSession({ configured: false, hasToken: true, cache: cacheOf() });
    expect(s.phase).toBe("unconfigured");
    expect(s.profile).toBeNull();
    // Projects already on the device stay visible.
    expect(s.deviceAccount).toEqual(adaDevice);
  });

  it("a stored token plus a cached profile starts ready, from the cache, with no network", () => {
    const s = initialSession({ configured: true, hasToken: true, cache: cacheOf() });
    expect(s).toEqual(readyCached);
  });

  it("no token and no cache starts anon", () => {
    expect(initialSession({ configured: true, hasToken: false, cache: null })).toEqual(anon);
  });

  it("a token with no cache starts loading until the client reports", () => {
    expect(initialSession({ configured: true, hasToken: true, cache: null }).phase).toBe("loading");
  });

  it("a cached account with no token is an involuntary sign-out: account kept, notice shown", () => {
    const s = initialSession({ configured: true, hasToken: false, cache: cacheOf() });
    expect(s).toEqual({ ...anon, deviceAccount: adaDevice, notice: "expired" });
  });

  it("keeps the stored notice across a restart", () => {
    const s = initialSession({ configured: true, hasToken: false, cache: cacheOf({ profile: null, notice: "suspended" }) });
    expect([s.phase, s.notice, s.deviceAccount]).toEqual(["anon", "suspended", adaDevice]);
  });

  it("restores a pending password check only together with a session", () => {
    expect(initialSession({ configured: true, hasToken: true, cache: cacheOf({ passwordPending: true }) }).passwordPending).toBe(true);
    expect(initialSession({ configured: true, hasToken: false, cache: cacheOf({ passwordPending: true }) }).passwordPending).toBe(false);
  });
});

describe("nextSession: signing in", () => {
  it("a new sign-in becomes ready at once with a provisional profile, then loads the real one", () => {
    const { next, effects } = nextSession(anon, { type: "signed-in", user: adaUser });
    expect(next.phase).toBe("ready");
    expect(next.profile).toEqual(provisionalProfile(adaUser));
    expect(next.profileSource).toBe("cache"); // not confirmed by the backend yet
    expect(next.deviceAccount).toEqual(adaDevice);
    expect(effects).toEqual([
      { type: "reset-identity" },
      { type: "seed-identity", name: "Ada Lovelace", mode: "replace", email: ada.email },
      { type: "load-profile", userId: ada.id },
    ]);
  });

  it("the provisional profile never carries more than the researcher role", () => {
    expect(provisionalProfile(adaUser).role).toBe("researcher");
    expect(provisionalProfile(adaUser).status).toBe("active");
  });

  it("seeds the identity with the email when the session has no name", () => {
    const { effects } = nextSession(anon, { type: "signed-in", user: bobUser });
    expect(effects).toContainEqual({ type: "seed-identity", name: bobUser.email, mode: "replace", email: bobUser.email });
  });

  it("the same person signing back in keeps the device identity (no reset)", () => {
    const expired: SessionData = { ...anon, deviceAccount: adaDevice, notice: "expired" };
    const { next, effects } = nextSession(expired, { type: "signed-in", user: adaUser });
    expect(next.phase).toBe("ready");
    expect(next.notice).toBeNull();
    expect(effects.map((e) => e.type)).toEqual(["seed-identity", "load-profile"]);
  });

  it("the same user again while ready only re-checks the profile (token refresh)", () => {
    const { next, effects } = nextSession(readyServer, { type: "signed-in", user: adaUser });
    expect(next).toBe(readyServer);
    expect(effects).toEqual([{ type: "load-profile", userId: ada.id }]);
  });

  it("an account switch replaces the device account and resets the identity", () => {
    const { next, effects } = nextSession(readyServer, { type: "signed-in", user: bobUser });
    expect(next.profile?.id).toBe(bobUser.id);
    expect(next.deviceAccount?.id).toBe(bobUser.id);
    expect(next.profileSource).toBe("cache");
    expect(effects[0]).toEqual({ type: "reset-identity" });
  });

  it("a different account signing in after an involuntary sign-out also resets the identity", () => {
    const expired: SessionData = { ...anon, deviceAccount: adaDevice, notice: "expired" };
    const { next, effects } = nextSession(expired, { type: "signed-in", user: bobUser });
    expect(next.deviceAccount?.id).toBe(bobUser.id);
    expect(effects[0]).toEqual({ type: "reset-identity" });
  });

  it("a session that came from an emailed code owes a password from the moment it is adopted", () => {
    // A new sign-in: the same state write that makes the person ready says so.
    const fresh = nextSession(anon, { type: "signed-in", user: adaUser, owesPassword: true }).next;
    expect(fresh).toMatchObject({ phase: "ready", passwordPending: true });
    // Without the mark nothing is owed, as for a password sign-in.
    expect(nextSession(anon, { type: "signed-in", user: adaUser }).next.passwordPending).toBe(false);
    expect(nextSession(anon, { type: "signed-in", user: adaUser, owesPassword: false }).next.passwordPending).toBe(false);
  });

  it("the mark also reaches someone the client's own event already made ready", () => {
    const marked = nextSession(readyServer, { type: "signed-in", user: adaUser, owesPassword: true });
    expect(marked.next).toEqual({ ...readyServer, passwordPending: true });
    expect(marked.effects).toEqual([{ type: "load-profile", userId: ada.id }]);
    // A later event without the mark never takes it back.
    expect(nextSession(marked.next, { type: "signed-in", user: adaUser }).next.passwordPending).toBe(true);
    expect(nextSession(marked.next, { type: "signed-in", user: adaUser, owesPassword: false }).next.passwordPending).toBe(true);
  });

  it("a pending password check does not survive a change of account", () => {
    const pending: SessionData = { ...readyServer, passwordPending: true };
    expect(nextSession(pending, { type: "signed-in", user: bobUser }).next.passwordPending).toBe(false);
    // The same account refreshing its token keeps it.
    expect(nextSession(pending, { type: "signed-in", user: adaUser }).next.passwordPending).toBe(true);
  });
});

describe("nextSession: the client reports no session at start-up", () => {
  it("stays ready: offline with an expired token is not a sign-out", () => {
    const { next, effects } = nextSession(readyCached, { type: "initial-none" });
    expect(next).toBe(readyCached);
    expect(effects).toEqual([]);
  });

  it("resolves loading to anon", () => {
    const loading: SessionData = { ...anon, phase: "loading" };
    expect(nextSession(loading, { type: "initial-none" }).next.phase).toBe("anon");
  });

  it("changes nothing when already anon", () => {
    expect(nextSession(anon, { type: "initial-none" }).next).toBe(anon);
  });
});

describe("nextSession: signing out", () => {
  it("involuntary: keeps the device account and sets the notice", () => {
    const { next, effects } = nextSession(readyServer, { type: "signed-out", voluntary: false });
    expect(next).toEqual({ ...anon, deviceAccount: adaDevice, notice: "expired" });
    expect(effects).toEqual([]);
  });

  it("involuntary: uses the notice another window recorded", () => {
    const { next } = nextSession(readyServer, { type: "signed-out", voluntary: false, notice: "suspended" });
    expect(next.notice).toBe("suspended");
  });

  it("involuntary: leaves an existing notice alone once anon", () => {
    const suspended: SessionData = { ...anon, deviceAccount: adaDevice, notice: "suspended" };
    expect(nextSession(suspended, { type: "signed-out", voluntary: false }).next).toBe(suspended);
  });

  it("voluntary: clears the profile, the device account and the notice, and resets the identity", () => {
    const { next, effects } = nextSession(readyServer, { type: "signed-out", voluntary: true });
    expect(next).toEqual(anon);
    expect(effects).toEqual([{ type: "reset-identity" }]);
  });

  it("voluntary after an involuntary sign-out still clears the device account", () => {
    const expired: SessionData = { ...anon, deviceAccount: adaDevice, notice: "expired" };
    const { next, effects } = nextSession(expired, { type: "signed-out", voluntary: true });
    expect(next).toEqual(anon);
    expect(effects).toEqual([{ type: "reset-identity" }]);
  });

  it("a stray sign-out event never touches a guest's identity", () => {
    const { next, effects } = nextSession(anon, { type: "signed-out", voluntary: true });
    expect(next).toBe(anon);
    expect(effects).toEqual([]);
  });
});

describe("nextSession: the profile", () => {
  it("an active profile from the backend is stored as server-confirmed", () => {
    const fresh: Profile = { ...ada, name: "Ada King", role: "admin" };
    const { next, effects } = nextSession(readyCached, { type: "profile-loaded", profile: fresh });
    expect(next.profile).toEqual(fresh);
    expect(next.profileSource).toBe("server");
    expect(next.deviceAccount).toEqual({ id: ada.id, email: ada.email, name: "Ada King" });
    // First confirmation this launch: fill the identity only if it is blank.
    expect(effects).toEqual([{ type: "seed-identity", name: "Ada King", mode: "fill", email: ada.email }]);
  });

  it("a later refresh does not touch the identity again", () => {
    expect(nextSession(readyServer, { type: "profile-loaded", profile: ada }).effects).toEqual([]);
  });

  it("a suspended profile signs out locally with the suspended notice and keeps the device account", () => {
    const { next, effects } = nextSession(readyServer, { type: "profile-loaded", profile: { ...ada, status: "suspended" } });
    expect(next).toEqual({ ...anon, deviceAccount: adaDevice, notice: "suspended" });
    expect(effects).toEqual([{ type: "local-sign-out" }]);
  });

  it("a deleted profile, or no profile row at all, signs out locally as removed", () => {
    const deleted = nextSession(readyServer, { type: "profile-loaded", profile: { ...ada, status: "deleted" } });
    expect(deleted.next.notice).toBe("removed");
    expect(deleted.effects).toEqual([{ type: "local-sign-out" }]);

    const missing = nextSession(readyServer, { type: "profile-missing", userId: ada.id });
    expect(missing.next).toEqual({ ...anon, deviceAccount: adaDevice, notice: "removed" });
    expect(missing.effects).toEqual([{ type: "local-sign-out" }]);
  });

  it("a failed read (offline) keeps the cached profile", () => {
    const { next, effects } = nextSession(readyCached, { type: "profile-failed", userId: ada.id });
    expect(next).toBe(readyCached);
    expect(effects).toEqual([]);
  });

  it("ignores a result for someone who is no longer the signed-in user", () => {
    const other: Profile = { ...ada, id: "user-bob", status: "suspended" };
    expect(nextSession(readyServer, { type: "profile-loaded", profile: other }).next).toBe(readyServer);
    expect(nextSession(readyServer, { type: "profile-missing", userId: "user-bob" }).next).toBe(readyServer);
    expect(nextSession(anon, { type: "profile-loaded", profile: ada }).next).toBe(anon);
  });
});

describe("nextSession: small actions", () => {
  it("forgetting the device account clears it and the notice, only while signed out", () => {
    const expired: SessionData = { ...anon, deviceAccount: adaDevice, notice: "expired" };
    const { next, effects } = nextSession(expired, { type: "forget-device-account" });
    expect(next).toEqual(anon);
    expect(effects).toEqual([{ type: "reset-identity" }]);
    expect(nextSession(readyServer, { type: "forget-device-account" }).next).toBe(readyServer);
  });

  it("dismissing the notice keeps the device account", () => {
    const expired: SessionData = { ...anon, deviceAccount: adaDevice, notice: "expired" };
    expect(nextSession(expired, { type: "dismiss-notice" }).next).toEqual({ ...expired, notice: null });
  });

  it("the pending password flag is set and cleared only while ready", () => {
    const set = nextSession(readyServer, { type: "password-pending", pending: true }).next;
    expect(set.passwordPending).toBe(true);
    expect(nextSession(set, { type: "password-pending", pending: false }).next.passwordPending).toBe(false);
    expect(nextSession(anon, { type: "password-pending", pending: true }).next).toBe(anon);
  });

  it("any way out of ready clears the pending password flag", () => {
    const pending: SessionData = { ...readyServer, passwordPending: true };
    expect(nextSession(pending, { type: "signed-out", voluntary: false }).next.passwordPending).toBe(false);
    expect(nextSession(pending, { type: "signed-out", voluntary: true }).next.passwordPending).toBe(false);
    expect(nextSession(pending, { type: "profile-missing", userId: ada.id }).next.passwordPending).toBe(false);
  });

  it("an unconfigured build ignores every signal", () => {
    const off: SessionData = { ...anon, phase: "unconfigured" };
    expect(nextSession(off, { type: "signed-in", user: adaUser })).toEqual({ next: off, effects: [] });
    expect(nextSession(off, { type: "signed-out", voluntary: true }).next).toBe(off);
  });
});

describe("authEventKind", () => {
  it("every event that carries a session counts as signed in, PASSWORD_RECOVERY included", () => {
    for (const event of ["SIGNED_IN", "PASSWORD_RECOVERY", "TOKEN_REFRESHED", "USER_UPDATED", "INITIAL_SESSION"]) {
      expect(authEventKind(event, true)).toBe("signed-in");
    }
  });

  it("INITIAL_SESSION with no session is its own case, and SIGNED_OUT always wins", () => {
    expect(authEventKind("INITIAL_SESSION", false)).toBe("initial-none");
    expect(authEventKind("SIGNED_OUT", false)).toBe("signed-out");
    expect(authEventKind("SIGNED_OUT", true)).toBe("signed-out");
    expect(authEventKind("TOKEN_REFRESHED", false)).toBeNull();
  });
});

describe("sessionUserFrom", () => {
  it("takes id, email, the sign-up name and the creation time, and nothing else", () => {
    const session = {
      access_token: "never-read",
      user: { id: "u1", email: "a@example.test", created_at: "2026-01-02T03:04:05.000Z", user_metadata: { name: "  Ada  ", role: "master_admin" } },
    };
    expect(sessionUserFrom(session)).toEqual({ id: "u1", email: "a@example.test", name: "Ada", createdAt: Date.parse("2026-01-02T03:04:05.000Z") });
  });

  it("is null without a usable user, and tolerates missing fields", () => {
    expect(sessionUserFrom(null)).toBeNull();
    expect(sessionUserFrom({ user: { id: "" } })).toBeNull();
    expect(sessionUserFrom({ user: { id: "u1" } })).toEqual({ id: "u1", email: "", name: "", createdAt: 0 });
  });
});

describe("profileFromRow", () => {
  const row = {
    id: "u1",
    email: "a@example.test",
    name: "Ada",
    institution: "",
    role: "supervisor",
    status: "active",
    must_set_password: false,
    created_at: "2026-01-02T03:04:05+00:00",
  };

  it("maps a profiles row, turning the timestamp into milliseconds", () => {
    expect(profileFromRow(row)).toEqual({
      id: "u1",
      email: "a@example.test",
      name: "Ada",
      institution: "",
      role: "supervisor",
      status: "active",
      mustSetPassword: false,
      createdAt: Date.parse("2026-01-02T03:04:05+00:00"),
    });
  });

  it("reads the invited-and-no-password flag, and a deleted account's null email", () => {
    expect(profileFromRow({ ...row, must_set_password: true })?.mustSetPassword).toBe(true);
    expect(profileFromRow({ ...row, email: null, status: "deleted" })?.email).toBe("");
  });

  it("refuses a row with an unknown role or status rather than guessing", () => {
    expect(profileFromRow({ ...row, role: "root" })).toBeNull();
    expect(profileFromRow({ ...row, status: "banned" })).toBeNull();
    expect(profileFromRow({ ...row, id: "" })).toBeNull();
    expect(profileFromRow(null)).toBeNull();
    expect(profileFromRow("nope")).toBeNull();
  });
});

describe("the device record", () => {
  it("round-trips through accountCacheOf and parseAccountCache", () => {
    const record = accountCacheOf({ ...readyServer, passwordPending: true });
    expect(record).toEqual(cacheOf({ passwordPending: true }));
    expect(parseAccountCache(JSON.stringify(record))).toEqual(record);
  });

  it("has nothing to keep for a plain guest", () => {
    expect(accountCacheOf(anon)).toBeNull();
  });

  it("keeps the device account and notice after an involuntary sign-out", () => {
    const expired: SessionData = { ...anon, deviceAccount: adaDevice, notice: "expired" };
    expect(accountCacheOf(expired)).toEqual({ v: 1, profile: null, deviceAccount: adaDevice, notice: "expired", passwordPending: false });
  });

  it("never contains a token", () => {
    expect(JSON.stringify(accountCacheOf(readyServer))).not.toMatch(/token/i);
  });

  it("treats anything malformed as absent", () => {
    expect(parseAccountCache(null)).toBeNull();
    expect(parseAccountCache("")).toBeNull();
    expect(parseAccountCache("{not json")).toBeNull();
    expect(parseAccountCache(JSON.stringify({ v: 2, profile: ada }))).toBeNull();
    expect(parseAccountCache(JSON.stringify({ v: 1, profile: { ...ada, role: "root" } }))).toBeNull();
    expect(parseAccountCache(JSON.stringify({ v: 1, profile: null, deviceAccount: null, notice: null }))).toBeNull();
  });

  it("drops an unknown notice but keeps the rest", () => {
    const parsed = parseAccountCache(JSON.stringify({ v: 1, profile: ada, deviceAccount: adaDevice, notice: "weird" }));
    expect(parsed?.notice).toBeNull();
    expect(parsed?.profile).toEqual(ada);
  });
});
