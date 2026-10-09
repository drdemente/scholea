/// <reference lib="webworker" />
/**
 * Scholea — stats Web Worker (off the main thread; UI never blocks).
 *
 * STEP-1 SCAFFOLD: heavy runtimes load lazily here in later stages —
 *   • WebR + `metafor` for meta-analysis (gold standard)
 *   • Pyodide (numpy/scipy/statsmodels/pingouin) for general stats
 * For now it answers `ping` and computes simple descriptives so the
 * message-passing + lazy-instantiation infrastructure is proven end-to-end.
 * No statistical math beyond trivial descriptives ships until the validated
 * libraries are wired and unit-tested against published reference output (§6).
 */
import type { WorkerRequest, WorkerResponse } from "./protocol";
import { descriptives } from "@/lib/stats/descriptives";
import { metaAnalyze } from "@/lib/stats/meta";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    if (msg.kind === "ping") {
      const res: WorkerResponse = { id: msg.id, ok: true, kind: "ping", runtime: "worker-ready" };
      ctx.postMessage(res);
      return;
    }
    if (msg.kind === "descriptives") {
      const res: WorkerResponse = {
        id: msg.id,
        ok: true,
        kind: "descriptives",
        result: descriptives(msg.values),
      };
      ctx.postMessage(res);
      return;
    }
    if (msg.kind === "meta") {
      const res: WorkerResponse = {
        id: msg.id,
        ok: true,
        kind: "meta",
        result: metaAnalyze(msg.effects, msg.measure),
      };
      ctx.postMessage(res);
      return;
    }
  } catch (err) {
    const res: WorkerResponse = {
      id: (msg as { id: number }).id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    ctx.postMessage(res);
  }
};
