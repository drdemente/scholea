/**
 * Scholea — Pathway Map (signature element).
 * The persistent journey rail. Primary navigation AND emotional core:
 * "you can't get lost."
 *
 * Layout:  ≥1024px vertical rail (288px) · <1024px horizontal stepper.
 * States:  every state pairs colour + icon + ring shape (colourblind-safe).
 * Ribbon:  transform-based gradient progress (scaleY rail / scaleX stepper) —
 *          GPU-friendly and deterministic (no SVG getTotalLength fragility).
 * Motion:  staggered node entrance · press spring · once-only completion pulse.
 *          The background mesh parallaxes; nodes never move under the cursor.
 * A11y:    <nav>, roving tabindex, arrow-key nav, aria-current="step".
 */
import { AlertCircle, CheckCircle2, Circle, Dot, Lock, type LucideIcon } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { celebrate, SPRING, staggerChild, staggerParent } from "@/lib/motion";

export type PathwayState = "locked" | "available" | "active" | "complete" | "needs-attention";

export type PathwayStep = {
  id: string;
  index: number;
  title: string;
  short?: string;
  state: PathwayState;
};

type PathwayMapProps = {
  steps: PathwayStep[];
  activeId: string;
  onNavigate: (id: string) => void;
  className?: string;
};

const stateIcon: Record<PathwayState, LucideIcon> = {
  locked: Lock,
  available: Circle,
  active: Dot,
  complete: CheckCircle2,
  "needs-attention": AlertCircle,
};

const stateRing: Record<PathwayState, string> = {
  locked: "ring-1 ring-hairline bg-elevated text-ink-muted",
  available: "ring-1 ring-accent/50 bg-canvas text-ink-soft",
  active: "ring-2 ring-primary bg-primary text-ink-onBrand shadow-glow-primary",
  complete: "ring-1 ring-success bg-success-soft text-success",
  "needs-attention": "ring-1 ring-warning bg-warning-soft text-warning",
};

const ariaState: Record<PathwayState, string> = {
  locked: "Locked",
  available: "Available",
  active: "In progress, currently active",
  complete: "Complete",
  "needs-attention": "Needs attention",
};

export function PathwayMap({ steps, activeId, onNavigate, className = "" }: PathwayMapProps) {
  const navId = useId();
  const railRef = useRef<HTMLOListElement>(null);

  const completed = steps.filter((s) => s.state === "complete").length;
  const progress = steps.length > 1 ? completed / (steps.length - 1) : 0;

  const firstFocusable = steps.findIndex((s) => s.state !== "locked");

  // Roving tabindex: arrow keys walk between unlocked nodes.
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const stepper = window.matchMedia("(max-width: 1023px)").matches;
    const fwd = stepper ? "ArrowRight" : "ArrowDown";
    const bwd = stepper ? "ArrowLeft" : "ArrowUp";
    if (e.key !== fwd && e.key !== bwd) return;

    const buttons = railRef.current?.querySelectorAll<HTMLButtonElement>(
      'button[data-pathway-node]:not([aria-disabled="true"])',
    );
    if (!buttons?.length) return;
    const arr = Array.from(buttons);
    const i = arr.findIndex((b) => b === document.activeElement);
    const next = e.key === fwd ? Math.min(arr.length - 1, i + 1) : Math.max(0, i - 1);
    arr[next]?.focus();
    e.preventDefault();
  }, []);

  return (
    <nav
      aria-label="Research pathway"
      aria-describedby={`${navId}-summary`}
      className={`glass-1 glass-highlight p-4 lg:h-[calc(100dvh-7rem)] lg:w-72 lg:overflow-y-auto ${className}`}
    >
      <p id={`${navId}-summary`} className="sr-only">
        Research pathway. {completed} of {steps.length} steps complete.
      </p>

      {/* Stepper-mode progress bar (mobile) */}
      <div className="mb-3 h-1 overflow-hidden rounded-pill bg-[var(--border-hairline)] lg:hidden">
        <motion.div
          className="h-full origin-left rounded-pill"
          style={{ background: "linear-gradient(90deg, var(--violet-500), var(--turquoise-500))" }}
          initial={{ scaleX: 0 }}
          animate={{ scaleX: progress }}
          transition={SPRING.ribbon}
        />
      </div>

      <motion.ol
        ref={railRef}
        variants={staggerParent}
        initial="hidden"
        animate="visible"
        onKeyDown={onKeyDown}
        className="relative flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:gap-3 lg:overflow-x-visible lg:pb-0"
      >
        {/* Rail-mode ribbon (desktop): vertical track + gradient progress fill,
            aligned to the disc-centre column (left 1.75rem). */}
        <div
          aria-hidden="true"
          className="absolute left-7 top-7 bottom-7 z-0 hidden w-[2.5px] -translate-x-1/2 rounded-pill bg-[var(--border-hairline)] lg:block"
        >
          <motion.div
            className="h-full w-full origin-top rounded-pill"
            style={{ background: "linear-gradient(180deg, var(--violet-500), var(--turquoise-500))" }}
            initial={{ scaleY: 0 }}
            animate={{ scaleY: progress }}
            transition={SPRING.ribbon}
          />
        </div>

        {steps.map((step, i) => (
          <PathwayNode
            key={step.id}
            step={step}
            active={step.id === activeId}
            tabbable={i === firstFocusable || step.id === activeId}
            onActivate={() => onNavigate(step.id)}
          />
        ))}
      </motion.ol>
    </nav>
  );
}

