import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { StorageLike } from "@/lib/account/session-store";
import { buildSupabaseClient } from "@/lib/supabase/client";
import { accentCss, deriveAccentPalette, type AccentPalette } from "./accent";
import { ACCENT_STYLE_ID } from "./apply-accent";
import {
  FETCH_TIMEOUT_MS,
  INSTANCE_KEY,
  INSTANCE_RPC,
  RETRY_AFTER_FAILURE_MS,
  createInstanceStore,
  instanceLoaderOf,
  startInstanceSync,
  useInstance,
  type InstanceLoader,
  type SessionPort,
} from "./instance-store";
import { REFRESH_INTERVAL_MS, type PublicInstance, type SessionPhase } from "./sanitize";

// Hand-written stand-ins for everything the store touches: the session, the
// backend, storage, the clock, the give-up timer and the window. No module
// mocking, and nothing here reaches a network.

const ORIGIN = "https://backend.example.test";
const T0 = 1_800_000_000_000;
const MINUTE = 60_000;

const RIVERSIDE: PublicInstance = {
  orgName: "Riverside Institute",
  supportEmail: "support@riverside.example",
  footerContact: "Research Office, Room 4.12",
  accent: "#00a651",
  enabledStudyTypes: ["rct", "cohort"],
};
const RENAMED: PublicInstance = { ...RIVERSIDE, orgName: "Riverside University", accent: "#ffd400" };

function memoryStorage(seed: Record<string, string> = {}): StorageLike & { dump(): Record<string, string>; writes: string[] } {
  const map = new Map(Object.entries(seed));
  const writes: string[] = [];
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      writes.push(key);
      map.set(key, value);
    },
    removeItem: (key) => void map.delete(key),
    dump: () => Object.fromEntries(map),
    writes,
  };
}

/** A record as the store keeps it on the device. */
function stored(snapshot: { instance: unknown; fetchedAt?: unknown; origin?: unknown }): Record<string, string> {
  return {
    [INSTANCE_KEY]: JSON.stringify({
      state: {
        instance: snapshot.instance,
        fetchedAt: "fetchedAt" in snapshot ? snapshot.fetchedAt : T0 - 1_000,
        origin: "origin" in snapshot ? snapshot.origin : ORIGIN,
      },
      version: 0,
    }),
  };
}

