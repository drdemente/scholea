/** Message protocol shared between the main thread and the stats worker. */
import type { EffectMeasure, MetaResult, StudyEffect } from "@/lib/stats/meta";

export type WorkerRequest =
  | { id: number; kind: "ping" }
  | { id: number; kind: "descriptives"; values: number[] }
  | { id: number; kind: "meta"; effects: StudyEffect[]; measure: EffectMeasure };

export type WorkerResponse =
  | { id: number; ok: true; kind: "ping"; runtime: string }
  | {
      id: number;
      ok: true;
      kind: "descriptives";
      result: { n: number; mean: number; sd: number; min: number; max: number };
    }
  | { id: number; ok: true; kind: "meta"; result: MetaResult }
  | { id: number; ok: false; error: string };
