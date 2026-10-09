import type { WorkerRequest, WorkerResponse } from "./protocol";
import type { EffectMeasure, StudyEffect } from "@/lib/stats/meta";

/** Distributes Omit across the request union so member-specific fields survive. */
type RequestPayload = WorkerRequest extends infer T
  ? T extends { id: number }
    ? Omit<T, "id">
    : never
  : never;

/**
 * Lazy client for the stats worker. The worker (and eventually the heavy
 * WebR/Pyodide WASM) is instantiated only on first use, so the initial bundle
 * stays light.
 */
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (res: WorkerResponse) => void>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./stats.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const resolve = pending.get(e.data.id);
    if (resolve) {
      pending.delete(e.data.id);
      resolve(e.data);
    }
  };
  return worker;
}

function call(req: RequestPayload): Promise<WorkerResponse> {
  const id = nextId++;
  const w = ensureWorker();
  return new Promise((resolve) => {
    pending.set(id, resolve);
    w.postMessage({ ...req, id } as WorkerRequest);
  });
}

export async function pingStatsWorker(): Promise<string> {
  const res = await call({ kind: "ping" });
  if (res.ok && res.kind === "ping") return res.runtime;
  throw new Error(res.ok ? "unexpected response" : res.error);
}

export async function computeDescriptives(values: number[]) {
  const res = await call({ kind: "descriptives", values });
  if (res.ok && res.kind === "descriptives") return res.result;
  throw new Error(res.ok ? "unexpected response" : res.error);
}

export async function runMetaAnalysis(effects: StudyEffect[], measure: EffectMeasure) {
  const res = await call({ kind: "meta", effects, measure });
  if (res.ok && res.kind === "meta") return res.result;
  throw new Error(res.ok ? "unexpected response" : res.error);
}

/** Release the worker (e.g. on teardown). */
export function terminateStatsWorker() {
  worker?.terminate();
  worker = null;
  pending.clear();
}
