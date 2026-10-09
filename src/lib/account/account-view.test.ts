import { describe, expect, it } from "vitest";
import type { Link } from "@/lib/collab/links";
import { SyncError } from "@/lib/supabase/errors";
import {
  CHIP_LABEL,
  adoptableIds,
  adoptionMessage,
  deleteCopy,
  stopsAdoption,
  deletionNotice,
  describeDeleteError,
  describeProfileError,
  detachedMessage,
  displayName,
  divergedMessage,
  initialOf,
  notLeftMessage,
  outcomeMessage,
  profileChanges,
  profileFields,
  projectChip,
  shouldShowPromo,
  signedOutAccount,
  signedOutMessage,
  syncLine,
  syncedAgo,
} from "./account-view";

const ADA = { id: "user-ada", email: "ada@example.test", name: "Ada" };
const account = (role: "owner" | "editor" | "viewer" | "supervisor"): Link => ({
  kind: "account",
  owner: ADA.id,
  serverId: "proj_x",
  rev: 1,
  created: true,
  role,
});

describe("where a project lives", () => {
  it("is on this device only without an account link", () => {
    expect(projectChip(null)).toBe("device");
    expect(projectChip(undefined)).toBe("device");
    expect(projectChip({ kind: "device", asked: false })).toBe("device");
    expect(projectChip({ kind: "device", asked: true })).toBe("device");
  });

  it("is the person's own when they own it, and shared with them otherwise", () => {
    expect(projectChip(account("owner"))).toBe("account");
    expect(projectChip(account("editor"))).toBe("shared");
    expect(projectChip(account("viewer"))).toBe("shared");
    expect(projectChip(account("supervisor"))).toBe("shared");
  });

  it("is not said to be in the account before its content has been uploaded there", () => {
    const base = { kind: "account", owner: ADA.id, serverId: "proj_x", role: "owner" } as const;
    // The create request has not been answered yet.
    expect(projectChip({ ...base, rev: 0, created: false })).toBe("waiting");
    // Created, and the first upload has not succeeded.
    expect(projectChip({ ...base, rev: 0, created: true })).toBe("waiting");
    // Uploaded once.
    expect(projectChip({ ...base, rev: 1, created: true, synced: "x" })).toBe("account");
    // Downloaded from the account with nothing in it yet: that is all the account has.
    expect(projectChip({ ...base, rev: 0, created: true, synced: "x", role: "editor" })).toBe("shared");
  });

  it("uses the agreed labels", () => {
    expect(CHIP_LABEL).toEqual({
      device: "This device only",
      waiting: "Not uploaded yet",
      account: "In your account",
      shared: "Shared with you",
    });
  });
});

describe("work done before signing in", () => {
  it("asks only about projects pinned to the device that have not been answered for", () => {
    const links: Record<string, Link> = {
      asked: { kind: "device", asked: true },
      waiting: { kind: "device", asked: false },
      mine: account("owner"),
    };
    const linkOf = (id: string) => links[id] ?? null;
    expect(adoptableIds(["asked", "waiting", "mine", "no-record"], linkOf)).toEqual(["waiting"]);
    expect(adoptableIds([], linkOf)).toEqual([]);
  });

  it("goes on to the next project when one cannot be added for a reason of its own, and stops when none could be", () => {
    // About that one project.
    for (const code of ["too_large", "conflict", "not_found", "server_error"]) expect(stopsAdoption(new SyncError(400, code))).toBe(false);
    // The same for all of them.
    for (const code of ["network", "offline", "unauthenticated", "account_suspended", "password_reset_required", "rate_limited", "not_configured"]) {
      expect(stopsAdoption(new SyncError(0, code))).toBe(true);
    }
    expect(stopsAdoption(new Error("the device's storage is not available"))).toBe(true);
  });

  it("counts them in a sentence", () => {
    expect(adoptionMessage(1)).toBe("1 project on this device isn't in your account yet.");
    expect(adoptionMessage(3)).toBe("3 projects on this device aren't in your account yet.");
  });
});

