import { Moon, Search, Settings, Sun } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { AccountMenu } from "@/features/auth/AccountMenu";
import { LevelToggle } from "./LevelToggle";
import { Wordmark } from "./Wordmark";
import { useTheme } from "@/lib/theme/theme-store";
import { useUI } from "@/lib/ui-store";

type TopBarProps = {
  onOpenCommand: () => void;
};

export function TopBar({ onOpenCommand }: TopBarProps) {
  const mode = useTheme((s) => s.mode);
  const toggleMode = useTheme((s) => s.toggleMode);
  const openSettings = useUI((s) => s.openSettings);

  return (
    <header className="glass-1 glass-highlight sticky top-0 z-nav flex items-center gap-3 rounded-card px-4 py-2.5">
      {/* Wordmark, with the organisation's name for someone signed in to one */}
      <Wordmark />

      <div className="ml-auto flex items-center gap-2">
        <LevelToggle />

        {/* Command palette trigger */}
        <button
          onClick={onOpenCommand}
          className="hidden items-center gap-2 rounded-input border border-hairline bg-elevated/60 px-3 py-1.5 text-sm text-ink-soft transition-colors hover:text-ink focus-visible:focus-ring sm:inline-flex"
        >
          <Search className="h-4 w-4" aria-hidden="true" />
          <span>Search</span>
          <kbd className="num-tabular rounded bg-sunken px-1.5 py-0.5 font-mono text-xs text-ink-muted">
            ⌘K
          </kbd>
        </button>

        {/* Settings (BYO-key) */}
        <GlassButton variant="ghost" size="sm" aria-label="Open settings" onClick={openSettings} className="!px-2">
          <Settings className="h-5 w-5" aria-hidden="true" />
        </GlassButton>

        {/* Dark / light toggle */}
        <GlassButton
          variant="ghost"
          size="sm"
          aria-label={mode === "light" ? "Switch to dark mode" : "Switch to light mode"}
          onClick={toggleMode}
          className="!px-2"
        >
          {mode === "light" ? (
            <Moon className="h-5 w-5" aria-hidden="true" />
          ) : (
            <Sun className="h-5 w-5" aria-hidden="true" />
          )}
        </GlassButton>

        {/* Sign in, or the signed-in person's menu. Nothing in a build with no backend. */}
        <AccountMenu />
      </div>
    </header>
  );
}