type PathwayNodeProps = {
  step: PathwayStep;
  active: boolean;
  tabbable: boolean;
  onActivate: () => void;
};

function PathwayNode({ step, active, tabbable, onActivate }: PathwayNodeProps) {
  const prefersReduced = useReducedMotion() ?? false;
  const Icon = stateIcon[step.state];
  const disabled = step.state === "locked";

  // Fire the celebration pulse exactly once when a step turns complete.
  const prev = useRef(step.state);
  const [pulsing, setPulsing] = useState(false);
  useEffect(() => {
    if (prev.current !== "complete" && step.state === "complete" && !prefersReduced) {
      setPulsing(true);
    }
    prev.current = step.state;
  }, [step.state, prefersReduced]);

  const label = `Step ${step.index}: ${step.title}. ${ariaState[step.state]}.`;

  return (
    <motion.li variants={staggerChild} className="relative z-10 snap-start lg:snap-none">
      <motion.button
        data-pathway-node
        aria-current={active ? "step" : undefined}
        aria-disabled={disabled || undefined}
        aria-label={label}
        tabIndex={tabbable ? 0 : -1}
        onClick={disabled ? undefined : onActivate}
        whileHover={disabled ? undefined : { y: -2 }}
        whileTap={disabled ? undefined : { scale: 0.97 }}
        transition={SPRING.press}
        className={`group flex w-full flex-col items-center gap-1 rounded-input p-1 text-center transition-colors duration-micro ease-standard focus-visible:focus-ring lg:flex-row lg:gap-3 lg:p-2 lg:text-left ${
          disabled ? "cursor-not-allowed" : "cursor-pointer hover:bg-primary-soft"
        }`}
      >
        <motion.span
          variants={celebrate}
          animate={pulsing ? "pulse" : "rest"}
          onAnimationComplete={() => setPulsing(false)}
          className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-pill transition-all duration-short ease-entrance ${stateRing[step.state]}`}
        >
          <Icon className="h-5 w-5" strokeWidth={2} aria-hidden="true" />
        </motion.span>

        <span className="hidden flex-col lg:flex">
          <span className="num-tabular text-xs text-ink-muted">
            Step {String(step.index).padStart(2, "0")}
          </span>
          <span className="text-sm font-medium text-ink">{step.title}</span>
        </span>
        <span className="text-[10px] font-medium uppercase tracking-wide text-ink-soft lg:hidden">
          {step.short ?? step.title}
        </span>
      </motion.button>
    </motion.li>
  );
}
