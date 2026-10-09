import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, Compass, Info } from "lucide-react";
import { GlassPanel } from "@/components/glass";
import { useInstance } from "@/lib/instance/instance-store";
import { chooserNote, newStudyAllowList } from "@/lib/instance/instance-view";
import { filterFamilies } from "@/lib/instance/study-types";
import { configsByFamily } from "@/lib/study/registry";
import { staggerChild, staggerParent, withReduced, reducedFade } from "@/lib/motion";
import type { StudyTypeId } from "@/lib/db/schema";
import type { StudyFamily } from "@/lib/study/types";

const FAMILY_ACCENT: Record<StudyFamily, string> = {
  review: "text-primary bg-primary-soft",
  observational: "text-info bg-info-soft",
  experimental: "text-accent bg-accent-soft",
  diagnostic: "text-info bg-info-soft",
  qualitative: "text-success bg-success-soft",
  survey: "text-warning bg-warning-soft",
  mixed: "text-primary bg-primary-soft",
  report: "text-warning bg-warning-soft",
};

/**
 * The study-type chooser — the entry to the journey. Every type the engine can
 * run, grouped by family. Picking one creates a project and enters the runner.
 *
 * Someone signed in to an organisation that limits the types for new projects
 * is offered those, with a note saying so. A guest is offered every type, and
 * existing projects of any type are not touched by this.
 */
export function StudyChooser({ onPick }: { onPick: (id: StudyTypeId) => void }) {
  const prefersReduced = useReducedMotion() ?? false;
  const instance = useInstance((s) => s.instance);
  const families = filterFamilies(configsByFamily(), newStudyAllowList(instance));
  const note = chooserNote(instance);

  return (
    <GlassPanel className="mx-auto max-w-4xl p-6 sm:p-8" highlight>
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-input bg-primary text-ink-onBrand shadow-glow-primary">
          <Compass className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h1 className="font-display text-2xl font-bold text-ink">What are you researching?</h1>
          <p className="text-sm text-ink-soft">Pick a study type and Scholea will guide you, step by step.</p>
        </div>
      </div>

      {note && (
        <p role="note" className="mt-5 flex items-start gap-2 rounded-input bg-info-soft p-3 text-sm text-ink">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{note}</span>
        </p>
      )}

      {families.map((group) => (
        <section key={group.family} className="mt-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">{group.label}</h2>
          <motion.ul
            variants={withReduced(staggerParent, reducedFade, prefersReduced)}
            initial="hidden"
            animate="visible"
            className="grid gap-3 sm:grid-cols-2"
          >
            {group.configs.map((c) => (
              <motion.li key={c.id} variants={withReduced(staggerChild, reducedFade, prefersReduced)}>
                <button
                  onClick={() => onPick(c.id as StudyTypeId)}
                  className="group flex w-full items-center gap-3 rounded-card border border-hairline bg-elevated/50 p-4 text-left transition-colors hover:border-strong hover:bg-primary-soft focus-visible:focus-ring"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-ink">{c.label}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className={`rounded-pill px-2 py-0.5 text-[11px] font-semibold ${FAMILY_ACCENT[c.family]}`}>
                        {c.reportingStandard}
                      </span>
                      <span className="num-tabular text-xs text-ink-muted">{c.steps.length} steps</span>
                    </div>
                  </div>
                  <ArrowRight
                    className="h-4 w-4 shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
                    aria-hidden="true"
                  />
                </button>
              </motion.li>
            ))}
          </motion.ul>
        </section>
      ))}

      <p className="mt-6 text-xs text-ink-muted">
        Every type above runs on the same engine. Each is authored as config and content, never engine code.
      </p>
    </GlassPanel>
  );
}
