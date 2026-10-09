import { describe, expect, it } from "vitest";
import { createSync, syncClientOf } from "@/lib/collab/sync";
import { buildSupabaseClient } from "./client";
import { ANSWER_DEADLINE_MS, REQUEST_DEADLINE_MS, answerDeadline, canAbort, requestDeadline, withDeadline } from "./deadline";
import { SyncError, toSyncError } from "./errors";

/** A backend that takes the request and never answers. It gives up only when told to. */
function silent(seen: { signal?: AbortSignal | null; calls: number }): typeof fetch {
  return (_input, init) => {
    seen.calls += 1;
    seen.signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  };
}

describe("how long a request may take", () => {
  it("waits half a minute for an answer to start, and longer for an upload by its size", () => {
    expect(REQUEST_DEADLINE_MS).toBe(30_000);
    expect(requestDeadline(undefined)).toBe(30_000);
    expect(requestDeadline(null)).toBe(30_000);
    expect(requestDeadline("x".repeat(25_000))).toBe(31_000);
    expect(requestDeadline(new Uint8Array(50_000))).toBe(32_000);
    // A 20 MB project on a slow line is not cut off after half a minute.
    expect(requestDeadline("x".repeat(20 * 1024 * 1024))).toBeGreaterThan(10 * 60_000);
    expect(requestDeadline("abc", 100)).toBe(101);
  });

  it("gives an answer time for the size it announced, and a fixed long time when it announced none", () => {
    expect(answerDeadline("0")).toBe(30_000);
    expect(answerDeadline("250000")).toBe(40_000);
    expect(answerDeadline(null)).toBe(ANSWER_DEADLINE_MS);
    expect(answerDeadline("")).toBe(ANSWER_DEADLINE_MS);
    expect(answerDeadline("not a number")).toBe(ANSWER_DEADLINE_MS);
    expect(answerDeadline("-5")).toBe(ANSWER_DEADLINE_MS);
  });
});

