/**
 * A `fetch` that gives up. The platform's own has no time limit: on a
 * connection that silently drops packets (a captive portal, a dead Wi-Fi
 * association) a request can wait for an answer for minutes, or for ever. Sync
 * runs one request after another, so one that never answers would hold up
 * every later upload until the app is restarted.
 *
 * Two limits, both generous about size and strict about silence:
 * - how long the backend may take to start answering. An upload gets extra
 *   time for what it carries, so a large project on a slow line is not cut off;
 * - how long an answer that has started may take to arrive in full, going by
 *   the size it announced.
 *
 * A request that runs out of time fails the way an unreachable backend does
 * (`TimeoutError`, which the error mapping reads as `network`), so callers
 * need nothing new: the action ends as "offline" and the next one starts
 * fresh. The answer itself is handed on untouched.
 */

/** How long the backend may take to begin its answer, before any allowance for an upload. */
export const REQUEST_DEADLINE_MS = 30_000;

/** How long an answer that does not say how large it is may take to arrive in full. */
export const ANSWER_DEADLINE_MS = 15 * 60_000;

/** The slowest transfer that is still waited for: 25 KB a second. */
const BYTES_PER_MS = 25;

export interface DeadlineOptions {
  requestMs?: number;
  answerMs?: number;
  /**
   * Whether the transport can be told to stop (see `canAbort`). Left out, the
   * platform is asked once.
   */
  abortable?: boolean;
}

/** The two constructors `canAbort` tries together. Tests pass their own. */
export interface AbortPlatform {
  Request: new (input: string, init: { signal: AbortSignal }) => unknown;
  AbortController: new () => { signal: AbortSignal };
}

let probed: boolean | null = null;

/**
 * Whether this platform's `fetch` accepts this platform's abort signal. Every
 * browser and webview does. The exception is a test run in an emulated page,
 * where the signal comes from the emulation and `fetch` from the runtime
 * underneath, which refuses a signal it did not make. A request is then
 * abandoned when its time is up instead of being stopped: the caller is
 * answered just the same.
 *
 * The platform is asked once. A `platform` given by a test is asked each time.
 */
export function canAbort(platform?: AbortPlatform): boolean {
  if (!platform && probed !== null) return probed;
  let works: boolean;
  try {
    const p = platform ?? { Request, AbortController };
    new p.Request("https://scholea.invalid/", { signal: new p.AbortController().signal });
    works = true;
  } catch {
    works = false;
  }
  if (!platform) probed = works;
  return works;
}

/** How large a request body is, in characters or bytes, when that can be told without reading it. */
function bodySize(body: unknown): number {
  if (typeof body === "string") return body.length;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  return 0;
}

/** How long a request may wait for the start of its answer: the base, plus time to send what it carries. */
export function requestDeadline(body: unknown, requestMs = REQUEST_DEADLINE_MS): number {
  return requestMs + Math.ceil(bodySize(body) / BYTES_PER_MS);
}

/**
 * How long an answer may take to arrive in full once it has started: the base
 * plus time for the size it announced (`content-length`), or `answerMs` when
 * it announced none.
 */
export function answerDeadline(contentLength: string | null, requestMs = REQUEST_DEADLINE_MS, answerMs = ANSWER_DEADLINE_MS): number {
  const bytes = contentLength === null || contentLength.trim() === "" ? NaN : Number(contentLength);
  return Number.isFinite(bytes) && bytes >= 0 ? requestMs + Math.ceil(bytes / BYTES_PER_MS) : answerMs;
}

function timeoutError(): Error {
  const message = "The request timed out.";
  if (typeof DOMException === "function") return new DOMException(message, "TimeoutError");
  return Object.assign(new Error(message), { name: "TimeoutError" });
}

/** A timer that never keeps a process alive by itself (it is a plain number in a browser, where that does not arise). */
function later(run: () => void, ms: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(run, ms);
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

/** Wrap a `fetch` so that no request can wait in silence for longer than the limits above. */
export function withDeadline(fetchImpl: typeof fetch, options: DeadlineOptions = {}): typeof fetch {
  const requestMs = options.requestMs ?? REQUEST_DEADLINE_MS;
  const answerMs = options.answerMs ?? ANSWER_DEADLINE_MS;

  return async (input, init) => {
    const abortable = options.abortable ?? canAbort();
    const controller = new AbortController();

    // The caller's own way of cancelling keeps working.
    const outer = init?.signal;
    if (outer?.aborted) controller.abort(outer.reason);
    else outer?.addEventListener("abort", () => controller.abort(outer.reason), { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    // Raced, so the limit holds even for a transport that ignores being told to stop.
    const tooLate = new Promise<never>((_, reject) => {
      timer = later(() => {
        const reason = timeoutError();
        controller.abort(reason);
        reject(reason);
      }, requestDeadline(init?.body, requestMs));
    });
    let response: Response;
    try {
      response = await Promise.race([fetchImpl(input, abortable ? { ...init, signal: controller.signal } : init), tooLate]);
    } finally {
      clearTimeout(timer);
    }

    // The answer has started. If the rest of it stops coming, reading it fails
    // once this fires. After an answer that was read in full it does nothing.
    if (abortable && response.body) {
      later(() => controller.abort(timeoutError()), answerDeadline(response.headers.get("content-length"), requestMs, answerMs));
    }
    return response;
  };
}
