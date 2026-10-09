import type { ReactNode } from "react";
import { Inbox, Loader2 } from "lucide-react";

// --- States ------------------------------------------------------------------

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink-soft" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      {label}
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-card border border-dashed border-hairline px-6 py-12 text-center">
      <Inbox className="h-7 w-7 text-ink-muted" aria-hidden="true" />
      <p className="font-semibold text-ink">{title}</p>
      {hint && <p className="max-w-sm text-sm text-ink-soft">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-input bg-danger-soft px-3 py-2 text-sm font-medium text-danger">
      {children}
    </p>
  );
}