function fakeSession(initial: SessionPhase) {
  let state = { phase: initial };
  const listeners = new Set<(state: { phase: SessionPhase }, prev: { phase: SessionPhase }) => void>();
  let subscribeCalls = 0;
  const port: SessionPort = {
    getState: () => state,
    subscribe(listener) {
      subscribeCalls += 1;
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return {
    port,
    /** Move to a phase and tell whoever is listening, as the session store does. */
    to(phase: SessionPhase) {
      const prev = state;
      state = { phase };
      for (const listener of Array.from(listeners)) listener(state, prev);
    },
    get subscribeCalls() {
      return subscribeCalls;
    },
    get listening() {
      return listeners.size;
    },
  };
}

interface Call {
  signal: AbortSignal;
  /** Answer with these settings, in the backend's envelope. */
  answer(instance: unknown): void;
  /** Answer with this exact body. */
  answerRaw(data: unknown): void;
  /** Answer with an error, the way the client reports one. */
  refuse(error: unknown): void;
  /** Fail the request outright. */
  crash(error: unknown): void;
  /** Answer with exactly this result. */
  reply(result: { data: unknown; error: unknown }): void;
}

function fakeBackend() {
  const calls: Call[] = [];
  const load: InstanceLoader = (signal) =>
    new Promise((resolve, reject) => {
      calls.push({
        signal,
        answer: (instance) => resolve({ data: { instance }, error: null }),
        answerRaw: (data) => resolve({ data, error: null }),
        refuse: (error) => resolve({ data: null, error }),
        crash: reject,
        reply: resolve,
      });
    });
  return { load, calls };
}

/** Let the store's own asynchronous steps finish. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(
  options: {
    phase?: SessionPhase;
    storage?: Record<string, string>;
    origin?: string | null;
    backend?: boolean;
  } = {},
) {
  const storage = memoryStorage(options.storage);
  const session = fakeSession(options.phase ?? "anon");
  const backend = fakeBackend();
  const env = { now: T0, online: true, visible: true };
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  const win = new EventTarget();
  const doc = document.implementation.createHTMLDocument("research app");

  const store = createInstanceStore({
    origin: options.origin === undefined ? ORIGIN : options.origin,
    load: options.backend === false ? null : backend.load,
    session: session.port,
    storage,
    now: () => env.now,
    isOnline: () => env.online,
    isVisible: () => env.visible,
    timer: (run, ms) => {
      const entry = { run, ms, cancelled: false };
      timers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    win,
    doc,
  });

  return {
    store,
    storage,
    session,
    backend,
    env,
    timers,
    doc,
    record: () => {
      const raw = storage.getItem(INSTANCE_KEY);
      return raw === null ? null : (JSON.parse(raw) as unknown);
    },
    accentStyle: () => doc.getElementById(ACCENT_STYLE_ID),
    comeOnline: () => win.dispatchEvent(new Event("online")),
    comeIntoView: () => doc.dispatchEvent(new Event("visibilitychange")),
  };
}

/** Sign in from a guest start and let the first answer land. */
async function signedIn(instance: PublicInstance = RIVERSIDE) {
  const t = setup({ phase: "anon" });
  const stop = t.store.getState().start();
  t.session.to("ready");
  t.backend.calls[0].answer(instance);
  await settle();
  return { ...t, stop };
}

describe("a guest", () => {
  it("never causes a request and never gets a record on the device", async () => {
    const t = setup({ phase: "anon" });
    expect(t.store.getState().instance).toBeNull();

    t.store.getState().start();
    t.comeOnline();
    t.comeIntoView();
    await t.store.getState().refresh();
    await t.store.getState().refresh(true);
    t.env.now += 3 * REFRESH_INTERVAL_MS;
    t.comeIntoView();
    await settle();

    expect(t.backend.calls).toHaveLength(0);
    expect(t.store.getState()).toMatchObject({ instance: null, fetchedAt: 0, origin: null });
    expect(t.storage.dump()).toEqual({});
    expect(t.storage.writes).toEqual([]);
    expect(t.accentStyle()).toBeNull();
  });

  it("does not inherit a record left on the device by someone who was signed in", () => {
    const t = setup({ phase: "anon", storage: stored({ instance: RIVERSIDE }) });
    expect(t.store.getState().instance).toBeNull();
    expect(t.storage.dump()).toEqual({});
    t.store.getState().start();
    expect(t.accentStyle()).toBeNull();
    expect(t.backend.calls).toHaveLength(0);
  });
});

describe("a build with no backend", () => {
  it("is inert: no listening, no request, and a stale record is removed", async () => {
    const t = setup({ phase: "unconfigured", origin: null, backend: false, storage: stored({ instance: RIVERSIDE, origin: null }) });
    expect(t.store.getState().instance).toBeNull();
    expect(t.storage.dump()).toEqual({});

    const stop = t.store.getState().start();
    t.comeOnline();
    t.comeIntoView();
    await t.store.getState().refresh(true);
    expect(t.session.subscribeCalls).toBe(0);
    expect(t.backend.calls).toHaveLength(0);
    expect(t.accentStyle()).toBeNull();
    expect(() => stop()).not.toThrow();
  });

  it("is just as inert when only one of the address and the client is missing", async () => {
    const noClient = setup({ phase: "ready", backend: false, storage: stored({ instance: RIVERSIDE }) });
    expect(noClient.store.getState().instance).toBeNull();
    noClient.store.getState().start();
    expect(noClient.session.subscribeCalls).toBe(0);

    const noAddress = setup({ phase: "ready", origin: null, storage: stored({ instance: RIVERSIDE, origin: null }) });
    expect(noAddress.store.getState().instance).toBeNull();
    noAddress.store.getState().start();
    await noAddress.store.getState().refresh(true);
    expect(noAddress.backend.calls).toHaveLength(0);
  });
});

describe("starting with a cached snapshot", () => {
  it("has the snapshot from the first moment when an account is signed in, before anything is fetched", () => {
    const t = setup({ phase: "ready", storage: stored({ instance: RIVERSIDE, fetchedAt: T0 - 5 * MINUTE }) });
    expect(t.store.getState()).toMatchObject({ instance: RIVERSIDE, fetchedAt: T0 - 5 * MINUTE, origin: ORIGIN });
    expect(t.backend.calls).toHaveLength(0);
    expect(t.session.subscribeCalls).toBe(0);
  });

  it("then refreshes in the background once started, even if it was fetched moments ago", async () => {
    const t = setup({ phase: "ready", storage: stored({ instance: RIVERSIDE, fetchedAt: T0 - 1_000 }) });
    t.store.getState().start();
    // The cached accent is on the page before the backend has said anything.
    expect(t.accentStyle()?.textContent).toBe(accentCss(deriveAccentPalette(RIVERSIDE.accent) as AccentPalette));
    expect(t.backend.calls).toHaveLength(1);
    expect(t.store.getState().instance).toEqual(RIVERSIDE);

    t.env.now = T0 + 250;
    t.backend.calls[0].answer(RENAMED);
    await settle();
    expect(t.store.getState()).toMatchObject({ instance: RENAMED, fetchedAt: T0 + 250, origin: ORIGIN });
    expect(t.record()).toEqual({ state: { instance: RENAMED, fetchedAt: T0 + 250, origin: ORIGIN }, version: 0 });
  });

  it("is honoured while a saved session is still being checked, without asking the backend yet", () => {
    const t = setup({ phase: "loading", storage: stored({ instance: RIVERSIDE }) });
    expect(t.store.getState().instance).toEqual(RIVERSIDE);
    t.store.getState().start();
    expect(t.accentStyle()).not.toBeNull();
    expect(t.backend.calls).toHaveLength(0);

    // The session turns out to be good.
    t.session.to("ready");
    expect(t.backend.calls).toHaveLength(1);
    expect(t.store.getState().instance).toEqual(RIVERSIDE);
  });

  it("is dropped when the saved session turns out to be gone", () => {
    const t = setup({ phase: "loading", storage: stored({ instance: RIVERSIDE }) });
    t.store.getState().start();
    t.session.to("anon");
    expect(t.store.getState()).toMatchObject({ instance: null, fetchedAt: 0, origin: null });
    expect(t.storage.dump()).toEqual({});
    expect(t.accentStyle()).toBeNull();
    expect(t.backend.calls).toHaveLength(0);
  });

  it("is dropped and removed when it came from a different backend", () => {
    const t = setup({ phase: "ready", storage: stored({ instance: RIVERSIDE, origin: "https://other.example.test" }) });
    expect(t.store.getState().instance).toBeNull();
    expect(t.storage.dump()).toEqual({});
    // A trailing slash or a different scheme is a different backend too.
    for (const origin of [`${ORIGIN}/`, ORIGIN.replace("https", "http")]) {
      const other = setup({ phase: "ready", storage: stored({ instance: RIVERSIDE, origin }) });
      expect(other.store.getState().instance, origin).toBeNull();
      expect(other.storage.dump(), origin).toEqual({});
    }
  });

  it("goes through the same cleaning as a fresh answer", () => {
    const tampered = {
      orgName: "  Riverside\u0000 Institute  ",
      supportEmail: "javascript:alert(1)",
      footerContact: "Office",
      accent: "#fff;} body{display:none}",
      enabledStudyTypes: ["rct", "NOT AN ID", 7],
      role: "master_admin",
    };
    const t = setup({ phase: "ready", storage: stored({ instance: tampered }) });
    expect(t.store.getState().instance).toEqual({
      orgName: "Riverside Institute",
      supportEmail: "",
      footerContact: "Office",
      accent: "",
      enabledStudyTypes: ["rct"],
    });
    t.store.getState().start();
    expect(t.accentStyle()).toBeNull();
  });

  it("is dropped when it is not a usable record at all", () => {
    const unusable = ["{not json", "null", '"text"', "[]", "{}", '{"state":null}', `{"state":{"instance":"x","origin":"${ORIGIN}"}}`];
    for (const raw of unusable) {
      const t = setup({ phase: "ready", storage: { [INSTANCE_KEY]: raw } });
      expect(t.store.getState().instance, raw).toBeNull();
      expect(t.storage.dump(), raw).toEqual({});
    }
  });

  it("is read whatever version number the record carries, since every field is checked anyway", () => {
    const record = JSON.stringify({ state: { instance: RIVERSIDE, fetchedAt: T0 - 1_000, origin: ORIGIN }, version: 7 });
    const t = setup({ phase: "ready", storage: { [INSTANCE_KEY]: record } });
    expect(t.store.getState()).toMatchObject({ instance: RIVERSIDE, fetchedAt: T0 - 1_000, origin: ORIGIN });
  });

  it("treats a missing or nonsense fetch time as never fetched", () => {
    for (const fetchedAt of ["yesterday", -1, null, Number.MAX_VALUE * 2]) {
      const t = setup({ phase: "ready", storage: stored({ instance: RIVERSIDE, fetchedAt }) });
      expect(t.store.getState()).toMatchObject({ instance: RIVERSIDE, fetchedAt: 0 });
    }
  });
});

describe("signing in and out", () => {
  it("fetches on sign-in and keeps the answer on the device", async () => {
    const t = setup({ phase: "anon" });
    t.store.getState().start();
    expect(t.backend.calls).toHaveLength(0);

    t.session.to("ready");
    expect(t.backend.calls).toHaveLength(1);
    expect(t.store.getState().instance).toBeNull();

    t.env.now = T0 + 400;
    t.backend.calls[0].answer(RIVERSIDE);
    await settle();
    expect(t.store.getState()).toMatchObject({ instance: RIVERSIDE, fetchedAt: T0 + 400, origin: ORIGIN });
    expect(t.record()).toEqual({ state: { instance: RIVERSIDE, fetchedAt: T0 + 400, origin: ORIGIN }, version: 0 });
    expect(Object.keys(t.storage.dump())).toEqual([INSTANCE_KEY]);
    expect(t.accentStyle()?.textContent).toContain(":root:not([data-theme=\"admin\"])[data-mode=\"light\"]");
  });

  it("cleans the answer before keeping it", async () => {
    const t = setup({ phase: "anon" });
    t.store.getState().start();
    t.session.to("ready");
    t.backend.calls[0].answer({ ...RIVERSIDE, orgName: "Scholea", accent: "red", supportEmail: "a@b", extra: "ignored" });
    await settle();
    expect(t.store.getState().instance).toEqual({ ...RIVERSIDE, orgName: "", accent: "", supportEmail: "" });
    expect(t.accentStyle()).toBeNull();
  });

  it("drops everything on sign-out: the snapshot, the record on the device and the accent", async () => {
    const t = await signedIn();
    expect(t.store.getState().instance).toEqual(RIVERSIDE);
    expect(t.accentStyle()).not.toBeNull();

    t.session.to("anon");
    expect(t.store.getState()).toMatchObject({ instance: null, fetchedAt: 0, origin: null });
    expect(t.storage.dump()).toEqual({});
    expect(t.accentStyle()).toBeNull();
  });

  it("fetches again for the next sign-in, however recently the last one was", async () => {
    const t = await signedIn();
    t.session.to("anon");
    t.env.now = T0 + 2_000;
    t.session.to("ready");
    expect(t.backend.calls).toHaveLength(2);
    t.backend.calls[1].answer(RENAMED);
    await settle();
    expect(t.store.getState().instance).toEqual(RENAMED);
  });

  it("gives up a request that is in the air at sign-out and ignores its answer", async () => {
    const t = setup({ phase: "anon" });
    t.store.getState().start();
    t.session.to("ready");
    const call = t.backend.calls[0];
    expect(call.signal.aborted).toBe(false);

    t.session.to("anon");
    expect(call.signal.aborted).toBe(true);
    call.answer(RIVERSIDE);
    await settle();
    expect(t.store.getState().instance).toBeNull();
    expect(t.storage.dump()).toEqual({});
    expect(t.accentStyle()).toBeNull();
  });

  it("does not hand one account's late answer to the next sign-in", async () => {
    const t = setup({ phase: "anon" });
    t.store.getState().start();
    t.session.to("ready");
    t.session.to("anon");
    t.session.to("ready");
    expect(t.backend.calls).toHaveLength(2);

    // The first request answers late, after the second sign-in.
    t.backend.calls[0].answer(RIVERSIDE);
    await settle();
    expect(t.store.getState().instance).toBeNull();
    t.backend.calls[1].answer(RENAMED);
    await settle();
    expect(t.store.getState().instance).toEqual(RENAMED);
  });

  it("discards an answer that was already on its way in when one session ended and the next began", async () => {
    const t = setup({ phase: "anon" });
    t.store.getState().start();
    t.session.to("ready");
    // The answer is in, but the store has not looked at it yet.
    t.backend.calls[0].answer(RIVERSIDE);
    t.session.to("anon");
    t.session.to("ready");
    await settle();
    expect(t.store.getState().instance).toBeNull();
    expect(t.storage.dump()).toEqual({});

    // The request made for the new session is the one that counts.
    expect(t.backend.calls).toHaveLength(2);
    t.backend.calls[1].answer(RENAMED);
    await settle();
    expect(t.store.getState().instance).toEqual(RENAMED);
  });

  it("does not keep an answer that arrives after the session ended, even when nothing told the store", async () => {
    // refresh() used on its own, with start() never called.
    const t = setup({ phase: "ready" });
    const done = t.store.getState().refresh(true);
    t.session.to("anon");
    t.backend.calls[0].answer(RIVERSIDE);
    await done;
    expect(t.store.getState().instance).toBeNull();
    expect(t.storage.dump()).toEqual({});
  });
});

describe("refreshing while signed in", () => {
  it("asks again when the device comes online or the window comes back into view, at most once per ten minutes", async () => {
    const t = await signedIn();
    expect(t.backend.calls).toHaveLength(1);

    t.env.now = T0 + MINUTE;
    t.comeOnline();
    t.comeIntoView();
    t.env.now = T0 + REFRESH_INTERVAL_MS - 1;
    t.comeOnline();
    t.comeIntoView();
    expect(t.backend.calls).toHaveLength(1);

    t.env.now = T0 + REFRESH_INTERVAL_MS;
    t.comeIntoView();
    expect(t.backend.calls).toHaveLength(2);
    t.backend.calls[1].answer(RENAMED);
    await settle();
    expect(t.store.getState()).toMatchObject({ instance: RENAMED, fetchedAt: T0 + REFRESH_INTERVAL_MS });

    // The ten minutes start again from that answer.
    t.env.now = T0 + REFRESH_INTERVAL_MS + MINUTE;
    t.comeOnline();
    expect(t.backend.calls).toHaveLength(2);
    t.env.now = T0 + 2 * REFRESH_INTERVAL_MS;
    t.comeOnline();
    expect(t.backend.calls).toHaveLength(3);
  });

  it("does not ask when the window was hidden rather than shown", async () => {
    const t = await signedIn();
    t.env.now = T0 + 2 * REFRESH_INTERVAL_MS;
    t.env.visible = false;
    t.comeIntoView();
    expect(t.backend.calls).toHaveLength(1);
    t.env.visible = true;
    t.comeIntoView();
    expect(t.backend.calls).toHaveLength(2);
  });

  it("does not ask while offline, and catches up when the connection returns", async () => {
    const t = setup({ phase: "ready", storage: stored({ instance: RIVERSIDE, fetchedAt: T0 - 3 * REFRESH_INTERVAL_MS }) });
    t.env.online = false;
    t.store.getState().start();
    t.comeIntoView();
    await t.store.getState().refresh(true);
    expect(t.backend.calls).toHaveLength(0);
    // Offline, the last-known settings simply stay.
    expect(t.store.getState().instance).toEqual(RIVERSIDE);
    expect(t.accentStyle()).not.toBeNull();

    t.env.online = true;
    t.comeOnline();
    expect(t.backend.calls).toHaveLength(1);
  });

  it("refresh(true) skips the wait, and refresh() does not", async () => {
    const t = await signedIn();
    t.env.now = T0 + MINUTE;
    await t.store.getState().refresh();
    expect(t.backend.calls).toHaveLength(1);

    const done = t.store.getState().refresh(true);
    expect(t.backend.calls).toHaveLength(2);
    t.backend.calls[1].answer(RENAMED);
    await done;
    expect(t.store.getState().instance).toEqual(RENAMED);
  });

  it("makes one request at a time, whatever asks for it", async () => {
    const t = setup({ phase: "ready", storage: stored({ instance: RIVERSIDE, fetchedAt: T0 - 3 * REFRESH_INTERVAL_MS }) });
    t.store.getState().start();
    t.comeOnline();
    t.comeIntoView();
    const first = t.store.getState().refresh(true);
    const second = t.store.getState().refresh(true);
    expect(t.backend.calls).toHaveLength(1);
    expect(second).toBe(first);

    t.backend.calls[0].answer(RENAMED);
    await first;
    expect(t.store.getState().instance).toEqual(RENAMED);
    expect(t.backend.calls).toHaveLength(1);
  });

  it("keeps the same settings object when nothing changed, and still notes the time", async () => {
    const t = await signedIn();
    const before = t.store.getState().instance;
    t.env.now = T0 + REFRESH_INTERVAL_MS;
    t.comeOnline();
    t.backend.calls[1].answer({ ...RIVERSIDE, enabledStudyTypes: [...(RIVERSIDE.enabledStudyTypes ?? [])] });
    await settle();
    expect(t.store.getState().instance).toBe(before);
    expect(t.store.getState().fetchedAt).toBe(T0 + REFRESH_INTERVAL_MS);
    expect((t.record() as { state: { fetchedAt: number } }).state.fetchedAt).toBe(T0 + REFRESH_INTERVAL_MS);
  });
});

describe("when the backend does not answer properly", () => {
  it("gives up after eight seconds and keeps the last snapshot", async () => {
    const t = await signedIn();
    t.env.now = T0 + REFRESH_INTERVAL_MS;
    t.comeOnline();
    expect(FETCH_TIMEOUT_MS).toBe(8_000);
    expect(t.timers).toHaveLength(2);
    expect(t.timers[1].ms).toBe(FETCH_TIMEOUT_MS);
    const call = t.backend.calls[1];
    expect(call.signal.aborted).toBe(false);

    // Time runs out, and the client never notices the signal.
    t.timers[1].run();
    expect(call.signal.aborted).toBe(true);
    await settle();
    expect(t.store.getState()).toMatchObject({ instance: RIVERSIDE, fetchedAt: T0 });

    // An answer after that is too late to count.
    call.answer(RENAMED);
    await settle();
    expect(t.store.getState().instance).toEqual(RIVERSIDE);

    // And the store is free to try again.
    void t.store.getState().refresh(true);
    expect(t.backend.calls).toHaveLength(3);
  });

  it("calls the give-up timer off once an answer is in", async () => {
    const t = await signedIn();
    expect(t.timers).toHaveLength(1);
    expect(t.timers[0].cancelled).toBe(true);
  });

  it("swallows every kind of failure: refresh never rejects and the snapshot stays", async () => {
    const failures: ((call: Call) => void)[] = [
      (call) => call.refuse({ code: "PGRST301", message: "JWT expired" }),
      (call) => call.refuse(new Error("Failed to fetch")),
      (call) => call.crash(new TypeError("Failed to fetch")),
      (call) => call.crash("not even an error"),
      (call) => call.answerRaw(null),
      (call) => call.answerRaw("<html>captive portal</html>"),
      (call) => call.answerRaw({ instance: null }),
      (call) => call.answerRaw({ instance: {} }),
      (call) => call.answerRaw({ instance: ["Riverside"] }),
      (call) => call.answerRaw({ code: "42501", message: "permission denied" }),
      (call) => call.answerRaw(RIVERSIDE),
      // An error wins even when settings came with it.
      (call) => call.reply({ data: { instance: RENAMED }, error: { message: "partial answer" } }),
    ];
    for (const fail of failures) {
      const t = await signedIn();
      const done = t.store.getState().refresh(true);
      fail(t.backend.calls[1]);
      await expect(done).resolves.toBeUndefined();
      expect(t.store.getState()).toMatchObject({ instance: RIVERSIDE, fetchedAt: T0 });
      expect(t.record()).toEqual({ state: { instance: RIVERSIDE, fetchedAt: T0, origin: ORIGIN }, version: 0 });
      expect(t.timers[1].cancelled).toBe(true);
    }
  });

  it("survives a client that throws instead of answering", async () => {
    const storage = memoryStorage();
    const session = fakeSession("ready");
    let calls = 0;
    const store = createInstanceStore({
      origin: ORIGIN,
      load: () => {
        calls += 1;
        throw new Error("client exploded");
      },
      session: session.port,
      storage,
      now: () => T0,
      isOnline: () => true,
      win: null,
      doc: null,
    });
    expect(() => store.getState().start()).not.toThrow();
    await expect(store.getState().refresh(true)).resolves.toBeUndefined();
    expect(calls).toBe(2);
    expect(store.getState().instance).toBeNull();
  });

  it("after a failure, waits a minute before trying again on its own, but not when asked to", async () => {
    const t = setup({ phase: "anon" });
    t.store.getState().start();
    t.session.to("ready");
    t.backend.calls[0].refuse({ message: "bad gateway" });
    await settle();
    expect(t.store.getState().instance).toBeNull();

    // Nothing was ever fetched, so only the pause after the failure holds these back.
    t.env.now = T0 + 10_000;
    t.comeOnline();
    t.comeIntoView();
    expect(t.backend.calls).toHaveLength(1);

    t.env.now = T0 + RETRY_AFTER_FAILURE_MS;
    t.comeIntoView();
    expect(t.backend.calls).toHaveLength(2);
    t.backend.calls[1].crash(new Error("still down"));
    await settle();

    // A request that failed outright starts the same pause.
    t.env.now += 1_000;
    t.comeOnline();
    t.comeIntoView();
    expect(t.backend.calls).toHaveLength(2);

    // Asking outright does not wait.
    t.env.now += 1_000;
    const done = t.store.getState().refresh(true);
    expect(t.backend.calls).toHaveLength(3);
    t.backend.calls[2].answer(RIVERSIDE);
    await done;
    expect(t.store.getState().instance).toEqual(RIVERSIDE);

    // A success clears the pause: the ordinary ten minutes apply again.
    t.env.now += REFRESH_INTERVAL_MS;
    t.comeOnline();
    expect(t.backend.calls).toHaveLength(4);
  });
});

describe("the accent on the page", () => {
  it("follows the snapshot: applied, replaced, and removed for the stock palette", async () => {
    const t = await signedIn();
    const style = t.accentStyle();
    expect(style?.textContent).toBe(accentCss(deriveAccentPalette("#00a651") as AccentPalette));

    const next = async (accent: string) => {
      const done = t.store.getState().refresh(true);
      t.backend.calls[t.backend.calls.length - 1].answer({ ...RIVERSIDE, accent });
      await done;
    };
    await next("#FFD400");
    expect(t.accentStyle()).toBe(style);
    expect(style?.textContent).toBe(accentCss(deriveAccentPalette("#ffd400") as AccentPalette));
    expect(t.doc.querySelectorAll("style")).toHaveLength(1);

    // The stock violet and an empty accent both mean no override at all.
    await next("#6C5CE7");
    expect(t.accentStyle()).toBeNull();
    await next("#00A651");
    expect(t.accentStyle()).not.toBeNull();
    await next("");
    expect(t.accentStyle()).toBeNull();
  });

  it("never colours the admin theme: both rules leave it out in the selector", async () => {
    const t = await signedIn();
    const rules = (t.accentStyle()?.textContent ?? "").split("\n");
    expect(rules).toHaveLength(2);
    for (const rule of rules) expect(rule.startsWith(':root:not([data-theme="admin"])[data-mode="')).toBe(true);
  });

  it("is not touched before start, and is left alone by a store with no page", async () => {
    const t = setup({ phase: "ready", storage: stored({ instance: RIVERSIDE }) });
    expect(t.accentStyle()).toBeNull();

    const session = fakeSession("ready");
    const backend = fakeBackend();
    const store = createInstanceStore({ origin: ORIGIN, load: backend.load, session: session.port, storage: memoryStorage(), win: null, doc: null });
    store.getState().start();
    backend.calls[0].answer(RIVERSIDE);
    await settle();
    expect(store.getState().instance).toEqual(RIVERSIDE);
    expect(document.getElementById(ACCENT_STYLE_ID)).toBeNull();
  });
});

describe("start and stop", () => {
  it("listens to the session through exactly one subscription, however often it is started", async () => {
    const t = setup({ phase: "anon" });
    const stop = t.store.getState().start();
    expect(t.store.getState().start()).toBe(stop);
    expect(t.store.getState().start()).toBe(stop);
    expect(t.session.subscribeCalls).toBe(1);
    expect(t.session.listening).toBe(1);

    // One trigger, one request: nothing was wired twice.
    t.session.to("ready");
    expect(t.backend.calls).toHaveLength(1);
    t.backend.calls[0].answer(RIVERSIDE);
    await settle();
    t.env.now = T0 + REFRESH_INTERVAL_MS;
    t.comeOnline();
    expect(t.backend.calls).toHaveLength(2);
  });

  it("stops following when asked, and can be started again", async () => {
    const t = await signedIn();
    t.stop();
    expect(t.session.listening).toBe(0);

    t.env.now = T0 + 2 * REFRESH_INTERVAL_MS;
    t.comeOnline();
    t.comeIntoView();
    expect(t.backend.calls).toHaveLength(1);
    // Stopping twice, or with a stale handle, does nothing.
    t.stop();

    const again = t.store.getState().start();
    expect(again).not.toBe(t.stop);
    expect(t.session.subscribeCalls).toBe(2);
    expect(t.session.listening).toBe(1);
    // Starting while signed in asks straight away.
    expect(t.backend.calls).toHaveLength(2);
    t.stop();
    expect(t.session.listening).toBe(1);
    // The stale handle did not make the store forget that it is running.
    expect(t.store.getState().start()).toBe(again);
    expect(t.session.subscribeCalls).toBe(2);
    again();
    expect(t.session.listening).toBe(0);
  });

  it("catches up on start with a session that ended in the meantime", () => {
    const t = setup({ phase: "ready", storage: stored({ instance: RIVERSIDE }) });
    expect(t.store.getState().instance).toEqual(RIVERSIDE);
    // The session ends before anything is listening.
    t.session.to("anon");
    t.store.getState().start();
    expect(t.store.getState().instance).toBeNull();
    expect(t.storage.dump()).toEqual({});
    expect(t.accentStyle()).toBeNull();
    expect(t.backend.calls).toHaveLength(0);
  });

  it("ignores session news that does not change the phase", async () => {
    const t = await signedIn();
    t.env.now = T0 + MINUTE;
    // The session store reports a profile reload and the like with the same phase.
    t.session.to("ready");
    t.session.to("ready");
    expect(t.backend.calls).toHaveLength(1);
    expect(t.store.getState().instance).toEqual(RIVERSIDE);
  });
});

describe("storage that misbehaves", () => {
  it("still works for this launch when nothing can be read or written", async () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error("storage is disabled");
      },
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => {
        throw new Error("storage is disabled");
      },
    };
    const session = fakeSession("anon");
    const backend = fakeBackend();
    const store = createInstanceStore({
      origin: ORIGIN,
      load: backend.load,
      session: session.port,
      storage: broken,
      now: () => T0,
      isOnline: () => true,
      win: null,
      doc: null,
    });
    expect(store.getState().instance).toBeNull();

    store.getState().start();
    session.to("ready");
    backend.calls[0].answer(RIVERSIDE);
    await settle();
    expect(store.getState().instance).toEqual(RIVERSIDE);
    expect(() => session.to("anon")).not.toThrow();
    expect(store.getState().instance).toBeNull();
  });
});