describe("withDeadline", () => {
  it("asks the platform whether its fetch takes its abort signals", () => {
    class Signal {}
    const matching = {
      AbortController: class {
        signal = new Signal() as unknown as AbortSignal;
      },
      Request: class {
        constructor(_input: string, init: { signal: AbortSignal }) {
          if (!((init.signal as unknown) instanceof Signal)) throw new TypeError("Expected signal to be an instance of AbortSignal");
        }
      },
    };
    expect(canAbort(matching)).toBe(true);
    // An emulated page on top of another runtime: the signal is not one the runtime made.
    const foreign = {
      ...matching,
      AbortController: class {
        signal = {} as AbortSignal;
      },
    };
    expect(canAbort(foreign)).toBe(false);
    // Whatever this run's own platform says, it says it every time.
    expect(canAbort()).toBe(canAbort());
  });

  it("hands an answer on untouched", async () => {
    const answer = new Response(JSON.stringify({ ok: true }), { status: 201, headers: { "content-type": "application/json" } });
    const seen: RequestInit[] = [];
    const wrapped = withDeadline(
      async (_input, init) => {
        seen.push(init ?? {});
        return answer;
      },
      { abortable: true },
    );

    const got = await wrapped("https://scholea.example.test/x", { method: "POST", body: "{}" });
    expect(got).toBe(answer);
    expect(await got.json()).toEqual({ ok: true });
    // The request goes out as it was given, with a way to stop it added.
    expect(seen[0]).toMatchObject({ method: "POST", body: "{}" });
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
    expect(seen[0].signal?.aborted).toBe(false);
  });

  it("gives up on a request that never answers, and tells the transport to stop", async () => {
    const seen = { calls: 0, signal: undefined as AbortSignal | null | undefined };
    const wrapped = withDeadline(silent(seen), { requestMs: 20, abortable: true });

    const started = Date.now();
    const failure = await wrapped("https://scholea.example.test/x").then(
      () => null,
      (e: unknown) => e,
    );

    expect(failure).toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(seen.signal?.aborted).toBe(true);
    // Read like any other request that got no answer.
    expect(toSyncError(failure, undefined, { online: true })).toMatchObject({ code: "network", status: 0 });
  });

  it("gives up even when the transport ignores being told to stop", async () => {
    const wrapped = withDeadline(() => new Promise<Response>(() => {}), { requestMs: 20, abortable: true });
    await expect(wrapped("https://scholea.example.test/x")).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("where the transport cannot be told to stop, the request goes out as it was given and is abandoned when its time is up", async () => {
    const seen: Array<RequestInit | undefined> = [];
    const caller = new AbortController();
    const wrapped = withDeadline(
      (_input, init) => {
        seen.push(init);
        return new Promise<Response>(() => {});
      },
      { requestMs: 20, abortable: false },
    );

    await expect(wrapped("https://scholea.example.test/x", { method: "POST", signal: caller.signal })).rejects.toMatchObject({ name: "TimeoutError" });
    // Nothing of this module's own was added to the request.
    expect(seen[0]?.signal).toBe(caller.signal);
    expect(seen[0]?.method).toBe("POST");
  });

  it("leaves a failure of the transport's own as it is", async () => {
    const wrapped = withDeadline(
      async () => {
        throw new TypeError("Failed to fetch");
      },
      { requestMs: 20 },
    );
    await expect(wrapped("https://scholea.example.test/x")).rejects.toThrow("Failed to fetch");
  });

  it("still lets the caller cancel", async () => {
    const seen = { calls: 0, signal: undefined as AbortSignal | null | undefined };
    const wrapped = withDeadline(silent(seen), { requestMs: 60_000, abortable: true });
    const caller = new AbortController();

    const pending = wrapped("https://scholea.example.test/x", { signal: caller.signal });
    caller.abort(new Error("the person left the page"));
    await expect(pending).rejects.toThrow("the person left the page");
    expect(seen.signal?.aborted).toBe(true);
  });

  it("stops an answer whose body stops arriving", async () => {
    let transport: AbortSignal | null | undefined;
    const wrapped = withDeadline(
      async (_input, init) => {
        transport = init?.signal;
        // The first piece arrives, and then nothing more does.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"content":"'));
            init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
          },
        });
        return new Response(body, { status: 200 });
      },
      { requestMs: 20, answerMs: 20, abortable: true },
    );

    const answer = await wrapped("https://scholea.example.test/x");
    await expect(answer.text()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(transport?.aborted).toBe(true);
  });
});

describe("a backend that never answers", () => {
  it("fails a sync call as a connection problem instead of holding everything up", async () => {
    const seen = { calls: 0, signal: undefined as AbortSignal | null | undefined };
    const client = buildSupabaseClient({ url: "https://scholea.example.test", key: "sb_publishable_example" }, { fetch: silent(seen), deadline: { requestMs: 20 } })!;
    // Signed in, as far as the device knows: the session is read from the device, not from the backend.
    const now = Math.floor(Date.now() / 1000);
    const part = (v: object) => btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const session = {
      access_token: `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "user-ada", role: "authenticated", exp: now + 3600 })}.signature`,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: now + 3600,
      refresh_token: "refresh-token-value",
      user: { id: "user-ada", aud: "authenticated", email: "ada@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-02T03:04:05Z" },
    };
    try {
      const api = createSync({
        client: { auth: { getSession: async () => ({ data: { session }, error: null }) }, rpc: (fn, args) => syncClientOf(client)!.rpc(fn, args) },
        online: () => true,
      });

      const failure = await api.listProjects().then(
        () => null,
        (e: unknown) => e,
      );
      expect(failure).toBeInstanceOf(SyncError);
      expect(failure).toMatchObject({ code: "network", status: 0 });
      expect(seen.calls).toBe(1);
    } finally {
      await client.auth.dispose();
    }
  });
});