describe("banners", () => {
  it("invites only a guest who has no account on the device and has not said no", () => {
    expect(shouldShowPromo({ phase: "anon", deviceAccount: null, dismissed: false })).toBe(true);
    expect(shouldShowPromo({ phase: "anon", deviceAccount: null, dismissed: true })).toBe(false);
    expect(shouldShowPromo({ phase: "anon", deviceAccount: ADA, dismissed: false })).toBe(false);
    expect(shouldShowPromo({ phase: "ready", deviceAccount: ADA, dismissed: false })).toBe(false);
    expect(shouldShowPromo({ phase: "loading", deviceAccount: null, dismissed: false })).toBe(false);
    // A build with no backend never shows it.
    expect(shouldShowPromo({ phase: "unconfigured", deviceAccount: null, dismissed: false })).toBe(false);
  });

  it("knows an account that was signed out without asking", () => {
    expect(signedOutAccount({ phase: "anon", deviceAccount: ADA })).toEqual(ADA);
    expect(signedOutAccount({ phase: "anon", deviceAccount: null })).toBeNull();
    expect(signedOutAccount({ phase: "ready", deviceAccount: ADA })).toBeNull();
    expect(signedOutAccount({ phase: "loading", deviceAccount: ADA })).toBeNull();
    // A build with no backend keeps showing the projects but says nothing.
    expect(signedOutAccount({ phase: "unconfigured", deviceAccount: ADA })).toBeNull();
  });

  it("explains each way a session can end", () => {
    expect(signedOutMessage("expired", ADA.email)).toBe(
      "You've been signed out of ada@example.test. Your projects are still on this device but won't sync until you sign in again.",
    );
    expect(signedOutMessage(null, ADA.email)).toBe(signedOutMessage("expired", ADA.email));
    expect(signedOutMessage("suspended", ADA.email)).toMatch(/^ada@example\.test has been suspended.*Contact an administrator\.$/);
    expect(signedOutMessage("removed", ADA.email)).toMatch(/^The account ada@example\.test no longer exists/);
    expect(signedOutMessage("expired", "")).toMatch(/signed out of your account\./);
  });

  it("names a single project that was kept as a copy, and counts several", () => {
    expect(detachedMessage(["Sleep study"])).toBe("Sleep study is no longer in your account. It was kept here as a copy on this device only.");
    expect(detachedMessage(["  "])).toMatch(/^A project is no longer/);
    expect(detachedMessage(["A", "B"])).toBe("2 projects are no longer in your account. They were kept here as copies on this device only.");
  });

  it("says that a version which never reached the account was kept apart from the account's", () => {
    expect(divergedMessage(["Sleep study"])).toBe(
      "Sleep study was changed in your account before this device had uploaded its own version. Your version was kept here as a separate copy on this device only, and the account's version was downloaded beside it.",
    );
    expect(divergedMessage([" "])).toMatch(/^A project was changed/);
    expect(divergedMessage(["A", "B"])).toMatch(/^2 projects were changed in your account/);
  });

  it("says why a project the person asked to leave is back", () => {
    expect(notLeftMessage(["Sleep study"])).toBe(
      "You are now the only owner of Sleep study, so you could not leave it. It is on this device again. Make someone else an owner first, or delete it for everyone.",
    );
    expect(notLeftMessage(["A", "B"])).toMatch(/^You are now the only owner of 2 projects/);
  });

  it("uses no long dash in any of these sentences", () => {
    for (const text of [detachedMessage(["A"]), divergedMessage(["A"]), divergedMessage(["A", "B"]), notLeftMessage(["A"]), notLeftMessage(["A", "B"])]) {
      expect(text).not.toMatch(/\u2014/);
    }
  });
});

describe("a deletion that was not carried out", () => {
  it("says why, and that nothing was removed", () => {
    expect(describeDeleteError(new SyncError(409, "last_owner"))).toBe(
      "You are the only owner of this project now, so you can't leave it. Make someone else an owner first, or delete it for everyone.",
    );
    expect(describeDeleteError(new SyncError(409, "conflict"))).toMatch(/added to your account in the meantime/);
    expect(describeDeleteError(new Error("the device's storage is not available"))).toBe("The project could not be removed from this device. Try again.");
  });
});

