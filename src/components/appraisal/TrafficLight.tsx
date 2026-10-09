import { Circle, Diamond, Triangle, type LucideIcon } from "lucide-react";

export type RobLevel = "low" | "some-concern" | "high";

/**
 * Visual mapping for a risk-of-bias level. Colourblind-safe: every level pairs
 * a colour with a distinct SHAPE/icon (§7 + WCAG color-not-only). Shared by the
 * inline TrafficLight and the appraisal matrix.
 */
export const robVisual: Record<RobLevel, { icon: LucideIcon; label: string; cls: string }> = {
  low: { icon: Circle, label: "Low", cls: "text-rob-low" },
  "some-concern": { icon: Diamond, label: "Some concerns", cls: "text-rob-someConcern" },
  high: { icon: Triangle, label: "High", cls: "text-rob-high" },
};

/** Inline traffic light with colour + shape + text label. */
export function TrafficLight({ level, domain }: { level: RobLevel; domain?: string }) {
  const { icon: Icon, label, cls } = robVisual[level];
  return (
    <span
      className="inline-flex items-center gap-1.5 text-sm"
      title={domain ? `${domain}: ${label} risk of bias` : `${label} risk of bias`}
    >
      <Icon className={`h-4 w-4 ${cls}`} fill="currentColor" strokeWidth={1.5} aria-hidden="true" />
      <span className="text-ink-soft">
        {domain ? `${domain}: ` : ""}
        <span className="font-medium text-ink">{label}</span>
      </span>
    </span>
  );
}