describe("the app's own snapshot", () => {
  it("asks the backend for the public settings by name, passing the give-up signal through", async () => {
    expect(INSTANCE_RPC).toBe("get_public_instance");
    expect(instanceLoaderOf(null)).toBeNull();

    const seen: { fn: string; args: unknown[]; signal: AbortSignal | null } = { fn: "", args: [], signal: null };
    const client = {
      rpc(fn: string, ...args: unknown[]) {
        seen.fn = fn;
        seen.args = args;
        return {
          abortSignal(signal: AbortSignal) {
            seen.signal = signal;
            return Promise.resolve({ data: { instance: RIVERSIDE }, error: null });
          },
        };
      },
    } as unknown as SupabaseClient;
    const load = instanceLoaderOf(client) as InstanceLoader;
    const controller = new AbortController();
    await expect(load(controller.signal)).resolves.toEqual({ data: { instance: RIVERSIDE }, error: null });
    expect(seen).toEqual({ fn: "get_public_instance", args: [], signal: controller.signal });
  });

  it("through the real client: one POST to the settings function, with the public key and a signal that gives up", async () => {
    // Only the network is replaced, so this pins what the library sends.
    const BASE = "https://scholea.example.test";
    const KEY = "sb_publishable_example";
    const requests: { url: string; method: string; apikey: string | null; body: unknown; signal: AbortSignal | null }[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        apikey: headers.get("apikey"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
        signal: init?.signal ?? null,
      });
      return new Response(JSON.stringify({ instance: { ...RIVERSIDE, orgName: "Scholea" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = buildSupabaseClient({ url: BASE, key: KEY }, { fetch: fakeFetch }) as SupabaseClient;
    try {
      const session = fakeSession("ready");
      const store = createInstanceStore({
        origin: BASE,
        load: instanceLoaderOf(client),
        session: session.port,
        storage: memoryStorage(),
        now: () => T0,
        isOnline: () => true,
        win: null,
        doc: null,
      });
      await store.getState().refresh(true);

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ url: `${BASE}/rest/v1/rpc/get_public_instance`, method: "POST", apikey: KEY, body: {} });
      expect(requests[0].signal).not.toBeNull();
      expect(requests[0].signal?.aborted).toBe(false);
      // The backend's envelope is unwrapped and its default name cleaned away.
      expect(store.getState()).toMatchObject({ instance: { ...RIVERSIDE, orgName: "" }, fetchedAt: T0, origin: BASE });
    } finally {
      await client.auth.dispose();
    }
  });

  it("is stock Scholea for a guest, and starting it is harmless", () => {
    expect(INSTANCE_KEY).toBe("scholea.instance");
    expect(useInstance.getState().instance).toBeNull();
    const stop = startInstanceSync();
    expect(useInstance.getState().instance).toBeNull();
    expect(localStorage.getItem(INSTANCE_KEY)).toBeNull();
    expect(document.getElementById(ACCENT_STYLE_ID)).toBeNull();
    stop();
  });
});