describe("deleting", () => {
  it("a device-only project is simply deleted", () => {
    const copy = deleteCopy("device", false);
    expect(copy.heading).toBe("Delete project?");
    expect(copy.confirmLabel).toBe("Delete");
    expect(copy.rest).toMatch(/permanently removed from this device/);
    expect(copy.later).toBeNull();
  });

  it("an owner is told it goes for everyone", () => {
    const copy = deleteCopy("everyone", true);
    expect(copy.heading).toBe("Delete project for everyone?");
    expect(copy.confirmLabel).toBe("Delete for everyone");
    expect(copy.rest).toMatch(/everyone it is shared with/);
    expect(copy.later).toBeNull();
  });

  it("a member is told they leave and the others keep it", () => {
    const copy = deleteCopy("leave", true);
    expect(copy.heading).toBe("Leave project?");
    expect(copy.confirmLabel).toBe("Leave project");
    expect(copy.rest).toMatch(/other members keep it/);
  });

  it("says so when the account can only be told later", () => {
    expect(deleteCopy("everyone", false).later).toMatch(/next time you sync here/);
    expect(deleteCopy("leave", false).later).toMatch(/next time you sync here/);
  });

  it("reports what happened", () => {
    expect(deletionNotice("device", "local")).toEqual({ kind: "success", text: "Project deleted." });
    expect(deletionNotice("everyone", "deleted")).toEqual({ kind: "success", text: "Project deleted from your account." });
    expect(deletionNotice("leave", "deleted")).toEqual({ kind: "success", text: "You left the project." });
    expect(deletionNotice("leave", "left")).toEqual({ kind: "success", text: "You left the project." });
    // Asked about deleting for everyone, and no longer an owner by then: it says what was done.
    expect(deletionNotice("everyone", "left")).toEqual({ kind: "success", text: "You left the project." });
    expect(deletionNotice("everyone", "queued").kind).toBe("info");
    expect(deletionNotice("leave", "queued").text).toMatch(/next time you sync here/);
  });
});

describe("the sync line", () => {
  const NOW = 10_000_000_000;
  const idle = { state: "idle" as const, lastSyncedAt: NOW - 5_000, errorCode: null };

  it("says how long ago the device and the account agreed", () => {
    expect(syncedAgo(NOW, NOW)).toBe("Synced just now");
    expect(syncedAgo(NOW + 5_000, NOW)).toBe("Synced just now");
    expect(syncedAgo(NOW - 59_999, NOW)).toBe("Synced just now");
    expect(syncedAgo(NOW - 60_000, NOW)).toBe("Synced 1 minute ago");
    expect(syncedAgo(NOW - 59 * 60_000, NOW)).toBe("Synced 59 minutes ago");
    expect(syncedAgo(NOW - 60 * 60_000, NOW)).toBe("Synced 1 hour ago");
    expect(syncedAgo(NOW - 23 * 3_600_000, NOW)).toBe("Synced 23 hours ago");
    expect(syncedAgo(NOW - 24 * 3_600_000, NOW)).toBe("Synced 1 day ago");
    expect(syncedAgo(NOW - 3 * 24 * 3_600_000, NOW)).toBe("Synced 3 days ago");
  });

  it("says so when a project is too large for the account", () => {
    expect(syncLine({ ...idle, state: "error", errorCode: "too_large" }, NOW)).toEqual({
      tone: "error",
      text: "Sync didn't finish. This project is larger than an account can hold (20 MB), so it was not uploaded. It is still saved on this device.",
    });
  });

  it("covers every state, each with its own tone", () => {
    expect(syncLine(idle, NOW)).toEqual({ tone: "synced", text: "Synced just now" });
    expect(syncLine({ ...idle, lastSyncedAt: null }, NOW)).toEqual({ tone: "waiting", text: "Not synced yet" });
    expect(syncLine({ ...idle, state: "syncing" }, NOW)).toEqual({ tone: "syncing", text: "Syncing…" });
    expect(syncLine({ ...idle, state: "offline" }, NOW)).toEqual({ tone: "offline", text: "Offline. Changes will sync later." });
  });

  it("explains a failed sync", () => {
    expect(syncLine({ ...idle, state: "error", errorCode: "rate_limited" }, NOW)).toEqual({
      tone: "error",
      text: "Sync didn't finish. Too many attempts. Wait a few minutes and try again.",
    });
    expect(syncLine({ ...idle, state: "error", errorCode: null }, NOW).text).toBe(
      "Sync didn't finish. Something went wrong on our side. Try again in a moment.",
    );
    expect(syncLine({ ...idle, state: "error", errorCode: "storage_error" }, NOW)).toEqual({
      tone: "error",
      text: "Scholea couldn't read the projects saved on this device. Sync is paused.",
    });
  });

  it("an owed password comes before anything else", () => {
    expect(syncLine({ ...idle, state: "error", errorCode: "password_reset_required" }, NOW, true)).toEqual({
      tone: "waiting",
      text: "Sync starts once you choose a password.",
    });
  });
});

