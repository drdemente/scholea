import { motion } from "framer-motion";
import { useId } from "react";
import { useTheme, type Level } from "@/lib/theme/theme-store";

const LEVELS: { value: Level; label: string; hint: string }[] = [
  { value: "basic", label: "Basic", hint: "Plain-language guidance, essentials only" },
  { value: "medium", label: "Medium", hint: "More method detail and options" },
  { value: "advanced", label: "Advanced", hint: "Full methodological depth" },
];

/**
 * Always-visible progressive-disclosure control. A friendly segmented switch;
 * the active segment slides via a shared layout animation.
 */
export function LevelToggle() {
  const level = useTheme((s) => s.level);
  const setLevel = useTheme((s) => s.setLevel);
  const groupId = useId();

  return (
    <div
      role="radiogroup"
      aria-label="Detail level"
      className="inline-flex items-center gap-1 rounded-pill border border-hairline bg-elevated/60 p-1"
    >
      {LEVELS.map((l) => {
        const selected = l.value === level;
        return (
          <button
            key={l.value}
            role="radio"
            aria-checked={selected}
            title={l.hint}
            onClick={() => setLevel(l.value)}
            className={`relative rounded-pill px-3 py-1 text-sm font-medium transition-colors duration-micro focus-visible:focus-ring ${
              selected ? "text-ink-onBrand" : "text-ink-soft hover:text-ink"
            }`}
          >
            {selected && (
              <motion.span
                layoutId={`${groupId}-active`}
                className="absolute inset-0 -z-10 rounded-pill bg-primary shadow-1"
                transition={{ type: "spring", stiffness: 400, damping: 32 }}
              />
            )}
            {l.label}
          </button>
        );
      })}
    </div>
  );
}
