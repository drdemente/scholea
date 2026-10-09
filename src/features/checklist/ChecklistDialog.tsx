import { motion } from "framer-motion";
import { ListChecks, X, ExternalLink } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { useProject } from "@/lib/study/project-store";
import { checklistFor, checklistTotal } from "@/lib/checklist/checklists";

const CHECKED_STEP = "__checklist"; // pseudo-step namespace for checklist state

/**
 * Reporting-standard checklist for the active project's standard, with live
 * completion. Items are tickable and persist with the project. A working aid —
 * confirm against the official EQUATOR instrument before submission.
 */
export function ChecklistDialog({ onClose }: { onClose: () => void }) {
  const project = useProject((s) => s.project);
  const config = useProject((s) => s.config);
  const setField = useProject((s) => s.setField);
  const persist = useProject((s) => s.persist);

  if (!project || !config) return null;
  const sections = checklistFor(config.reportingStandard);
  const total = checklistTotal(sections);
  const checked = (project.stepData[CHECKED_STEP] as Record<string, boolean>) ?? {};
  const done = sections.reduce((n, sec) => n + sec.items.filter((i) => checked[i.id]).length, 0);
  const pct = total ? Math.round((done / total) * 100) : 0;

  const toggle = (id: string) => {
    setField(CHECKED_STEP, id, !checked[id]);
    void persist();
  };

  return (
    <motion.div className="fixed inset-0 z-modal overflow-y-auto p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <button aria-label="Close" className="fixed inset-0 -z-10 bg-scrim" onClick={onClose} />
      <div className="mx-auto my-6 w-full max-w-2xl">
        <div className="glass-2 glass-highlight rounded-modal p-5 sm:p-6">
          <div className="mb-3 flex items-center gap-2">
            <ListChecks className="h-5 w-5 text-primary" aria-hidden="true" />
            <div className="mr-auto">
              <h2 className="text-lg font-bold text-ink">Reporting checklist</h2>
              <p className="text-xs text-ink-muted">{config.reportingStandard === "NONE" ? "General reporting" : config.reportingStandard}</p>
            </div>
            <GlassButton variant="ghost" size="sm" aria-label="Close" onClick={onClose} className="!px-2">
              <X className="h-5 w-5" aria-hidden="true" />
            </GlassButton>
          </div>

          {/* Completion */}
          <div className="mb-4">
            <div className="flex items-center justify-between text-sm text-ink-soft">
              <span>{done} of {total} items marked</span>
              <span className="num-tabular text-ink-muted">{pct}%</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-pill bg-elevated" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Checklist completion">
              <div className={`h-full rounded-pill ${pct === 100 ? "bg-success" : "bg-primary"}`} style={{ width: `${pct}%` }} />
            </div>
          </div>

          <div className="flex flex-col gap-4">
            {sections.map((sec) => (
              <section key={sec.title}>
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">{sec.title}</h3>
                <ul className="flex flex-col gap-1">
                  {sec.items.map((item) => (
                    <li key={item.id}>
                      <label className="flex cursor-pointer items-start gap-2.5 rounded-input px-2 py-1.5 hover:bg-elevated/50">
                        <input
                          type="checkbox"
                          checked={!!checked[item.id]}
                          onChange={() => toggle(item.id)}
                          className="mt-0.5 h-4 w-4 shrink-0 rounded-[5px] accent-[var(--color-primary)] focus-visible:focus-ring"
                        />
                        <span className={`text-sm ${checked[item.id] ? "text-ink-muted line-through" : "text-ink"}`}>{item.text}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

          <p className="mt-4 flex items-start gap-2 rounded-input bg-info-soft p-3 text-xs text-ink">
            <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" aria-hidden="true" />
            A condensed working aid, paraphrased. It is not the official instrument. Confirm against the full checklist at
            equator-network.org before submission.
          </p>
        </div>
      </div>
    </motion.div>
  );
}
