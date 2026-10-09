/**
 * The instance snapshot: the organisation name, contact details, accent colour
 * and study-type list of the backend the signed-in person belongs to.
 *
 * One rule decides everything here: the snapshot exists on a device if and
 * only if an account is signed in on it. A guest gets stock Scholea and not a
 * single request; a build with no backend is inert. The snapshot is kept on the
 * device with no expiry, so someone signed in but offline keeps the last-known
 * settings, and it is honoured from the first frame while a saved session is
 * still being checked. It is dropped the moment the session ends, and never
 * used for a different backend than the one it came from.
 *
 * Nothing in the interface waits for this store. A fetch runs in the
 * background, a failure is swallowed, and the last snapshot stays.
 *
 * `instance` is already the value to act on: it is `null` whenever the rules
 * above say there is no snapshot, so readers need no session check of their own.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { create } from "zustand";
import { persist, type PersistStorage } from "zustand/middleware";
import { useSession, type StorageLike } from "@/lib/account/session-store";
import { supabase } from "@/lib/supabase/client";
import { supabaseConfig } from "@/lib/supabase/config";
import { deriveAccentPalette } from "./accent";
import { applyAccent } from "./apply-accent";
import { resolveInstance, sanitizeInstance, shouldRefresh, type PublicInstance, type SessionPhase } from "./sanitize";

/** localStorage key for the snapshot. Present only while someone is signed in. */
export const INSTANCE_KEY = "scholea.instance";

/** Backend function that returns the public settings. Open to everyone, guests included. */
export const INSTANCE_RPC = "get_public_instance";

/** A request that has not answered by now is given up on. */
export const FETCH_TIMEOUT_MS = 8_000;

/** After a failed try, coming online or back into view does not try again sooner than this. */
export const RETRY_AFTER_FAILURE_MS = 60_000;

/** What is kept on the device. */
export interface InstanceSnapshot {
  /** The cleaned settings, or `null` when there is no snapshot. */
  instance: PublicInstance | null;
  /** When they were last fetched, in epoch milliseconds. 0 when never. */
  fetchedAt: number;
  /** Address of the backend they came from. */
  origin: string | null;
}

export interface InstanceState extends InstanceSnapshot {
  /**
   * Start following the session: drop the snapshot when it ends, fetch when
   * someone signs in, when the app starts already signed in, and (at most once
   * per ten minutes) when the device comes online or the window comes back into
   * view. Also keeps the accent colour on the page in step with the snapshot.
   * Safe to call more than once. Returns a function that stops following.
   */
  start(): () => void;
  /**
   * Fetch now if the rules allow it; `force` skips only the ten-minute wait.
   * Resolves when the try is over and never rejects. Screens do not wait on it,
   * and none calls it at present: every fetch comes from `start`. It is the
   * same try, kept callable for a caller that knows the settings just changed.
   */
  refresh(force?: boolean): Promise<void>;
}

// --- What the store needs from outside -----------------------------------------
// Narrow views, so tests can pass plain hand-written objects.

/** Reads the public settings. Resolves in the backend client's `{ data, error }` shape. */
export type InstanceLoader = (signal: AbortSignal) => PromiseLike<{ data: unknown; error: unknown }>;

/** The session store, as far as this store looks at it. */
export interface SessionPort {
  getState(): { phase: SessionPhase };
  subscribe(listener: (state: { phase: SessionPhase }, prev: { phase: SessionPhase }) => void): () => void;
}

