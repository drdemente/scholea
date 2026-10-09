import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit";
import { RateLimitError } from "./types";

const noSleep = () => Promise.resolve();

describe("RateLimiter", () => {
  it("runs every scheduled task and returns results", async () => {
    const limiter = new RateLimiter({ maxConcurrent: 2, sleep: noSleep });
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => limiter.schedule(async () => n * 2)),
    );
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it("never exceeds max concurrency", async () => {
    const limiter = new RateLimiter({ maxConcurrent: 2, sleep: noSleep });
    let active = 0;
    let peak = 0;
    const make = () =>
      limiter.schedule(async () => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        await Promise.resolve();
        active--;
      });
    await Promise.all(Array.from({ length: 8 }, make));
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("retries transient failures up to the limit, then succeeds", async () => {
    const limiter = new RateLimiter({ retries: 3, sleep: noSleep });
    let calls = 0;
    const result = await limiter.schedule(async () => {
      calls++;
      if (calls < 3) throw new RateLimitError("test", 10);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry quota-exhaustion errors", async () => {
    const limiter = new RateLimiter({ retries: 3, sleep: noSleep });
    let calls = 0;
    await expect(
      limiter.schedule(async () => {
        calls++;
        throw new RateLimitError("openalex", undefined, true);
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(calls).toBe(1);
  });
});
