import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft } from "lucide-react";
import { GlassOverlay } from "@/components/glass";

export type Command = {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
};

type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  commands: Command[];
};

/** Minimal but real ⌘K palette: filter, arrow-key selection, Enter to run. */
export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = "cmdk-title";

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [query, commands]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // Focus after the overlay mounts.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setActive(0), [query]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      setActive((a) => Math.min(results.length - 1, a + 1));
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      setActive((a) => Math.max(0, a - 1));
      e.preventDefault();
    } else if (e.key === "Enter") {
      const cmd = results[active];
      if (cmd) {
        cmd.run();
        onClose();
      }
      e.preventDefault();
    }
  };

  return (
    <GlassOverlay open={open} onClose={onClose} labelledBy={titleId} className="!p-0">
      <h2 id={titleId} className="sr-only">
        Command palette
      </h2>
      <div className="border-b border-hairline p-3">
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="cmdk-list"
          aria-activedescendant={results[active] ? `cmdk-${results[active].id}` : undefined}
          placeholder="Type a command or search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          className="w-full bg-transparent px-2 py-1.5 text-md text-ink outline-none placeholder:text-ink-muted"
        />
      </div>
      <ul id="cmdk-list" role="listbox" aria-label="Commands" className="max-h-80 overflow-y-auto p-2">
        {results.length === 0 && (
          <li className="px-3 py-6 text-center text-sm text-ink-muted">No matching commands.</li>
        )}
        {results.map((cmd, i) => (
          <li key={cmd.id} id={`cmdk-${cmd.id}`} role="option" aria-selected={i === active}>
            <button
              onMouseEnter={() => setActive(i)}
              onClick={() => {
                cmd.run();
                onClose();
              }}
              className={`flex w-full items-center justify-between gap-3 rounded-input px-3 py-2 text-left text-sm transition-colors ${
                i === active ? "bg-primary-soft text-ink" : "text-ink-soft hover:bg-primary-soft"
              }`}
            >
              <span className="flex flex-col">
                <span className="font-medium text-ink">{cmd.label}</span>
                {cmd.hint && <span className="text-xs text-ink-muted">{cmd.hint}</span>}
              </span>
              {i === active && (
                <CornerDownLeft className="h-4 w-4 text-ink-muted" aria-hidden="true" />
              )}
            </button>
          </li>
        ))}
      </ul>
    </GlassOverlay>
  );
}
