/**
 * Rate-limit-aware task queue. Each source gets its own limiter enforcing a
 * max concurrency and a minimum spacing between starts, with exponential
 * backoff + Retry-After handling for HTTP 429 (see RateLimitError).
 */
import { RateLimitError } from "./types";

export interface RateLimiterOptions {
  maxConcurrent?: number;
  /** Minimum ms between task starts (e.g. PubMed: 333ms without a key). */
  minIntervalMs?: number;
  /** Retries on rate-limit/transient errors. */
  retries?: number;
  /** Base backoff in ms (doubles each retry). */
  backoffMs?: number;
  /** Injectable sleep, for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RateLimiter {
  private readonly maxConcurrent: number;
  private readonly minIntervalMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  private active = 0;
  private lastStart = 0;
  private queue: Array<() => void> = [];

  constructor(opts: RateLimiterOptions = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? 2;
    this.minIntervalMs = opts.minIntervalMs ?? 0;
    this.retries = opts.retries ?? 2;
    this.backoffMs = opts.backoffMs ?? 500;
    this.sleep = opts.sleep ?? realSleep;
  }

  /** Schedule a task; resolves with its result once a slot is free. */
  schedule<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = async () => {
        this.active++;
        try {
          if (this.minIntervalMs > 0) {
            const wait = this.minIntervalMs - (now() - this.lastStart);
            if (wait > 0) await this.sleep(wait);
          }
          this.lastStart = now();
          resolve(await this.withRetry(task));
        } catch (err) {
          reject(err);
        } finally {
          this.active--;
          this.pump();
        }
      };

      this.queue.push(run);
      this.pump();
    });
  }

  private pump() {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift();
      next?.();
    }
  }

  private async withRetry<T>(task: () => Promise<T>): Promise<T> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await task();
      } catch (err) {
        const isRate = err instanceof RateLimitError;
        // Don't retry on quota exhaustion — backing off won't help.
        if (isRate && err.exhausted) throw err;
        if (attempt >= this.retries) throw err;
        const base = this.backoffMs * 2 ** attempt;
        const wait = isRate && err.retryAfterMs ? Math.max(base, err.retryAfterMs) : base;
        await this.sleep(wait);
        attempt++;
      }
    }
  }
}

function now(): number {
  // performance.now avoids the Date.now sandbox restriction in workflows and
  // is monotonic; falls back gracefully where unavailable.
  return typeof performance !== "undefined" ? performance.now() : 0;
}
