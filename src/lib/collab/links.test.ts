import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  SERVER_PROJECT_ID,
  TOMBSTONES_KEY,
  awaitsFirstUpload,
  getLink,
  isServerProjectId,
  isVisible,
  listLinks,
  newServerProjectId,
  pinUnlinked,
  purgeLegacyKeys,
  removeLink,
  selectSyncable,
  setLink,
  subscribeLinks,
  unlinkedIds,
  useLink,
  uuidV4,
  type AccountLink,
  type Link,
  type RandomSource,
} from "./links";

const ADA = "user-ada";
const BOB = "user-bob";

const accountLink = (over: Partial<AccountLink> = {}): AccountLink => ({
  kind: "account",
  owner: ADA,
  serverId: "proj_11111111-2222-4333-8444-555555555555",
  rev: 3,
  created: true,
  role: "owner",
  ...over,
});

afterEach(() => localStorage.clear());

describe("link store", () => {
  it("has no link for a new project", () => {
    expect(getLink("p1")).toBeNull();
  });

  it("round-trips an account link under scholea.link.<localId>", () => {
    setLink("p1", accountLink());
    expect(getLink("p1")).toEqual(accountLink());
    expect(JSON.parse(localStorage.getItem("scholea.link.p1")!)).toEqual(accountLink());
  });

  it("keeps the content fingerprint when there is one, and writes none otherwise", () => {
    setLink("p1", accountLink({ synced: "1a.9zz" }));
    expect(getLink("p1")).toEqual(accountLink({ synced: "1a.9zz" }));
    setLink("p2", accountLink());
    expect(getLink("p2")).not.toHaveProperty("synced");
    expect(JSON.parse(localStorage.getItem("scholea.link.p2")!)).not.toHaveProperty("synced");
    // A fingerprint that is not text is ignored rather than trusted.
    localStorage.setItem("scholea.link.p3", JSON.stringify({ ...accountLink(), synced: 42 }));
    expect(getLink("p3")).toEqual(accountLink());
  });

  it("round-trips a device pin", () => {
    setLink("p1", { kind: "device", asked: false });
    expect(getLink("p1")).toEqual({ kind: "device", asked: false });
    setLink("p1", { kind: "device", asked: true });
    expect(getLink("p1")).toEqual({ kind: "device", asked: true });
  });

  it("keeps one record per project: an account link replaces a pin", () => {
    setLink("p1", { kind: "device", asked: true });
    setLink("p1", accountLink({ created: false, rev: 0 }));
    expect(getLink("p1")).toEqual(accountLink({ created: false, rev: 0 }));
    expect(listLinks().size).toBe(1);
  });

  it("removes a link", () => {
    setLink("p1", accountLink());
    removeLink("p1");
    expect(getLink("p1")).toBeNull();
    expect(localStorage.getItem("scholea.link.p1")).toBeNull();
  });

  it("returns the same object for an unchanged record (a stable snapshot)", () => {
    setLink("p1", accountLink());
    expect(getLink("p1")).toBe(getLink("p1"));
  });

  it("notices a change made straight to storage (another window)", () => {
    setLink("p1", accountLink({ rev: 1 }));
    expect(getLink("p1")).toMatchObject({ rev: 1 });
    localStorage.setItem("scholea.link.p1", JSON.stringify(accountLink({ rev: 9 })));
    expect(getLink("p1")).toMatchObject({ rev: 9 });
    localStorage.removeItem("scholea.link.p1");
    expect(getLink("p1")).toBeNull();
  });

  it("treats an unreadable or incomplete record as no link", () => {
    const bad = [
      "{not json",
      "null",
      JSON.stringify({ kind: "account", owner: ADA }),
      JSON.stringify({ ...accountLink(), owner: "" }),
      JSON.stringify({ ...accountLink(), role: "god" }),
      JSON.stringify({ ...accountLink(), rev: "3" }),
      JSON.stringify({ ...accountLink(), kind: "cloud" }),
      // The old stores' shape must not be mistaken for a link.
      JSON.stringify({ serverId: "abc", rev: 2 }),
    ];
    for (const raw of bad) {
      localStorage.setItem("scholea.link.p1", raw);
      expect(getLink("p1")).toBeNull();
    }
  });

  it("writes only the known fields", () => {
    setLink("p1", { ...accountLink(), extra: "x" } as unknown as Link);
    expect(Object.keys(JSON.parse(localStorage.getItem("scholea.link.p1")!)).sort()).toEqual([
      "created",
      "kind",
      "owner",
      "rev",
      "role",
      "serverId",
    ]);
  });

  it("lists every link and skips the reserved tombstone key and other keys", () => {
    setLink("p1", accountLink());
    setLink("p2", { kind: "device", asked: false });
    // Even if the reserved key ever held something link-shaped, it is not a project.
    localStorage.setItem(TOMBSTONES_KEY, JSON.stringify({ kind: "device", asked: false }));
    localStorage.setItem("scholea.activeProject", "p1");
    const links = listLinks();
    expect([...links.keys()].sort()).toEqual(["p1", "p2"]);
    expect(links.get("p2")).toEqual({ kind: "device", asked: false });
  });

  it("tells subscribers about every change, until they unsubscribe", () => {
    let seen = 0;
    const unsubscribe = subscribeLinks(() => void (seen += 1));
    setLink("p1", accountLink());
    removeLink("p1");
    expect(seen).toBe(2);
    unsubscribe();
    setLink("p1", accountLink());
    expect(seen).toBe(2);
  });

  it("tells subscribers when another window changes a link", () => {
    let seen = 0;
    const unsubscribe = subscribeLinks(() => void (seen += 1));
    window.dispatchEvent(new StorageEvent("storage", { key: "scholea.link.p1" }));
    window.dispatchEvent(new StorageEvent("storage", { key: "scholea.theme" }));
    expect(seen).toBe(1);
    unsubscribe();
  });
});

