import { Check, CheckCheck, Info, X } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { SourceChip } from "./SourceChip";
import { useProject } from "@/lib/study/project-store";
import { screeningIncludes } from "@/lib/study/included";
import type { StepData } from "@/lib/study/types";
import type { WorkRecord } from "@/lib/sources/types";

type FtDecision = { d: "include" | "exclude"; reason?: string };
type FtDecisions = Record<string, FtDecision>;

/** Common PRISMA-style full-text exclusion reasons (suggestions, free text allowed). */
const COMMON_REASONS = [
  "Wrong population",
  "Wrong intervention",
  "Wrong comparator",
  "No usable outcome",
  "Wrong study design",
  "Duplicate report",
  "Full text not retrievable",
  "Not in an eligible language",
];

/**
 * Full-text eligibility. Lists every record included at title/abstract
 * screening; each is confirmed (include) or excluded with an individual,
 * recorded reason. Auto-derives the PRISMA counts (nFullTextExcluded +
 * exclusionReasons) and publishes the final `includedRecords` that the
 * appraisal and synthesis steps consume.
 */
export function FulltextTool({ stepId }: { stepId: string }) {
  const project = useProject((s) => s.project);
  const setField = useProject((s) => s.setField);
  const persist = useProject((s) => s.persist);

  const data = (project?.stepData[stepId] as StepData) ?? {};
  const decisions = (data.ftDecisions as FtDecisions) ?? {};
  const pool: WorkRecord[] = project ? screeningIncludes(project) : [];

  const commit = (next: FtDecisions) => {
    const excluded = pool.filter((r) => next[r.id]?.d === "exclude");
    const included = pool.filter((r) => next[r.id]?.d === "include");
    const reasons = Array.from(
      new Set(excluded.map((r) => next[r.id]?.reason?.trim()).filter((s): s is string => !!s)),
    );
    setField(stepId, "ftDecisions", next);
    setField(stepId, "nFullTextExcluded", excluded.length);
    setField(stepId, "exclusionReasons", reasons);
    setField(stepId, "includedRecords", included);
    void persist();
  };

  const setDecision = (id: string, d: "include" | "exclude") => {
    const live = ((useProject.getState().project?.stepData[stepId] as StepData)?.ftDecisions as FtDecisions) ?? {};
    commit({ ...live, [id]: { ...live[id], d } });
  };

  const setReason = (id: string, reason: string) => {
    const live = ((useProject.getState().project?.stepData[stepId] as StepData)?.ftDecisions as FtDecisions) ?? {};
    commit({ ...live, [id]: { ...live[id], d: live[id]?.d ?? "exclude", reason } });
  };

  const includeRemaining = () => {
    const next: FtDecisions = { ...decisions };
    for (const r of pool) if (!next[r.id]?.d) next[r.id] = { d: "include" };
    commit(next);
  };

  // No screened inclusions yet (e.g. screening skipped) — manual fallback.
  if (pool.length === 0) {
    return (
      <div className="flex flex-col gap-2 rounded-input bg-info-soft p-3 text-sm text-ink">
        <p className="flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden="true" />
          No records have been included at screening yet. Complete the screening step and your included studies will
          appear here for full-text checking — or enter the excluded count manually below.
        </p>
        <label className="flex items-center gap-2 text-sm">
          Reports excluded at full text
          <input
            type="number"
            min={0}
            value={data.nFullTextExcluded == null ? "" : String(data.nFullTextExcluded)}
            onChange={(e) => {
              setField(stepId, "nFullTextExcluded", e.target.value === "" ? undefined : Number(e.target.value));
              void persist();
            }}
            className="num-tabular w-24 rounded-input border border-hairline bg-elevated/70 px-2 py-1 text-sm text-ink outline-none focus-visible:focus-ring"
          />
        </label>
      </div>
    );
  }

  const decided = pool.filter((r) => decisions[r.id]?.d);
  const included = pool.filter((r) => decisions[r.id]?.d === "include");
  const excluded = pool.filter((r) => decisions[r.id]?.d === "exclude");
  const missingReason = excluded.filter((r) => !decisions[r.id]?.reason?.trim());

  return (
    <div className="flex flex-col gap-3">
      {/* Tally */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="num-tabular inline-flex items-center gap-1 rounded-pill bg-success-soft px-2.5 py-1 text-xs font-semibold text-success">
          <Check className="h-3.5 w-3.5" aria-hidden="true" /> {included.length} included
        </span>
        <span className="num-tabular inline-flex items-center gap-1 rounded-pill bg-danger-soft px-2.5 py-1 text-xs font-semibold text-danger">
          <X className="h-3.5 w-3.5" aria-hidden="true" /> {excluded.length} excluded
        </span>
        <span className="num-tabular text-sm text-ink-soft">{pool.length - decided.length} to assess</span>
        {pool.length - decided.length > 0 && (
          <GlassButton variant="ghost" size="sm" onClick={includeRemaining} className="ml-auto">
            <CheckCheck className="h-4 w-4" aria-hidden="true" /> Include remaining
          </GlassButton>
        )}
      </div>

      <datalist id="ft-reasons">
        {COMMON_REASONS.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>

      {/* Per-study eligibility list */}
      <ul className="flex max-h-[28rem] flex-col divide-y divide-[var(--divider)] overflow-y-auto rounded-input border border-hairline">
        {pool.map((r) => {
          const d = decisions[r.id];
          return (
            <li key={r.id} className="flex flex-col gap-2 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{r.title}</p>
                  <p className="num-tabular mt-0.5 text-xs text-ink-muted">
                    {[r.authors[0], r.year, r.journal].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <SourceChip source={r.source} />
                  <div role="radiogroup" aria-label={`Full-text decision for ${r.title}`} className="inline-flex rounded-pill border border-hairline bg-elevated/60 p-0.5">
                    <button
                      role="radio"
                      aria-checked={d?.d === "include"}
                      onClick={() => setDecision(r.id, "include")}
                      className={`rounded-pill px-2.5 py-0.5 text-xs font-semibold transition-colors focus-visible:focus-ring ${
                        d?.d === "include" ? "bg-success text-ink-onBrand" : "text-ink-soft hover:text-ink"
                      }`}
                    >
                      Include
                    </button>
                    <button
                      role="radio"
                      aria-checked={d?.d === "exclude"}
                      onClick={() => setDecision(r.id, "exclude")}
                      className={`rounded-pill px-2.5 py-0.5 text-xs font-semibold transition-colors focus-visible:focus-ring ${
                        d?.d === "exclude" ? "bg-danger text-ink-onBrand" : "text-ink-soft hover:text-ink"
                      }`}
                    >
                      Exclude
                    </button>
                  </div>
                </div>
              </div>
              {d?.d === "exclude" && (
                <input
                  list="ft-reasons"
                  value={d.reason ?? ""}
                  onChange={(e) => setReason(r.id, e.target.value)}
                  placeholder="Reason for exclusion (required for PRISMA)…"
                  aria-label={`Exclusion reason for ${r.title}`}
                  className={`w-full rounded-input border bg-elevated/70 px-3 py-1.5 text-sm text-ink outline-none focus-visible:focus-ring ${
                    d.reason?.trim() ? "border-hairline" : "border-danger"
                  }`}
                />
              )}
            </li>
          );
        })}
      </ul>

      {missingReason.length > 0 && (
        <p className="rounded-input bg-warning-soft p-2.5 text-xs text-ink">
          {missingReason.length} excluded {missingReason.length === 1 ? "study needs" : "studies need"} a reason — every
          full-text exclusion is reported with its reason in the PRISMA flow.
        </p>
      )}

      {/* Excluded list summary (what the report will show) */}
      {excluded.length > 0 && (
        <details className="rounded-input bg-elevated/40 p-3 text-sm">
          <summary className="cursor-pointer font-semibold text-ink">
            Excluded at full text ({excluded.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-1 text-ink-soft">
            {excluded.map((r) => (
              <li key={r.id} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate">{r.title}</span>
                <span className="shrink-0 text-xs text-ink-muted">{decisions[r.id]?.reason?.trim() || "no reason yet"}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
