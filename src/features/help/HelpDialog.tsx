import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { BookOpen, Search, X } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { HelpContact } from "@/features/instance/InstanceContact";
import guideSource from "../../../docs/USER_GUIDE.md?raw";
import { parseMarkdown } from "./Markdown";

/**
 * In-app User Guide. Renders docs/USER_GUIDE.md (bundled at build time, so it
 * ships inside the web and desktop builds) with a contents sidebar for quick
 * navigation. The Markdown file is the single source of truth for this panel.
 */
export function HelpDialog({ onClose }: { onClose: () => void }) {
  const { nodes, sections } = useMemo(() => parseMarkdown(guideSource), []);
  const [query, setQuery] = useState("");

  const filtered = query.trim()
    ? sections.filter((s) => s.title.toLowerCase().includes(query.trim().toLowerCase()))
    : sections;

  const goTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <motion.div
      className="fixed inset-0 z-modal overflow-hidden p-3 sm:p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <button aria-label="Close" className="fixed inset-0 -z-10 bg-scrim" onClick={onClose} />
      <div className="mx-auto flex h-full max-h-[92dvh] w-full max-w-6xl flex-col overflow-hidden rounded-modal glass-2 glass-highlight">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-hairline px-5 py-3.5">
          <span aria-hidden="true" className="grid h-8 w-8 place-items-center rounded-input bg-primary text-ink-onBrand shadow-glow-primary">
            <BookOpen className="h-5 w-5" />
          </span>
          <div className="mr-auto">
            <h2 className="font-display text-lg font-bold leading-none text-ink">User Guide</h2>
            <p className="text-xs text-ink-muted">How to use Scholea, from your first project to every study type</p>
          </div>
          <GlassButton variant="ghost" size="sm" aria-label="Close" onClick={onClose} className="!px-2">
            <X className="h-5 w-5" aria-hidden="true" />
          </GlassButton>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Contents sidebar */}
          <nav aria-label="Guide contents" className="hidden w-64 shrink-0 flex-col border-r border-hairline md:flex">
            <div className="p-3">
              <label className="relative block">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ink-muted" aria-hidden="true" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Find a section…"
                  className="w-full rounded-input border border-hairline bg-elevated/60 py-2 pl-8 pr-2 text-sm text-ink outline-none focus-visible:focus-ring"
                />
              </label>
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              {filtered.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => goTo(s.id)}
                    className="w-full truncate rounded-input px-2.5 py-1.5 text-left text-sm text-ink-soft hover:bg-primary-soft/50 hover:text-primary focus-visible:focus-ring"
                  >
                    {s.title}
                  </button>
                </li>
              ))}
              {filtered.length === 0 && <li className="px-2.5 py-2 text-sm text-ink-muted">No matching section.</li>}
            </ul>
          </nav>

          {/* Content */}
          <article id="help-scroll" className="min-w-0 flex-1 space-y-3 overflow-y-auto px-5 py-5 sm:px-8">
            {nodes}
          </article>
        </div>

        {/* The organisation's own contact details, for someone signed in to one */}
        <HelpContact />
      </div>
    </motion.div>
  );
}
