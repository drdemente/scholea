import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Info, Share2, Users, X, Activity as ActivityIcon } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { useProject } from "@/lib/study/project-store";
import { listActivity, summarizeContributions, describeAction, formatWhen } from "@/lib/collab/collab";
import { useLink } from "@/lib/collab/links";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { useUI } from "@/lib/ui-store";
import type { AuditEntry } from "@/lib/db/schema";

/**
 * Contribution ledger (§10) — the project's "who did what", derived from the
 * local audit log. Works offline. It is what was done on this device: the
 * activity of a whole team, for a project in an account, is in Share.
 */
export function ActivityDialog({ onClose }: { onClose: () => void }) {
  const project = useProject((s) => s.project);
  const link = useLink(project?.id);
  const openShare = useUI((s) => s.openShare);
  // Only a build with an account backend has a Share dialog to point to.
  const inAccount = isSupabaseConfigured && link?.kind === "account";
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);

  useEffect(() => {
    if (project) void listActivity(project.id).then(setEntries);
  }, [project]);

  const contributors = useMemo(() => (entries ? summarizeContributions(entries) : []), [entries]);
  if (!project) return null;

  return (
    <motion.div
      className="fixed inset-0 z-modal overflow-y-auto p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <button aria-label="Close" className="fixed inset-0 -z-10 bg-scrim" onClick={onClose} />
      <div className="mx-auto my-6 w-full max-w-2xl">
        <div className="glass-2 glass-highlight rounded-modal p-5 sm:p-6">
          <div className="mb-4 flex items-center gap-2">
            <ActivityIcon className="h-5 w-5 text-primary" aria-hidden="true" />
            <h2 className="mr-auto text-lg font-bold text-ink">Activity &amp; contributions</h2>
            <GlassButton variant="ghost" size="sm" aria-label="Close" onClick={onClose} className="!px-2">
              <X className="h-5 w-5" aria-hidden="true" />
            </GlassButton>
          </div>

          {/* A project in an account also has a team ledger, kept by the account */}
          {inAccount && (
            <div className="mb-5 flex flex-wrap items-center gap-2 rounded-input bg-info-soft p-3">
              <p className="mr-auto flex items-start gap-2 text-sm text-ink">
                <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>This is what was done on this device. Your team's shared activity is in Share.</span>
              </p>
              <GlassButton
                variant="ghost"
                size="sm"
                onClick={() => {
                  onClose();
                  openShare();
                }}
              >
                <Share2 className="h-4 w-4" aria-hidden="true" /> Open Share
              </GlassButton>
            </div>
          )}

          {/* Contributors summary */}
          <section aria-label="Contributors" className="mb-5">
            <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink">
              <Users className="h-4 w-4 text-ink-soft" aria-hidden="true" /> Contributors
            </h3>
            {contributors.length === 0 ? (
              <p className="text-sm text-ink-muted">No recorded activity yet.</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {contributors.map((c) => (
                  <li key={c.actor} className="flex items-center gap-2 rounded-pill bg-elevated/60 px-2.5 py-1 text-sm">
                    <span className="grid h-6 w-6 place-items-center rounded-full bg-primary-soft text-xs font-bold text-primary">
                      {c.actor[0]?.toUpperCase()}
                    </span>
                    <span className="font-medium text-ink">{c.actor}</span>
                    <span className="num-tabular text-xs text-ink-muted">{c.count} action{c.count === 1 ? "" : "s"}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Activity feed */}
          <section aria-label="Activity feed">
            <h3 className="mb-2 text-sm font-semibold text-ink">Activity</h3>
            {entries === null ? (
              <p className="text-sm text-ink-muted">Loading…</p>
            ) : entries.length === 0 ? (
              <p className="text-sm text-ink-muted">Nothing here yet. Your work will be recorded as you go.</p>
            ) : (
              <ol className="relative ml-2 flex flex-col gap-3 border-l border-hairline pl-4">
                {entries.map((e, i) => (
                  <li key={e.id ?? i} className="relative">
                    <span className="absolute -left-[1.4rem] top-1 h-2 w-2 rounded-full bg-primary" aria-hidden="true" />
                    <p className="text-sm text-ink">
                      <span className="font-semibold">{e.actor}</span> {describeAction(e.action)}
                      {e.detail && e.action !== "project.create" && (
                        <span className="text-ink-muted">: {e.detail}</span>
                      )}
                    </p>
                    <p className="text-xs text-ink-muted">{formatWhen(e.timestamp)}</p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </motion.div>
  );
}
