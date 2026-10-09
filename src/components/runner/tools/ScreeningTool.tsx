import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Eye, EyeOff, Undo2, Users, X } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { useProject } from "@/lib/study/project-store";
import { demoRecords } from "@/lib/study/sr-demo-records";
import { cohenKappa } from "@/lib/stats/agreement";
import { DUR, EASE } from "@/lib/motion";
import type { StepData } from "@/lib/study/types";
import type { WorkRecord } from "@/lib/sources/types";

type Decision = "include" | "exclude";
type ReviewerKey = "r1" | "r2";
type Decisions = Record<string, Partial<Record<ReviewerKey, Decision>>>;

/**
 * Fast, keyboard-driven title/abstract screening.
 *   ← / E exclude · → / I include · U undo
 * Dual independent reviewers with optional blinding, and a live Cohen's kappa
 * readout so reviewers can calibrate. Decisions + summary counts persist to the
 * step's data (the summary feeds the PRISMA flow diagram).
 */
export function ScreeningTool({ stepId }: { stepId: string }) {
  const prefersReduced = useReducedMotion() ?? false;
  const project = useProject((s) => s.project);
  const setField = useProject((s) => s.setField);
  const persist = useProject((s) => s.persist);

  const data = (project?.stepData[stepId] as StepData) ?? {};
  const decisions = (data.decisions as Decisions) ?? {};

  // Screen the deduplicated set if present, else the raw search set, else the
  // demo records (before any search has been run).
  const dedupRecords = (project?.stepData["dedup"] as StepData)?.records as WorkRecord[] | undefined;
  const searchRecords = (project?.stepData["search"] as StepData)?.records as WorkRecord[] | undefined;
  const records: WorkRecord[] =
    dedupRecords?.length ? dedupRecords : searchRecords?.length ? searchRecords : demoRecords;

  const [reviewer, setReviewer] = useState<ReviewerKey>("r1");
  const [blinded, setBlinded] = useState(true);
  const [history, setHistory] = useState<string[]>([]);
  const [lastAction, setLastAction] = useState<Decision>("include");

  // Reset the (session-only) undo history when switching reviewer.
  useEffect(() => setHistory([]), [reviewer]);

  const other: ReviewerKey = reviewer === "r1" ? "r2" : "r1";
  const current = records.find((r) => !decisions[r.id]?.[reviewer]);
  const decidedCount = records.filter((r) => decisions[r.id]?.[reviewer]).length;
  // Live tally for the active reviewer.
  const includedCount = records.filter((r) => decisions[r.id]?.[reviewer] === "include").length;
  const excludedCount = decidedCount - includedCount;
  const remainingCount = records.length - decidedCount;

  // Summary counts from Reviewer 1 (the lead screener) — feeds PRISMA.
  const summarize = (d: Decisions) => {
    let inc = 0;
    let exc = 0;
    for (const id of Object.keys(d)) {
      if (d[id]?.r1 === "include") inc++;
      else if (d[id]?.r1 === "exclude") exc++;
    }
    return { nIncludedScreening: inc, nExcludedScreening: exc, nScreened: inc + exc };
  };

  const commit = useCallback(
    (next: Decisions) => {
      setField(stepId, "decisions", next);
      const s = summarize(next);
      setField(stepId, "nIncludedScreening", s.nIncludedScreening);
      setField(stepId, "nExcludedScreening", s.nExcludedScreening);
      setField(stepId, "nScreened", s.nScreened);
      void persist();
    },
    [setField, persist, stepId],
  );

  const decide = useCallback(
    (value: Decision) => {
      if (!current) return;
      setLastAction(value);
      const next: Decisions = {
        ...decisions,
        [current.id]: { ...decisions[current.id], [reviewer]: value },
      };
      setHistory((h) => [...h, current.id]);
      commit(next);
    },
    [current, decisions, reviewer, commit],
  );

  const undo = useCallback(() => {
    const lastId = history[history.length - 1];
    if (!lastId) return;
    const entry = { ...decisions[lastId] };
    delete entry[reviewer];
    const next: Decisions = { ...decisions, [lastId]: entry };
    setHistory((h) => h.slice(0, -1));
    commit(next);
  }, [history, decisions, reviewer, commit]);

  // Keyboard shortcuts.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (k === "arrowright" || k === "i") {
      decide("include");
      e.preventDefault();
    } else if (k === "arrowleft" || k === "e") {
      decide("exclude");
      e.preventDefault();
    } else if (k === "u" || k === "backspace") {
      undo();
      e.preventDefault();
    }
  };

  // Live kappa over records both reviewers have screened.
  const kappa = useMemo(() => {
    const pairs: Array<[string, string]> = [];
    for (const r of records) {
      const d = decisions[r.id];
      if (d?.r1 && d?.r2) pairs.push([d.r1, d.r2]);
    }
    return cohenKappa(pairs);
  }, [decisions, records]);

  const cardVariants = {
    initial: { opacity: 0, y: 18, scale: 0.98 },
    animate: { opacity: 1, y: 0, scale: 1, transition: { duration: DUR.short, ease: EASE.entrance } },
    exit: (dir: Decision) => ({
      x: dir === "include" ? 360 : -360,
      rotate: dir === "include" ? 6 : -6,
      opacity: 0,
      transition: { duration: DUR.short, ease: EASE.exit },
    }),
  };

  return (
    <div
      role="group"
      aria-label="Title and abstract screening"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-4 rounded-card outline-none focus-visible:focus-ring"
    >
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div role="radiogroup" aria-label="Reviewer" className="inline-flex rounded-pill border border-hairline bg-elevated/60 p-1">
          {(["r1", "r2"] as ReviewerKey[]).map((rk) => (
            <button
              key={rk}
              role="radio"
              aria-checked={reviewer === rk}
              onClick={() => setReviewer(rk)}
              className={`rounded-pill px-3 py-1 text-sm font-medium transition-colors focus-visible:focus-ring ${
                reviewer === rk ? "bg-primary text-ink-onBrand" : "text-ink-soft hover:text-ink"
              }`}
            >
              <Users className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
              Reviewer {rk === "r1" ? "1" : "2"}
            </button>
          ))}
        </div>

        <button
          onClick={() => setBlinded((v) => !v)}
          aria-pressed={blinded}
          className="inline-flex items-center gap-1.5 rounded-pill border border-hairline bg-elevated/60 px-3 py-1 text-sm text-ink-soft transition-colors hover:text-ink focus-visible:focus-ring"
        >
          {blinded ? <EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Eye className="h-3.5 w-3.5" aria-hidden="true" />}
          {blinded ? "Blinded" : "Unblinded"}
        </button>

        <KappaBadge kappa={kappa.kappa} band={kappa.interpretation} n={kappa.n} />

        {/* Live include/exclude tally for the active reviewer */}
        <span className="ml-auto flex items-center gap-1.5">
          <span className="num-tabular inline-flex items-center gap-1 rounded-pill bg-success-soft px-2.5 py-1 text-xs font-semibold text-success">
            <Check className="h-3.5 w-3.5" aria-hidden="true" /> {includedCount} included
          </span>
          <span className="num-tabular inline-flex items-center gap-1 rounded-pill bg-danger-soft px-2.5 py-1 text-xs font-semibold text-danger">
            <X className="h-3.5 w-3.5" aria-hidden="true" /> {excludedCount} excluded
          </span>
          <span className="num-tabular text-sm text-ink-soft" title={`${decidedCount} of ${records.length} screened`}>
            {remainingCount} left
          </span>
        </span>
      </div>

      {/* Card */}
      <div className="relative min-h-[15rem]">
        <AnimatePresence mode="wait" custom={lastAction}>
          {current ? (
            <motion.article
              key={current.id}
              custom={lastAction}
              variants={prefersReduced ? undefined : cardVariants}
              initial={prefersReduced ? undefined : "initial"}
              animate={prefersReduced ? undefined : "animate"}
              exit={prefersReduced ? undefined : "exit"}
              className="glass-1 glass-highlight flex flex-col gap-2 p-5"
            >
              <div className="flex items-center gap-2 text-xs text-ink-muted">
                <span className="num-tabular">{current.year}</span>
                <span aria-hidden="true">·</span>
                <span className="truncate">{current.journal}</span>
                {!blinded && decisions[current.id]?.[other] && (
                  <span
                    className={`ml-auto inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px] font-semibold ${
                      decisions[current.id]?.[other] === "include"
                        ? "bg-success-soft text-success"
                        : "bg-danger-soft text-danger"
                    }`}
                  >
                    Reviewer {other === "r1" ? "1" : "2"}: {decisions[current.id]?.[other]}
                  </span>
                )}
              </div>
              <h3 className="text-md font-bold leading-snug text-ink">{current.title}</h3>
              <p className="text-sm text-ink-muted">{current.authors.join(", ")}</p>
              {current.abstract && (
                <p className="mt-1 text-sm leading-relaxed text-ink-soft">{current.abstract}</p>
              )}
            </motion.article>
          ) : (
            <motion.div
              key="done"
              initial={prefersReduced ? undefined : { opacity: 0, y: 10 }}
              animate={prefersReduced ? undefined : { opacity: 1, y: 0 }}
              className="glass-1 grid min-h-[15rem] place-items-center p-6 text-center"
            >
              <div>
                <Check className="mx-auto mb-2 h-8 w-8 text-success" aria-hidden="true" />
                <p className="font-semibold text-ink">Screening complete for Reviewer {reviewer === "r1" ? "1" : "2"}</p>
                <p className="mt-1 text-sm text-ink-soft">
                  Switch reviewers to double-screen, or continue when both passes agree.
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-center gap-3">
        <GlassButton variant="soft" onClick={() => decide("exclude")} disabled={!current} aria-keyshortcuts="ArrowLeft E">
          <X className="h-4 w-4 text-danger" aria-hidden="true" />
          Exclude
        </GlassButton>
        <GlassButton variant="ghost" onClick={undo} disabled={history.length === 0} aria-keyshortcuts="U">
          <Undo2 className="h-4 w-4" aria-hidden="true" />
          Undo
        </GlassButton>
        <GlassButton variant="soft" onClick={() => decide("include")} disabled={!current} aria-keyshortcuts="ArrowRight I">
          <Check className="h-4 w-4 text-success" aria-hidden="true" />
          Include
        </GlassButton>
      </div>

      <p className="text-center text-xs text-ink-muted">
        Keyboard: <Kbd>←</Kbd>/<Kbd>E</Kbd> exclude · <Kbd>→</Kbd>/<Kbd>I</Kbd> include · <Kbd>U</Kbd> undo
      </p>
    </div>
  );
}

function KappaBadge({ kappa, band, n }: { kappa: number | null; band: string; n: number }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-pill bg-accent-soft px-2.5 py-1 text-sm font-medium text-accent"
      title={`Cohen's kappa over ${n} doubly-screened record${n === 1 ? "" : "s"}: ${band}`}
    >
      <span className="num-tabular font-semibold">κ {kappa == null ? "—" : kappa.toFixed(2)}</span>
      <span className="text-xs opacity-80">{n > 0 ? band : "needs both reviewers"}</span>
    </span>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">{children}</kbd>
  );
}
