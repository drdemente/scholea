import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Activity, BookOpen, Cloud, Eye, FileText, FolderOpen, HelpCircle, ListChecks, Moon, Plus, ScrollText, Settings, Share2, ShieldCheck, Sun } from "lucide-react";
import { AppShell } from "@/components/shell/AppShell";
import { Wordmark } from "@/components/shell/Wordmark";
import { BackgroundMesh, GlassButton, GlassPanel } from "@/components/glass";
import { StepRunner } from "@/components/runner/StepRunner";
import { AccountMenu } from "@/features/auth/AccountMenu";
import { SignOutDialog } from "@/features/auth/SignOutDialog";
import { StudyChooser } from "@/features/chooser/StudyChooser";
import { ProjectsScreen } from "@/features/projects/ProjectsScreen";
import { PaperDialog } from "@/features/paper/PaperDialog";
import { EthicsDialog } from "@/features/ethics/EthicsDialog";
import { ActivityDialog } from "@/features/collab/ActivityDialog";
import { ShareDialog } from "@/features/collab/ShareDialog";
import { ChecklistDialog } from "@/features/checklist/ChecklistDialog";
import { HelpDialog } from "@/features/help/HelpDialog";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import type { Command } from "@/components/shell/CommandPalette";
import { useAuthUi } from "@/lib/account/auth-ui";
import { useSession } from "@/lib/account/session-store";
import { useLink } from "@/lib/collab/links";
import { SAVE_BADGE_LABEL, VIEW_ONLY_NOTICE, isViewOnly, saveBadge, type SaveBadge } from "@/lib/collab/share-view";
import { startInstanceSync, useInstance } from "@/lib/instance/instance-store";
import { newStudyAllowList } from "@/lib/instance/instance-view";
import { isStudyTypeAllowed } from "@/lib/instance/study-types";
import { useProject } from "@/lib/study/project-store";
import { derivePathway } from "@/lib/study/pathway";
import { useTheme, type Level } from "@/lib/theme/theme-store";
import { useUI } from "@/lib/ui-store";
import { useSettings } from "@/lib/settings/settings-store";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import type { StudyTypeId } from "@/lib/db/schema";

/**
 * Runs once the command palette has left the page.
 *
 * When the palette has finished closing, a moment after a command ran, it
 * hands the focus back to wherever it came from, usually a field of the open
 * step. A dialog the command opened in the meantime would lose the focus it
 * took, and whatever is typed next (an email address, a password) would land
 * in that field behind it. So a command that opens such a dialog waits for
 * the palette to go first. `cmdk-list` is the palette's own list.
 */
function afterPalette(run: () => void): void {
  const deadline = Date.now() + 1000;
  const check = () => {
    if (!document.getElementById("cmdk-list") || Date.now() > deadline) run();
    else requestAnimationFrame(check);
  };
  requestAnimationFrame(check);
}