interface Listenable {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface InstanceDeps {
  /** Address of the backend this build talks to, or `null` in a build with none. */
  origin: string | null;
  /** `null` in a build with no backend. */
  load: InstanceLoader | null;
  session: SessionPort;
  storage: StorageLike;
  /** The clock, in epoch milliseconds. Tests pass their own. */
  now?: () => number;
  isOnline?: () => boolean;
  isVisible?: () => boolean;
  /** Runs `run` after `ms` and returns a way to call that off. Tests pass their own. */
  timer?: (run: () => void, ms: number) => () => void;
  /** Where "online" is announced. `null` for nowhere. */
  win?: Listenable | null;
  /** The page: receives the accent stylesheet and announces visibility. `null` for none. */
  doc?: Document | null;
}

const EMPTY: InstanceSnapshot = { instance: null, fetchedAt: 0, origin: null };
const DONE: Promise<void> = Promise.resolve();
const NOTHING_TO_STOP = (): void => {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameInstance(a: PublicInstance, b: PublicInstance): boolean {
  return (
    a.orgName === b.orgName &&
    a.supportEmail === b.supportEmail &&
    a.footerContact === b.footerContact &&
    a.accent === b.accent &&
    JSON.stringify(a.enabledStudyTypes) === JSON.stringify(b.enabledStudyTypes)
  );
}

export function createInstanceStore(deps: InstanceDeps) {
  const { origin, session, storage } = deps;
  const load = origin === null ? null : deps.load;
  const configured = load !== null;
  const now = deps.now ?? (() => Date.now());
  const isOnline = deps.isOnline ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);
  const win = deps.win === undefined ? (typeof window === "undefined" ? null : window) : deps.win;
  const doc = deps.doc === undefined ? (typeof document === "undefined" ? null : document) : deps.doc;
  const isVisible = deps.isVisible ?? (() => doc === null || doc.visibilityState === "visible");
  const timer =
    deps.timer ??
    ((run: () => void, ms: number) => {
      const id = setTimeout(run, ms);
      return () => clearTimeout(id);
    });

  /**
   * A record read back from the device, if it may be used: it came from this
   * build's backend, someone is signed in (or a saved session is being
   * checked), and it survives the same cleaning as a fresh answer.
   */
  function admit(record: unknown): InstanceSnapshot {
    if (!configured || !isRecord(record) || record.origin !== origin) return EMPTY;
    const instance = resolveInstance(session.getState().phase, sanitizeInstance(record.instance));
    if (!instance) return EMPTY;
    const at = record.fetchedAt;
    return { instance, fetchedAt: typeof at === "number" && Number.isFinite(at) && at > 0 ? at : 0, origin };
  }

  // Storage can be unavailable (private mode, quota). The snapshot then lives
  // for this launch only.
  const device: PersistStorage<InstanceSnapshot> = {
    getItem(name) {
      try {
        const raw = storage.getItem(name);
        const parsed: unknown = raw === null ? null : JSON.parse(raw);
        // The stored version is ignored on purpose: `admit` checks every field.
        return isRecord(parsed) ? { state: parsed.state as InstanceSnapshot, version: 0 } : null;
      } catch {
        return null;
      }
    },
    setItem(name, value) {
      try {
        // No snapshot, no record: the key is there only while someone is signed in.
        if (value.state.instance === null) storage.removeItem(name);
        else storage.setItem(name, JSON.stringify(value));
      } catch {
        /* ignore */
      }
    },
    removeItem(name) {
      try {
        storage.removeItem(name);
      } catch {
        /* ignore */
      }
    },
  };

  let stop: (() => void) | null = null;
  /** Goes up each time the snapshot is dropped, so a late answer can be told apart. */
  let epoch = 0;
  /** The request in the air, if any. */
  let flight: { done: Promise<void>; abort(): void } | null = null;
  let failedAt = Number.NEGATIVE_INFINITY;

  const store = create<InstanceState>()(
    persist(
      (set, get, api) => {
        /** Put the snapshot's accent on the page, or take the stylesheet off. */
        function paint(): void {
          if (doc) applyAccent(deriveAccentPalette(get().instance?.accent), doc);
        }

        function clear(): void {
          epoch += 1;
          flight?.abort();
          flight = null;
          failedAt = Number.NEGATIVE_INFINITY;
          if (get().instance !== null || get().fetchedAt !== 0) set(EMPTY);
        }

        function attempt(force: boolean): Promise<void> {
          if (!load) return DONE;
          if (flight) return flight.done;
          const at = now();
          const due = shouldRefresh({
            phase: session.getState().phase,
            configured,
            online: isOnline(),
            now: at,
            fetchedAt: get().fetchedAt,
            force,
          });
          if (!due || (!force && at - failedAt < RETRY_AFTER_FAILURE_MS)) return DONE;

          const controller = new AbortController();
          const cancelTimeout = timer(() => controller.abort(), FETCH_TIMEOUT_MS);
          // Giving up must not depend on the client noticing the signal.
          const gaveUp = new Promise<never>((_, reject) => {
            controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
          const startedIn = epoch;
          const mine = { done: DONE, abort: () => controller.abort() };

          const run = async (): Promise<void> => {
            try {
              const answer = await Promise.race([load(controller.signal), gaveUp]);
              // The session ended while the answer was on its way: it is nobody's now.
              if (epoch !== startedIn) return;
              const fresh = answer.error ? null : sanitizeInstance(isRecord(answer.data) ? answer.data.instance : null);
              const instance = resolveInstance(session.getState().phase, fresh);
              if (!instance) {
                failedAt = now();
                return;
              }
              failedAt = Number.NEGATIVE_INFINITY;
              const before = get().instance;
              // Unchanged settings keep their identity, so nothing re-renders for them.
              set({ instance: before && sameInstance(before, instance) ? before : instance, fetchedAt: now(), origin });
            } catch {
              // Offline, timed out or refused. The last snapshot stays.
              if (epoch === startedIn) failedAt = now();
            } finally {
              cancelTimeout();
              if (flight === mine) flight = null;
            }
          };

          flight = mine;
          mine.done = run();
          return mine.done;
        }

        function start(): () => void {
          if (stop) return stop;
          if (!configured) return NOTHING_TO_STOP;

          const onPhase = (phase: SessionPhase): void => {
            if (phase === "anon" || phase === "unconfigured") clear();
            else if (phase === "ready") void attempt(true);
          };
          const onOnline = (): void => void attempt(false);
          const onVisibility = (): void => {
            if (isVisible()) void attempt(false);
          };

          // The one place this store listens to the session.
          const offSession = session.subscribe((state, prev) => {
            if (state.phase !== prev.phase) onPhase(state.phase);
          });
          const offPaint = api.subscribe((state, prev) => {
            if (state.instance?.accent !== prev.instance?.accent) paint();
          });
          win?.addEventListener("online", onOnline);
          doc?.addEventListener("visibilitychange", onVisibility);

          const running = (): void => {
            if (stop !== running) return;
            stop = null;
            offSession();
            offPaint();
            win?.removeEventListener("online", onOnline);
            doc?.removeEventListener("visibilitychange", onVisibility);
          };
          stop = running;

          // Catch up with the session as it is now: the cached accent goes on
          // the page before anything is fetched.
          paint();
          onPhase(session.getState().phase);
          return running;
        }

        return { ...EMPTY, start, refresh: (force = false) => attempt(force) };
      },
      {
        name: INSTANCE_KEY,
        storage: device,
        partialize: (state): InstanceSnapshot => ({
          instance: state.instance,
          fetchedAt: state.fetchedAt,
          origin: state.origin,
        }),
        merge: (persisted, current) => ({ ...current, ...admit(persisted) }),
      },
    ),
  );

  // A record that was not admitted has no business staying on the device.
  if (store.getState().instance === null) device.removeItem(INSTANCE_KEY);

  return store;
}

// --- The app's own snapshot ----------------------------------------------------

const deviceStorage: StorageLike = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: (key) => localStorage.removeItem(key),
};

/** The settings request on the real client, or `null` in a build with no backend. */
export function instanceLoaderOf(c: SupabaseClient | null): InstanceLoader | null {
  if (!c) return null;
  return (signal) => c.rpc(INSTANCE_RPC).abortSignal(signal);
}

export const useInstance = createInstanceStore({
  origin: supabaseConfig?.url ?? null,
  load: instanceLoaderOf(supabase),
  session: useSession,
  storage: deviceStorage,
});

/**
 * Start keeping the app's snapshot in step with the session. Call it once when
 * the research app boots, before the first render if the cached accent should
 * be there from the first frame.
 */
export function startInstanceSync(): () => void {
  return useInstance.getState().start();
}