describe("useLink", () => {
  it("re-renders with the link as it changes", () => {
    const { result } = renderHook(() => useLink("p1"));
    expect(result.current).toBeNull();

    act(() => setLink("p1", { kind: "device", asked: false }));
    expect(result.current).toEqual({ kind: "device", asked: false });

    act(() => setLink("p1", accountLink({ role: "viewer" })));
    expect(result.current).toEqual(accountLink({ role: "viewer" }));

    act(() => removeLink("p1"));
    expect(result.current).toBeNull();
  });

  it("follows the project it is given, and is null without one", () => {
    setLink("p1", accountLink({ rev: 1 }));
    setLink("p2", accountLink({ rev: 2 }));
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useLink(id), { initialProps: { id: "p1" as string | null } });
    expect(result.current).toMatchObject({ rev: 1 });
    rerender({ id: "p2" });
    expect(result.current).toMatchObject({ rev: 2 });
    rerender({ id: null });
    expect(result.current).toBeNull();
  });
});

describe("isVisible", () => {
  const cases: Array<[string, Link | null, string | null, boolean]> = [
    ["new project, signed out", null, null, true],
    ["new project, signed in", null, ADA, true],
    ["device pin, signed out", { kind: "device", asked: false }, null, true],
    ["device pin, signed in", { kind: "device", asked: true }, ADA, true],
    ["own account project", accountLink(), ADA, true],
    ["account project after sign-out", accountLink(), null, false],
    ["another account's project", accountLink(), BOB, false],
    ["shared project where I am a viewer", accountLink({ role: "viewer" }), ADA, true],
  ];
  it.each(cases)("%s", (_name, link, deviceAccountId, expected) => {
    expect(isVisible(link, deviceAccountId)).toBe(expected);
  });

  it("treats undefined like null on both sides", () => {
    expect(isVisible(undefined, undefined)).toBe(true);
    expect(isVisible(accountLink(), undefined)).toBe(false);
  });
});

