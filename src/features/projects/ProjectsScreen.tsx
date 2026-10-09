import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Plus, FolderOpen, CheckCircle2, Clock, Trash2, ArrowRight, Cloud, CloudUpload, HardDrive, Users } from "lucide-react";
import { GlassPanel, GlassButton, GlassOverlay } from "@/components/glass";
import { ErrorNote, toast } from "@/components/ui";
import { AccountBanners } from "@/features/auth/AccountBanner";
import { Portal } from "@/features/auth/Portal";
import { InvitationList } from "@/features/collab/InvitationList";
import { CHIP_LABEL, adoptableIds, deleteCopy, deletionNotice, describeDeleteError, projectChip, type ProjectChip } from "@/lib/account/account-view";
import { useSession } from "@/lib/account/session-store";
import { getLink, isVisible, subscribeLinks } from "@/lib/collab/links";
import { deleteProjectEverywhere, deletionEffect, useSyncStatus } from "@/lib/collab/project-sync";
import { useProject } from "@/lib/study/project-store";
import { configById } from "@/lib/study/registry";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { staggerChild, staggerParent, withReduced, reducedFade } from "@/lib/motion";
import type { Project } from "@/lib/db/schema";

interface ProjectView {
  project: Project;
  label: string;
  standard: string;
  total: number;
  done: number;
  completed: boolean;
}

function describe(p: Project): ProjectView {
  const config = configById(p.studyType);
  const total = config?.steps.length ?? 0;
  const done = config ? config.steps.filter((s) => p.stepStatus[s.id]?.complete).length : 0;
  return {
    project: p,
    label: config?.label ?? p.studyType,
    standard: config?.reportingStandard ?? "",
    total,
    done,
    completed: total > 0 && done === total,
  };
}

/** Goes up whenever a project's link to an account changes, here or in another window. */
function useLinksVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => subscribeLinks(() => setVersion((v) => v + 1)), []);
  return version;
}

/**
 * Projects landing — the app's home. Lists every saved project with its progress
 * and a completed / in-progress marker, so the researcher can resume or switch
 * between several studies at any time. Each study keeps its own saved state.
 *
 * With an account in play the list follows one rule: projects in an account
 * show only while that account is the one this device shows; projects kept on
 * this device always show. The banners above the list and the chip on each card
 * say which is which. A build with no backend shows neither.
 */