describe("small things", () => {
  it("picks the avatar letter from the name, then the address", () => {
    expect(initialOf("ada lovelace", "x@example.test")).toBe("A");
    expect(initialOf("  ", "grace@example.test")).toBe("G");
    expect(initialOf("", "")).toBe("?");
    expect(initialOf("émile", "")).toBe("É");
  });

  it("greets by name, or by address when there is no name", () => {
    expect(displayName(ADA)).toBe("Ada");
    expect(displayName({ name: " ", email: ADA.email })).toBe(ADA.email);
  });

  it("words the end of each flow", () => {
    expect(outcomeMessage("signedIn", ADA)).toBe("Signed in as Ada.");
    expect(outcomeMessage("signedIn", { name: "", email: ADA.email })).toBe("Signed in as ada@example.test.");
    expect(outcomeMessage("signedIn", null)).toBe("Signed in.");
    // The name on the account is said every time: after a code it may be one somebody else chose.
    expect(outcomeMessage("accountCreated", ADA)).toBe("Account created. You're signed in as Ada.");
    expect(outcomeMessage("passwordChanged", ADA)).toBe("Password updated. You're signed in as Ada.");
    expect(outcomeMessage("passwordChanged", { name: " ", email: ADA.email })).toBe("Password updated. You're signed in as ada@example.test.");
    expect(outcomeMessage("accountCreated", null)).toBe("Account created. You're signed in.");
    expect(outcomeMessage("passwordChanged", null)).toBe("Password updated. You're signed in.");
  });
});

describe("the person's own profile", () => {
  it("needs a name, and both fields have to fit", () => {
    expect(profileFields({ name: "Ada Lovelace", institution: "" })).toEqual({});
    expect(profileFields({ name: "  ", institution: "" })).toEqual({ name: "Enter your name." });
    expect(profileFields({ name: "x".repeat(201), institution: "y".repeat(201) })).toEqual({
      name: "Use 200 characters or fewer.",
      institution: "Use 200 characters or fewer.",
    });
    // Counted in whole characters, as the account counts them.
    expect(profileFields({ name: "\u{1F600}".repeat(200), institution: "y".repeat(200) })).toEqual({});
  });

  it("sends only what changed, tidied", () => {
    const before = { name: "Prof. X", institution: "Somewhere" };
    expect(profileChanges(before, { name: " Ada Lovelace ", institution: "Somewhere" })).toEqual({ name: "Ada Lovelace" });
    expect(profileChanges(before, { name: "Prof. X", institution: " " })).toEqual({ institution: "" });
    expect(profileChanges(before, { name: " Prof. X", institution: "Somewhere " })).toEqual({});
  });

  it("says why a profile could not be saved", () => {
    expect(describeProfileError(new SyncError(400, "invalid_input"))).toMatch(/Check the name and institution/);
    expect(describeProfileError(new SyncError(429, "rate_limited"))).toMatch(/many times in the last hour/);
    expect(describeProfileError(new SyncError(0, "offline"))).toBe("You're offline. Connect to the internet and try again.");
  });
});