describe("awaitsFirstUpload", () => {
  it("is true for a project made here until its content has reached the account once", () => {
    // The create request has not been answered.
    expect(awaitsFirstUpload(accountLink({ created: false, rev: 0 }))).toBe(true);
    // Created in the account, and the upload has not succeeded yet.
    expect(awaitsFirstUpload(accountLink({ created: true, rev: 0 }))).toBe(true);
    // Uploaded.
    expect(awaitsFirstUpload(accountLink({ created: true, rev: 1, synced: "x" }))).toBe(false);
  });

  it("is false for a project that was downloaded, even one nobody has uploaded anything to", () => {
    expect(awaitsFirstUpload(accountLink({ created: true, rev: 0, synced: "empty" }))).toBe(false);
    expect(awaitsFirstUpload(accountLink({ created: true, rev: 0, synced: "empty", role: "editor" }))).toBe(false);
    // Somebody else's project is never this person's to upload for the first time.
    expect(awaitsFirstUpload(accountLink({ created: true, rev: 0, role: "editor" }))).toBe(false);
    expect(awaitsFirstUpload(accountLink({ created: true, rev: 0, role: "viewer" }))).toBe(false);
  });

  it("is false for anything that is not in an account", () => {
    expect(awaitsFirstUpload(null)).toBe(false);
    expect(awaitsFirstUpload(undefined)).toBe(false);
    expect(awaitsFirstUpload({ kind: "device", asked: false })).toBe(false);
  });
});

describe("selectSyncable", () => {
  const projects = [{ id: "mine" }, { id: "fresh" }, { id: "pinned" }, { id: "kept" }, { id: "theirs" }];
  const links = new Map<string, Link>([
    ["mine", accountLink()],
    ["pinned", { kind: "device", asked: false }],
    ["kept", { kind: "device", asked: true }],
    ["theirs", accountLink({ owner: BOB })],
  ]);
  const ids = (list: Array<{ id: string }>) => list.map((p) => p.id);

  it("syncs the user's own projects and new ones, never pins or another account's", () => {
    const s = selectSyncable(projects, links, ADA);
    expect(ids(s.syncable)).toEqual(["mine", "fresh"]);
    expect(ids(s.deviceOnly)).toEqual(["pinned", "kept"]);
    expect(ids(s.otherAccount)).toEqual(["theirs"]);
  });

  it("a second account on the same device cannot reach the first account's projects", () => {
    const s = selectSyncable(projects, links, BOB);
    expect(ids(s.syncable)).toEqual(["fresh", "theirs"]);
    expect(ids(s.otherAccount)).toEqual(["mine"]);
  });

  it("selects nothing to sync when nobody is signed in", () => {
    const s = selectSyncable(projects, links, null);
    expect(s.syncable).toEqual([]);
    expect(ids(s.deviceOnly)).toEqual(["fresh", "pinned", "kept"]);
    expect(ids(s.otherAccount)).toEqual(["mine", "theirs"]);
  });

  it("puts every project in exactly one group", () => {
    for (const user of [ADA, BOB, null]) {
      const s = selectSyncable(projects, links, user);
      expect([...ids(s.syncable), ...ids(s.deviceOnly), ...ids(s.otherAccount)].sort()).toEqual(ids(projects).sort());
    }
  });
});

