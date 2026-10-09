import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, type ReactNode } from "react";
import { glassEnter, reducedFade, withReduced } from "@/lib/motion";

type GlassOverlayProps = {
  open: boolean;
  onClose: () => void;
  /** ID of the heading element inside the overlay (for aria-labelledby). */
  labelledBy: string;
  /** Scrim opacity. 0.4–0.6 per design system. Solid, never glass. */
  scrim?: number;
  className?: string;
  children?: ReactNode;
};

/**
 * Tier-2 glass surface for modals, sheets, the ⌘K palette.
 * The scrim is SOLID ink (not glass) so foreground text stays legible.
 * Escape closes; focus returns to the previously-focused element.
 */
export function GlassOverlay({
  open,
  onClose,
  labelledBy,
  scrim = 0.5,
  className = "",
  children,
}: GlassOverlayProps) {
  const prefersReduced = useReducedMotion() ?? false;
  const variants = withReduced(glassEnter, reducedFade, prefersReduced);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreFocus.current = document.activeElement as HTMLElement;
    dialogRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      restoreFocus.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div role="presentation" className="fixed inset-0 z-modal grid place-items-center p-4">
      <motion.div
        aria-hidden="true"
        className="absolute inset-0 bg-ink-700"
        style={{ opacity: scrim }}
        initial={{ opacity: 0 }}
        animate={{ opacity: scrim }}
        exit={{ opacity: 0 }}
        transition={{ duration: prefersReduced ? 0.001 : 0.18 }}
        onClick={onClose}
      />
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`relative glass-2 glass-highlight max-w-[min(640px,92vw)] p-6 focus-visible:focus-ring ${className}`}
        variants={variants}
        initial="hidden"
        animate="visible"
        exit="exit"
      >
        {children}
      </motion.div>
    </div>
  );
}