export function ProjectsScreen({
  activeId,
  onOpen,
  onNew,
}: {
  activeId?: string;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const prefersReduced = useReducedMotion() ?? false;
  const listProjects = useProject((s) => s.listProjects);
  const phase = useSession((s) => s.phase);
  const deviceAccountId = useSession((s) => s.deviceAccount?.id ?? null);
  const signedInId = useSession((s) => (s.phase === "ready" ? (s.profile?.id ?? null) : null));
  // Sync runs in the background and changes projects and their links as it goes.
  const syncRevision = useSyncStatus((s) => s.revision);
  const linksVersion = useLinksVersion();

  // Takes the focus when the invitations above the list are all answered and that section goes.
  const heading = useRef<HTMLHeadingElement>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [confirm, setConfirm] = useState<Project | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const listing = useRef(0);
  const refresh = useCallback(() => {
    const mine = ++listing.current;
    void listProjects().then((all) => {
      // A later listing has started: its answer is the one to show.
      if (mine === listing.current) setProjects(all);
    });
  }, [listProjects]);
  useEffect(refresh, [refresh, deviceAccountId, syncRevision]);

  const views = useMemo(
    () => projects?.filter((p) => isVisible(getLink(p.id), deviceAccountId)).map(describe) ?? null,
    // The links are read from the device; `linksVersion` says when they changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, deviceAccountId, linksVersion],
  );

  // Projects that were here before the person signed in and have not been
  // offered to the account yet.
  const adoptable = useMemo(
    () =>
      phase === "ready" && views
        ? adoptableIds(
            views.map((v) => v.project.id),
            getLink,
          )
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [phase, views, linksVersion],
  );

  const askDelete = (project: Project) => {
    setDeleteError(null);
    setConfirm(project);
  };
  // Stable, so the open dialog keeps its focus when the list behind it re-renders.
  const cancelDelete = useCallback(() => setConfirm(null), []);

  const confirmLink = confirm ? getLink(confirm.id) : null;
  const effect = deletionEffect(confirmLink);
  // Whether the account the project is in can be told now, or only at the next sync.
  const reachable = confirmLink?.kind !== "account" || (confirmLink.owner === signedInId && (typeof navigator === "undefined" || navigator.onLine !== false));
  const copy = deleteCopy(effect, reachable);

  const remove = async () => {
    if (!confirm) return;
    setBusy(true);
    setDeleteError(null);
    try {
      // What is on screen is what was agreed to: nothing more than that is done,
      // even if the project's place in the account has changed since.
      const result = await deleteProjectEverywhere(confirm.id, effect);
      const notice = deletionNotice(effect, result);
      toast[notice.kind](notice.text);
      setConfirm(null);
      refresh();
    } catch (e) {
      // Nothing was removed.
      setDeleteError(describeDeleteError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <GlassPanel className="mx-auto max-w-5xl p-6 sm:p-8" highlight>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-input bg-primary text-ink-onBrand shadow-glow-primary">
            <FolderOpen className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h1 ref={heading} tabIndex={-1} className="rounded-input font-display text-2xl font-bold text-ink outline-none focus-visible:focus-ring">
              Your projects
            </h1>
            <p className="text-sm text-ink-soft">Pick up where you left off, or start a new study. Progress saves automatically.</p>
          </div>
        </div>
        <GlassButton onClick={onNew}>
          <Plus className="h-4 w-4" aria-hidden="true" /> New study
        </GlassButton>
      </div>

      <div className="mt-6">
        {isSupabaseConfigured && <AccountBanners adoptable={adoptable} />}
        {/* Invitations to other people's projects. An accepted one is downloaded, then listed below. */}
        {isSupabaseConfigured && phase === "ready" && <InvitationList onAccepted={refresh} focusAfter={heading} />}

        {views === null ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {[0, 1].map((i) => (
              <div key={i} className="glass-1 h-40 animate-pulse rounded-card" />
            ))}
          </div>
        ) : views.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-hairline px-6 py-14 text-center">
            <FolderOpen className="h-8 w-8 text-ink-muted" aria-hidden="true" />
            <p className="font-semibold text-ink">No projects yet</p>
            <p className="max-w-sm text-sm text-ink-soft">Start your first study. Scholea will guide you step by step and keep your progress safe.</p>
            <GlassButton onClick={onNew} className="mt-1">
              <Plus className="h-4 w-4" aria-hidden="true" /> Start a study
            </GlassButton>
          </div>
        ) : (
          <motion.ul
            variants={withReduced(staggerParent, reducedFade, prefersReduced)}
            initial="hidden"
            animate="visible"
            className="grid gap-4 sm:grid-cols-2"
          >
            {views.map((v) => (
              <motion.li key={v.project.id} variants={withReduced(staggerChild, reducedFade, prefersReduced)}>
                <ProjectCard
                  view={v}
                  active={v.project.id === activeId}
                  chip={isSupabaseConfigured ? projectChip(getLink(v.project.id)) : null}
                  onOpen={() => onOpen(v.project.id)}
                  onDelete={() => askDelete(v.project)}
                />
              </motion.li>
            ))}
          </motion.ul>
        )}
      </div>

      {/* Delete confirmation. What it does beyond this device depends on whose project it is.
          Rendered at the end of the page: this panel is glass, and a dialog inside it would be laid out to the panel. */}
      <Portal>
        <GlassOverlay open={!!confirm} onClose={cancelDelete} labelledBy="del-proj-title" className="grid place-items-center p-4">
          <div className="glass-2 glass-highlight w-full max-w-md rounded-modal p-5">
            <h2 id="del-proj-title" className="text-lg font-bold text-ink">{copy.heading}</h2>
            <p className="mt-2 text-sm text-ink-soft">
              <strong className="text-ink">{confirm?.title}</strong> {copy.rest}
            </p>
            {copy.later && <p className="mt-2 text-sm text-ink-soft">{copy.later}</p>}
            {deleteError && (
              <div className="mt-3">
                <ErrorNote>{deleteError}</ErrorNote>
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <GlassButton variant="ghost" size="sm" onClick={cancelDelete}>Cancel</GlassButton>
              <GlassButton size="sm" loading={busy} onClick={remove} className="!bg-danger hover:!brightness-110">{copy.confirmLabel}</GlassButton>
            </div>
          </div>
        </GlassOverlay>
      </Portal>
    </GlassPanel>
  );
}

const CHIP_ICON: Record<ProjectChip, typeof Cloud> = { device: HardDrive, waiting: CloudUpload, account: Cloud, shared: Users };

function ProjectCard({
  view,
  active,
  chip,
  onOpen,
  onDelete,
}: {
  view: ProjectView;
  active: boolean;
  /** Where the project lives, or `null` in a build with no accounts. */
  chip: ProjectChip | null;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { project, label, standard, total, done, completed } = view;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const ChipIcon = chip ? CHIP_ICON[chip] : null;

  return (
    <div className="glass-1 flex h-full flex-col gap-3 rounded-card p-4">
      {/* Status marker, in front of the name */}
      <div className="flex items-center justify-between gap-2">
        {completed ? (
          <span className="inline-flex items-center gap-1 rounded-pill bg-success-soft px-2 py-0.5 text-xs font-semibold text-success">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Completed
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-pill bg-primary-soft px-2 py-0.5 text-xs font-semibold text-primary">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" /> In progress
          </span>
        )}
        {active && (
          <span className="rounded-pill bg-accent-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">Active</span>
        )}
      </div>

      <div className="min-w-0">
        <h3 className="truncate text-base font-bold text-ink" title={project.title}>{project.title}</h3>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
          <span className="font-medium text-ink-soft">{label}</span>
          {standard && <span className="inline-flex items-center rounded-pill bg-elevated/70 px-1.5 py-0.5">{standard}</span>}
          {chip && ChipIcon && (
            <span className="inline-flex items-center gap-1 rounded-pill bg-elevated/70 px-1.5 py-0.5 text-ink-soft">
              <ChipIcon className="h-3 w-3 shrink-0" aria-hidden="true" /> {CHIP_LABEL[chip]}
            </span>
          )}
        </p>
      </div>

      {/* Progress */}
      <div className="mt-auto">
        <div className="flex items-center justify-between text-xs text-ink-soft">
          <span className="num-tabular">{done} of {total} steps</span>
          <span className="num-tabular text-ink-muted">{pct}%</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-pill bg-elevated" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${project.title} progress`}>
          <div className={`h-full rounded-pill ${completed ? "bg-success" : "bg-primary"}`} style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <GlassButton size="sm" onClick={onOpen} className="flex-1 justify-center">
          {completed ? "Review" : "Continue"}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </GlassButton>
        <button
          onClick={onDelete}
          aria-label={`Delete ${project.title}`}
          title="Delete project"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-input text-ink-muted transition-colors hover:bg-elevated hover:text-danger focus-visible:focus-ring"
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
