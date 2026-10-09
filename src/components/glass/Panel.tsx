import { motion, useReducedMotion, type HTMLMotionProps } from "framer-motion";
import { forwardRef, type ReactNode } from "react";
import { glassEnter, reducedFade, withReduced } from "@/lib/motion";

type GlassPanelProps = HTMLMotionProps<"section"> & {
  /** Adds the soft top-edge highlight that sells the glass effect. */
  highlight?: boolean;
  /** Skip the entrance animation (e.g. inside an already-animated parent). */
  noAnimate?: boolean;
  children?: ReactNode;
};

/**
 * Tier-1 glass surface — cards, sidebars, the Pathway Map rail.
 * Text inside should use opaque tokens (text-ink / text-ink-soft), never an
 * opacity modifier, so contrast stays deterministic over the mesh.
 */
export const GlassPanel = forwardRef<HTMLElement, GlassPanelProps>(
  ({ children, className = "", highlight = true, noAnimate, ...rest }, ref) => {
    const prefersReduced = useReducedMotion() ?? false;
    const variants = withReduced(glassEnter, reducedFade, prefersReduced);

    return (
      <motion.section
        ref={ref}
        className={`relative glass-1 ${highlight ? "glass-highlight" : ""} ${className}`}
        variants={noAnimate ? undefined : variants}
        initial={noAnimate ? undefined : "hidden"}
        animate={noAnimate ? undefined : "visible"}
        exit={noAnimate ? undefined : "exit"}
        {...rest}
      >
        {children}
      </motion.section>
    );
  },
);
GlassPanel.displayName = "GlassPanel";