describe("pinning guest projects at sign-in", () => {
  it("unlinkedIds finds the projects with no record", () => {
    const links = new Map<string, Link>([["a", accountLink()]]);
    expect(unlinkedIds(["a", "b", "c"], links)).toEqual(["b", "c"]);
  });

  it("pins only projects with no record, as not yet asked, and reports them", () => {
    setLink("mine", accountLink());
    setLink("kept", { kind: "device", asked: true });
    expect(pinUnlinked(["mine", "kept", "guest1", "guest2"])).toEqual(["guest1", "guest2"]);
    expect(getLink("guest1")).toEqual({ kind: "device", asked: false });
    expect(getLink("guest2")).toEqual({ kind: "device", asked: false });
    // Existing answers are left alone.
    expect(getLink("mine")).toEqual(accountLink());
    expect(getLink("kept")).toEqual({ kind: "device", asked: true });
    // Pinned projects are no longer selected for upload.
    expect(selectSyncable([{ id: "guest1" }], listLinks(), ADA).syncable).toEqual([]);
  });

  it("pinning twice changes nothing the second time", () => {
    pinUnlinked(["g"]);
    setLink("g", { kind: "device", asked: true });
    expect(pinUnlinked(["g"])).toEqual([]);
    expect(getLink("g")).toEqual({ kind: "device", asked: true });
  });
});

describe("server project ids", () => {
  it("are proj_<uuid> in the shape the backend requires", () => {
    const id = newServerProjectId();
    expect(id).toMatch(/^proj_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(isServerProjectId(id)).toBe(true);
    expect(SERVER_PROJECT_ID.test(id)).toBe(true);
  });

  it("are different every time", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newServerProjectId()));
    expect(ids.size).toBe(50);
  });

  it("builds a version 4 UUID when randomUUID is missing (older webviews)", () => {
    // All bits set, so the version and variant bits are the only ones cleared.
    const ones: RandomSource = { getRandomValues: (a) => a.fill(0xff) };
    expect(uuidV4(ones)).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    const zeros: RandomSource = { getRandomValues: (a) => a.fill(0) };
    expect(uuidV4(zeros)).toBe("00000000-0000-4000-8000-000000000000");
    expect(isServerProjectId(`proj_${uuidV4(ones)}`)).toBe(true);
  });

  it("lowercases whatever the platform returns", () => {
    const upper: RandomSource = { getRandomValues: (a) => a, randomUUID: () => "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE" };
    expect(uuidV4(upper)).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  });

  it("rejects ids in the old local format or with the wrong prefix", () => {
    for (const bad of ["proj-cohort-12345", "11111111-2222-4333-8444-555555555555", "proj_XYZ", "PROJ_11111111-2222-4333-8444-555555555555", ""]) {
      expect(isServerProjectId(bad)).toBe(false);
    }
  });
});

describe("purgeLegacyKeys", () => {
  it("removes what the old server client left and nothing else", () => {
    localStorage.setItem("scholea.token", "old-session-id");
    localStorage.setItem("scholea.user", "{}");
    localStorage.setItem("scholea.apiBase", "http://old-server.invalid");
    localStorage.setItem("scholea.sync.p1", JSON.stringify({ serverId: "abc", rev: 2 }));
    localStorage.setItem("scholea.sync.p2", JSON.stringify({ serverId: "def", rev: 5 }));
    localStorage.setItem("scholea.shared.p1", "ghi");
    // Things that must survive.
    localStorage.setItem("scholea.identity", JSON.stringify({ name: "Ada", role: "researcher" }));
    localStorage.setItem("scholea.activeProject", "p1");
    localStorage.setItem("scholea.theme", "{}");
    localStorage.setItem("scholea.secure.ncbi", "key");
    localStorage.setItem("scholea.auth", "session");
    localStorage.setItem("scholea.account", "{}");
    localStorage.setItem("scholea.syncStatus", "x"); // not under the scholea.sync. prefix
    setLink("p1", accountLink());

    expect(purgeLegacyKeys()).toBe(6);

    const left = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).sort();
    expect(left).toEqual([
      "scholea.account",
      "scholea.activeProject",
      "scholea.auth",
      "scholea.identity",
      "scholea.link.p1",
      "scholea.secure.ncbi",
      "scholea.syncStatus",
      "scholea.theme",
    ]);
  });

  it("is safe to run again", () => {
    localStorage.setItem("scholea.token", "x");
    expect(purgeLegacyKeys()).toBe(1);
    expect(purgeLegacyKeys()).toBe(0);
  });
});
