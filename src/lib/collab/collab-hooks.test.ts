import { describe, expect, it } from "vitest";
import { createProjectSync, type SyncPorts } from "./project-sync";
import type { ListedProject } from "./sync";

/**
 * Project sync tells the layers built on it (comments and sign-offs) when it
 * starts for a person, when it stops, and when a sync has reached the backend.
 * These are the three places that layer hangs on.
 */
function harness(listed: ListedProject[] = []) {
  const events: string[] = [];
  const storage = new Map<string, string>();
  const never = () => () => {};
  const ports: SyncPorts = {
    api: {
      listProjects: async () => ({ projects: listed }),
      createProject: async () => {
        throw new Error("not used");
      },
      getContent: async () => ({ content: null, rev: 0, updatedAt: null }),
      putContent: async () => ({ ok: true, rev: 1 }),
      deleteProject: async () => ({ ok: true }),
      leaveProject: async () => ({ ok: true }),
    },
    projects: { list: async () => [], get: async () => undefined, put: async () => {}, update: async () => {}, remove: async () => {} },
    editor: { current: () => ({ project: null, stepId: "" }), subscribe: never, persist: async () => {}, reload: async () => {}, close: () => {} },
    session: { get: () => ({ userId: null, signedInId: null, deviceAccountId: null }), subscribe: never, recheck: () => {} },
    invitations: { refresh: async () => {}, clear: () => {}, onAccepted: never },
    device: { online: () => true, now: () => 1000, onOnline: never, onOffline: never, onFocus: never },
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => void storage.set(key, value),
      removeItem: (key) => void storage.delete(key),
    },
    afterSync: (list) => void events.push(`synced ${list.map((p) => p.id).join(",")}`),
    onStart: (user) => void events.push(`start ${user}`),
    onStop: () => void events.push("stop"),
  };
  return { engine: createProjectSync(ports), events };
}

describe("what project sync tells the layers on top", () => {
  it("says when it starts for a person, before the first sync of that person ends", async () => {
    const { engine, events } = harness();
    await engine.start("user-ada");
    expect(events).toEqual(["start user-ada", "synced "]);
  });

  it("says nothing new when asked to start again for the same person", async () => {
    const { engine, events } = harness();
    await engine.start("user-ada");
    await engine.start("user-ada");
    expect(events.filter((e) => e.startsWith("start"))).toEqual(["start user-ada"]);
    expect(events).not.toContain("stop");
  });

  it("says when it stops, once", async () => {
    const { engine, events } = harness();
    engine.stop();
    expect(events).toEqual([]);
    await engine.start("user-ada");
    engine.stop();
    engine.stop();
    expect(events.filter((e) => e === "stop")).toEqual(["stop"]);
  });

  it("stops for one person before it starts for the next", async () => {
    const { engine, events } = harness();
    await engine.start("user-ada");
    await engine.start("user-bob");
    expect(events.filter((e) => !e.startsWith("synced"))).toEqual(["start user-ada", "stop", "start user-bob"]);
  });

  it("hands over the project list at the end of every sync that reached the backend", async () => {
    const row: ListedProject = {
      id: "proj_11111111-1111-4111-8111-111111111111",
      title: "T",
      study_type: "cohort",
      owner_id: "user-ada",
      role: "viewer",
      rev: 0,
      content_updated_at: null,
      created_at: 1,
      updated_at: 1,
      collab_updated_at: 42,
    };
    const { engine, events } = harness([row]);
    await engine.start("user-ada");
    await engine.reconcile();
    expect(events.filter((e) => e.startsWith("synced"))).toEqual([`synced ${row.id}`, `synced ${row.id}`]);
  });
});
