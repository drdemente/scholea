import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence } from "framer-motion";
import { BackgroundMesh } from "@/components/glass";
import { PathwayMap, type PathwayStep } from "@/components/pathway/PathwayMap";
import { TopBar } from "./TopBar";
import { CommandPalette, type Command } from "./CommandPalette";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import { useUI } from "@/lib/ui-store";

type AppShellProps = {
  steps: PathwayStep[];
  activeId: string;
  onNavigate: (id: string) => void;
  commands: Command[];
  children: ReactNode;
};

/**
 * The persistent application frame: animated mesh background, top bar, the
 * Pathway Map (rail on desktop, stepper on mobile), and the routed content.
 * Owns the global ⌘K shortcut.
 */
export function AppShell({ steps, activeId, onNavigate, commands, children }: AppShellProps) {
  const [cmdOpen, setCmdOpen] = useState(false);
  const settingsOpen = useUI((s) => s.settingsOpen);
  const closeSettings = useUI((s) => s.closeSettings);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <BackgroundMesh />

      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-toast focus:rounded-input focus:bg-primary focus:px-4 focus:py-2 focus:text-ink-onBrand"
      >
        Skip to main content
      </a>

      <div className="mx-auto flex max-w-7xl flex-col gap-4 p-4">
        <TopBar onOpenCommand={() => setCmdOpen(true)} />

        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <PathwayMap
            steps={steps}
            activeId={activeId}
            onNavigate={onNavigate}
            className="lg:sticky lg:top-[5.5rem]"
          />
          <main id="main" className="min-w-0 flex-1">
            {children}
          </main>
        </div>
      </div>

      <AnimatePresence>
        {cmdOpen && (
          <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} commands={commands} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {settingsOpen && <SettingsDialog open={settingsOpen} onClose={closeSettings} />}
      </AnimatePresence>
    </>
  );
}
