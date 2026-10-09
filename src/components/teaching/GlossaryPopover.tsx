import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useId, useRef, useState } from "react";
import { BookOpen } from "lucide-react";
import { popover, reducedFade, withReduced } from "@/lib/motion";

/**
 * Just-in-time teaching. A term with a dotted underline that reveals its
 * definition in a popover on click/focus. Keyboard accessible: Enter/Space
 * toggles, Escape closes, focus returns to the trigger.
 */
export function GlossaryPopover({ term, definition }: { term: string; definition: string }) {
  const [open, setOpen] = useState(false);
  const prefersReduced = useReducedMotion() ?? false;
  const wrapRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-sm font-medium text-primary underline decoration-dotted decoration-from-font underline-offset-4 transition-colors hover:text-primary-hover focus-visible:focus-ring"
      >
        <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
        {term}
      </button>

      <AnimatePresence>
        {open && (
          <motion.span
            id={panelId}
            role="tooltip"
            variants={withReduced(popover, reducedFade, prefersReduced)}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="glass-2 absolute left-0 top-full z-overlay mt-2 block w-72 max-w-[80vw] p-3 text-sm"
          >
            <span className="mb-1 block font-display text-sm font-semibold text-ink">{term}</span>
            <span className="block text-ink-soft">{definition}</span>
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
