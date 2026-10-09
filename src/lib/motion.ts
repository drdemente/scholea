/**
 * Scholea — Framer Motion presets.
 *
 * Two timing families:
 *   • Entrances/exits — cubic-bezier(0.16, 1, 0.3, 1) for spatial feel
 *   • Interactives    — springs (physics, no duration)
 *
 * Reduced motion: pass the matchMedia result into withReduced(full, reduced)
 * so the same variant tree degrades to a one-frame fade.
 */
import type { Transition, Variants } from "framer-motion";

export const EASE = {
  entrance: [0.16, 1, 0.3, 1] as const,
  exit: [0.7, 0, 0.84, 0] as const,
  standard: [0.4, 0, 0.2, 1] as const,
};

export const DUR = {
  micro: 0.15,
  short: 0.22,
  step: 0.38,
  celebrate: 0.6,
};

export const SPRING = {
  press: { type: "spring", stiffness: 600, damping: 28, mass: 0.6 } as Transition,
  hover: { type: "spring", stiffness: 320, damping: 24, mass: 0.7 } as Transition,
  panel: { type: "spring", stiffness: 220, damping: 26, mass: 0.9 } as Transition,
  ribbon: { type: "spring", stiffness: 140, damping: 22, mass: 1.0 } as Transition,
};

export function withReduced<T>(full: T, reduced: T, prefersReduced: boolean): T {
  return prefersReduced ? reduced : full;
}

export const reducedFade: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.001 } },
  exit: { opacity: 0, transition: { duration: 0.001 } },
};

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: DUR.short, ease: EASE.entrance } },
  exit: { opacity: 0, y: 6, transition: { duration: DUR.micro, ease: EASE.exit } },
};

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: DUR.short, ease: EASE.entrance } },
  exit: { opacity: 0, transition: { duration: DUR.micro, ease: EASE.exit } },
};

/** Glass panel entrance — slight scale + blur-in. */
export const glassEnter: Variants = {
  hidden: { opacity: 0, y: 18, scale: 0.985, filter: "blur(8px)" },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    filter: "blur(0px)",
    transition: { duration: DUR.step, ease: EASE.entrance },
  },
  exit: {
    opacity: 0,
    y: 6,
    scale: 0.99,
    filter: "blur(4px)",
    transition: { duration: DUR.short, ease: EASE.exit },
  },
};

/** Step-runner forward/backward — directional, spatial continuity. */
export const stepEnter = (direction: 1 | -1): Variants => ({
  hidden: { opacity: 0, x: 36 * direction },
  visible: { opacity: 1, x: 0, transition: { duration: DUR.step, ease: EASE.entrance } },
  exit: { opacity: 0, x: -36 * direction, transition: { duration: DUR.short, ease: EASE.exit } },
});

/** Staggered children for lists, evidence rows, screening queue. */
export const staggerParent: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04, delayChildren: 0.04 } },
};
export const staggerChild: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: DUR.short, ease: EASE.entrance } },
};

/** Tasteful completion pulse — fires once on step → complete. */
export const celebrate: Variants = {
  rest: { scale: 1, boxShadow: "0 0 0 0 rgba(47, 204, 139, 0)" },
  pulse: {
    scale: [1, 1.06, 1],
    boxShadow: [
      "0 0 0 0 rgba(47, 204, 139, 0)",
      "0 0 0 14px rgba(47, 204, 139, 0.35)",
      "0 0 0 22px rgba(47, 204, 139, 0)",
    ],
    transition: { duration: DUR.celebrate, ease: EASE.entrance, times: [0, 0.5, 1] },
  },
};

/** Pathway ribbon — the gradient progress line drawn between nodes. */
export const ribbonDraw = (target: number): Variants => ({
  hidden: { pathLength: 0 },
  visible: { pathLength: target, transition: SPRING.ribbon },
});

/** Cmd-K palette: scale + fade from trigger origin. */
export const cmdK: Variants = {
  hidden: { opacity: 0, scale: 0.96, y: -8 },
  visible: { opacity: 1, scale: 1, y: 0, transition: { duration: DUR.step, ease: EASE.entrance } },
  exit: { opacity: 0, scale: 0.97, y: -4, transition: { duration: DUR.micro, ease: EASE.exit } },
};

/** Screening card — swipe right to include (mint), left to exclude (danger). */
export const screeningCardSwipe = {
  rest: { x: 0, rotate: 0, opacity: 1 },
  include: {
    x: 360,
    rotate: 6,
    opacity: 0,
    transition: { duration: DUR.short, ease: EASE.exit },
  },
  exclude: {
    x: -360,
    rotate: -6,
    opacity: 0,
    transition: { duration: DUR.short, ease: EASE.exit },
  },
};

/** Glossary popover — quick, low ceremony. */
export const popover: Variants = {
  hidden: { opacity: 0, y: 6, scale: 0.98 },
  visible: { opacity: 1, y: 0, scale: 1, transition: { duration: DUR.micro, ease: EASE.entrance } },
  exit: { opacity: 0, y: 2, scale: 0.99, transition: { duration: 0.1, ease: EASE.exit } },
};