export function StudyRunner() {
  const setLevel = useTheme((s) => s.setLevel);
  const toggleMode = useTheme((s) => s.toggleMode);
  const openSettings = useUI((s) => s.openSettings);
  const openChooser = useUI((s) => s.openChooser);
  const closeChooser = useUI((s) => s.closeChooser);
  const chooserOpen = useUI((s) => s.chooserOpen);
  const openPaper = useUI((s) => s.openPaper);
  const closePaper = useUI((s) => s.closePaper);
  const paperOpen = useUI((s) => s.paperOpen);
  const openEthics = useUI((s) => s.openEthics);
  const closeEthics = useUI((s) => s.closeEthics);
  const ethicsOpen = useUI((s) => s.ethicsOpen);
  const openActivity = useUI((s) => s.openActivity);
  const closeActivity = useUI((s) => s.closeActivity);
  const activityOpen = useUI((s) => s.activityOpen);
  const openShare = useUI((s) => s.openShare);
  const closeShare = useUI((s) => s.closeShare);
  const shareOpen = useUI((s) => s.shareOpen);
  const openChecklist = useUI((s) => s.openChecklist);
  const closeChecklist = useUI((s) => s.closeChecklist);
  const checklistOpen = useUI((s) => s.checklistOpen);
  const openHelp = useUI((s) => s.openHelp);
  const closeHelp = useUI((s) => s.closeHelp);
  const helpOpen = useUI((s) => s.helpOpen);
  const settingsOpen = useUI((s) => s.settingsOpen);
  const closeSettings = useUI((s) => s.closeSettings);
  const loadSettings = useSettings((s) => s.load);

  const project = useProject((s) => s.project);
  const config = useProject((s) => s.config);
  const activeStepId = useProject((s) => s.activeStepId);
  const loading = useProject((s) => s.loading);
  const loadActive = useProject((s) => s.loadActive);
  const createProject = useProject((s) => s.createProject);
  const switchProject = useProject((s) => s.switchProject);
  const persist = useProject((s) => s.persist);
  const setActiveStep = useProject((s) => s.setActiveStep);

  // The optional account. A build with no backend has none of this: no Share,
  // no account commands, and the phase never leaves "unconfigured".
  const phase = useSession((s) => s.phase);
  const signedInId = useSession((s) => (s.phase === "ready" ? (s.profile?.id ?? null) : null));
  const link = useLink(project?.id);
  const [signOutOpen, setSignOutOpen] = useState(false);
  // Stable, so the open confirmation keeps its focus when the runner re-renders.
  const closeSignOut = useCallback(() => setSignOutOpen(false), []);

  // The app lands on the Projects home; opening a project enters the runner.
  const [view, setView] = useState<"projects" | "runner">("projects");

  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void loadActive();
    void loadSettings();
    // The organisation's settings (name, contact, accent, study types) follow
    // the account. Already started at launch; this covers every way in. Inert
    // for a guest and in a build with no backend.
    startInstanceSync();
  }, [loadActive, loadSettings]);

  // Signing out hides an account's projects, the open one included. Its Share
  // dialog goes with it, instead of coming back with the next project opened.
  useEffect(() => {
    if (!project && shareOpen) closeShare();
  }, [project, shareOpen, closeShare]);

  const pathway = useMemo(
    () => (project && config ? derivePathway(config, project, activeStepId) : []),
    [project, config, activeStepId],
  );

  const pick = (id: StudyTypeId) => {
    // The chooser offers only what the organisation allows for new projects.
    // Checked again here, so no other way in can start a type it would not offer.
    if (!isStudyTypeAllowed(id, newStudyAllowList(useInstance.getState().instance))) return;
    void createProject(id).then(() => setView("runner"));
    closeChooser();
  };

  /** Open a saved project and resume at its first incomplete step. */
  const openProject = async (id: string) => {
    await switchProject(id);
    const st = useProject.getState();
    if (st.config && st.project) {
      const next =
        st.config.steps.find((s) => !st.project!.stepStatus[s.id]?.complete) ??
        st.config.steps[st.config.steps.length - 1];
      if (next) setActiveStep(next.id);
    }
    setView("runner");
  };

  const navigate = (id: string) => {
    const target = pathway.find((s) => s.id === id);
    if (!target || target.state === "locked") return;
    void persist();
    setActiveStep(id);
  };

  const commands: Command[] = useMemo(() => {
    const levelCmds = (["basic", "medium", "advanced"] as Level[]).map((l) => ({
      id: `level-${l}`,
      label: `Set detail level: ${l}`,
      run: () => setLevel(l),
    }));
    const stepCmds = pathway
      .filter((s) => s.state !== "locked")
      .map((s) => ({ id: `go-${s.id}`, label: `Go to: ${s.title}`, hint: `Step ${s.index}`, run: () => navigate(s.id) }));
    return [
      { id: "projects", label: "Go to Projects", run: () => setView("projects") },
      { id: "help", label: "Open the user guide", run: openHelp },
      { id: "activity", label: "View activity & contributions", run: openActivity },
      ...(isSupabaseConfigured ? [{ id: "share", label: "Share & collaborate", run: () => afterPalette(openShare) }] : []),
      { id: "checklist", label: "Reporting-standard checklist", run: openChecklist },
      { id: "paper", label: "Compile paper & export", run: openPaper },
      { id: "ethics", label: "Generate ethics documents", run: openEthics },
      { id: "new", label: "New study (choose a type)", run: openChooser },
      { id: "settings", label: "Open settings (API keys & sources)", run: () => afterPalette(openSettings) },
      { id: "dark", label: "Toggle dark / light mode", run: toggleMode },
      ...(isSupabaseConfigured && phase === "anon"
        ? [{ id: "sign-in", label: "Sign in or create an account", run: () => afterPalette(() => useAuthUi.getState().openAccount("signIn")) }]
        : []),
      ...(isSupabaseConfigured && phase === "ready"
        ? [{ id: "sign-out", label: "Sign out", run: () => afterPalette(() => setSignOutOpen(true)) }]
        : []),
      ...levelCmds,
      ...stepCmds,
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathway, phase]);

  if (loading) return <LoadingShell />;

  // New-study chooser overlay, shared by both views.
  const chooserOverlay = (
    <AnimatePresence>
      {chooserOpen && (
        <motion.div
          className="fixed inset-0 z-modal grid place-items-start overflow-y-auto p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <button aria-label="Close" className="fixed inset-0 -z-10 bg-scrim" onClick={closeChooser} />
          <div className="mx-auto w-full py-6">
            <StudyChooser onPick={pick} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  // Home view: Projects. Also the fallback whenever no project is active.
  if (view === "projects" || !project || !config) {
    return (
      <>
        <BackgroundMesh />
        <ChooserHeader />
        <main id="main" className="mx-auto max-w-7xl px-4 py-8">
          <ProjectsScreen activeId={project?.id} onOpen={openProject} onNew={openChooser} />
        </main>
        {chooserOverlay}
        {settingsOpen && <SettingsDialog open={settingsOpen} onClose={closeSettings} />}
        <AnimatePresence>{helpOpen && <HelpDialog onClose={closeHelp} />}</AnimatePresence>
      </>
    );
  }

  return (
    <AppShell steps={pathway} activeId={activeStepId} onNavigate={navigate} commands={commands}>
      <div className="flex flex-col gap-4">
        <ProjectHeader
          title={project.title}
          label={config.label}
          standard={config.reportingStandard}
          stepsTotal={config.steps.length}
          completed={pathway.filter((s) => s.state === "complete").length}
          onProjects={() => setView("projects")}
          onNewStudy={openChooser}
          onCompile={openPaper}
          onEthics={openEthics}
          onActivity={openActivity}
          onShare={isSupabaseConfigured ? openShare : undefined}
          onChecklist={openChecklist}
          onHelp={openHelp}
          badge={saveBadge(link, signedInId)}
        />
        {isViewOnly(link) && (
          // A viewer or a supervisor can still type here, but none of it is uploaded.
          <p role="note" className="glass-1 flex items-start gap-2 rounded-card px-4 py-3 text-sm text-ink">
            <Eye className="mt-0.5 h-4 w-4 shrink-0 text-ink-soft" aria-hidden="true" />
            <span>{VIEW_ONLY_NOTICE}</span>
          </p>
        )}
        <StepRunner config={config} />
      </div>

      {/* Compile & export overlay */}
      <AnimatePresence>
        {paperOpen && <PaperDialog onClose={closePaper} />}
      </AnimatePresence>

      {/* Ethics documents overlay */}
      <AnimatePresence>
        {ethicsOpen && <EthicsDialog onClose={closeEthics} />}
      </AnimatePresence>

      {/* Activity & contributions overlay */}
      <AnimatePresence>
        {activityOpen && <ActivityDialog onClose={closeActivity} />}
      </AnimatePresence>

      {/* Share & collaborate overlay. Only a build with an account backend has one. */}
      <AnimatePresence>
        {isSupabaseConfigured && shareOpen && <ShareDialog onClose={closeShare} />}
      </AnimatePresence>

      {/* "Sign out?", asked for from the command palette */}
      {isSupabaseConfigured && <SignOutDialog open={signOutOpen} onClose={closeSignOut} />}

      {/* Reporting-standard checklist overlay */}
      <AnimatePresence>
        {checklistOpen && <ChecklistDialog onClose={closeChecklist} />}
      </AnimatePresence>

      {/* User guide overlay */}
      <AnimatePresence>
        {helpOpen && <HelpDialog onClose={closeHelp} />}
      </AnimatePresence>

      {/* Switch / new-study overlay */}
      {chooserOverlay}
    </AppShell>
  );
}

function ChooserHeader() {
  const mode = useTheme((s) => s.mode);
  const toggleMode = useTheme((s) => s.toggleMode);
  const openSettings = useUI((s) => s.openSettings);
  const openHelp = useUI((s) => s.openHelp);
  return (
    <header className="mx-auto flex max-w-7xl items-center gap-2 px-4 pt-4">
      <Wordmark />
      <div className="ml-auto flex items-center gap-2">
        <GlassButton variant="soft" size="sm" onClick={openHelp}>
          <BookOpen className="h-4 w-4" aria-hidden="true" /> Guide
        </GlassButton>
        <GlassButton variant="ghost" size="sm" aria-label="Open settings" onClick={openSettings} className="!px-2">
          <Settings className="h-5 w-5" aria-hidden="true" />
        </GlassButton>
        <GlassButton variant="ghost" size="sm" aria-label="Toggle theme" onClick={toggleMode} className="!px-2">
          {mode === "light" ? <Moon className="h-5 w-5" aria-hidden="true" /> : <Sun className="h-5 w-5" aria-hidden="true" />}
        </GlassButton>
        {/* Sign in, or the signed-in person's menu. Nothing in a build with no backend. */}
        <AccountMenu />
      </div>
    </header>
  );
}

const BADGE_ICON: Record<SaveBadge, typeof Cloud> = { device: ShieldCheck, account: Cloud };

function ProjectHeader({
  title, label, standard, stepsTotal, completed, onProjects, onNewStudy, onCompile, onEthics, onActivity, onShare, onChecklist, onHelp, badge,
}: {
  title: string; label: string; standard: string; stepsTotal: number; completed: number; onProjects: () => void; onNewStudy: () => void; onCompile: () => void; onEthics: () => void; onActivity: () => void;
  /** Absent in a build with no account backend: there is nobody to share with. */
  onShare?: () => void;
  onChecklist: () => void; onHelp: () => void;
  /** Where the project is saved: on this device only, or in the signed-in person's account as well. */
  badge: SaveBadge;
}) {
  const BadgeIcon = BADGE_ICON[badge];
  return (
    <GlassPanel className="p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <button onClick={onProjects} className="flex items-center gap-1 text-sm font-medium text-ink-muted hover:text-primary focus-visible:focus-ring">
            <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" /> All projects
          </button>
          <h1 className="mt-0.5 text-2xl font-bold text-ink">{title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-pill bg-primary-soft px-2.5 py-1 text-xs font-semibold text-primary">{label}</span>
            <span className="inline-flex items-center rounded-pill bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent">{standard}</span>
            <span className="num-tabular text-sm text-ink-soft">{completed} / {stepsTotal} steps complete</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden items-center gap-1.5 rounded-pill bg-success-soft px-2.5 py-1 text-xs font-semibold text-success sm:inline-flex">
            <BadgeIcon className="h-3.5 w-3.5" aria-hidden="true" /> {SAVE_BADGE_LABEL[badge]}
          </span>
          <GlassButton variant="soft" size="sm" onClick={onCompile}>
            <FileText className="h-4 w-4" aria-hidden="true" /> Compile
          </GlassButton>
          <GlassButton variant="ghost" size="sm" onClick={onHelp}>
            <HelpCircle className="h-4 w-4" aria-hidden="true" /> Guide
          </GlassButton>
          <GlassButton variant="ghost" size="sm" onClick={onChecklist}>
            <ListChecks className="h-4 w-4" aria-hidden="true" /> Checklist
          </GlassButton>
          <GlassButton variant="ghost" size="sm" onClick={onActivity}>
            <Activity className="h-4 w-4" aria-hidden="true" /> Activity
          </GlassButton>
          {onShare && (
            <GlassButton variant="ghost" size="sm" onClick={onShare}>
              <Share2 className="h-4 w-4" aria-hidden="true" /> Share
            </GlassButton>
          )}
          <GlassButton variant="ghost" size="sm" onClick={onEthics}>
            <ScrollText className="h-4 w-4" aria-hidden="true" /> Ethics
          </GlassButton>
          <GlassButton variant="ghost" size="sm" onClick={onNewStudy}>
            <Plus className="h-4 w-4" aria-hidden="true" /> New study
          </GlassButton>
        </div>
      </div>
    </GlassPanel>
  );
}

function LoadingShell() {
  return (
    <div className="mx-auto max-w-7xl p-4">
      <div className="glass-1 h-16 animate-pulse rounded-card" />
      <div className="mt-4 flex gap-4">
        <div className="glass-1 hidden h-96 w-72 animate-pulse rounded-card lg:block" />
        <div className="glass-1 h-96 flex-1 animate-pulse rounded-card" />
      </div>
    </div>
  );
}
