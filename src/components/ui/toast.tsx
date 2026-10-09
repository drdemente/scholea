import { create } from "zustand";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";
import { reducedFade, withReduced } from "@/lib/motion";

type Kind = "success" | "error" | "info";
interface Toast {
  id: number;
  kind: Kind;
  message: string;
}
interface ToastState {
  toasts: Toast[];
  push: (kind: Kind, message: string) => void;
  dismiss: (id: number) => void;
}

let seq = 1;
export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, message) => {
    const id = seq++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    window.setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  success: (m: string) => useToasts.getState().push("success", m),
  error: (m: string) => useToasts.getState().push("error", m),
  info: (m: string) => useToasts.getState().push("info", m),
};

const ICON = { success: CheckCircle2, error: AlertTriangle, info: Info } as const;
const TONE = {
  success: "bg-success-soft text-success",
  error: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
} as const;

/** A toast slides up into place and drops a little as it goes. */
export const toastSlide: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 8 },
};

/**
 * Live-region toast stack. It announces to screen readers without stealing
 * focus. Mounted once, in `App`. For someone who asked for less motion a
 * toast only fades.
 */
export function ToastHost() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  const prefersReduced = useReducedMotion() ?? false;
  const variants = withReduced(toastSlide, reducedFade, prefersReduced);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-modal flex flex-col items-center gap-2 px-4" aria-live="polite">
      <AnimatePresence>
        {toasts.map((t) => {
          const Icon = ICON[t.kind];
          return (
            <motion.div
              key={t.id}
              variants={variants}
              initial="hidden"
              animate="visible"
              exit="exit"
              role={t.kind === "error" ? "alert" : "status"}
              className="glass-2 pointer-events-auto flex max-w-md items-start gap-2 rounded-card px-3.5 py-2.5 text-sm text-ink shadow-2"
            >
              <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-pill ${TONE[t.kind]}`}>
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">{t.message}</span>
              <button
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss"
                className="rounded-input p-0.5 text-ink-muted hover:text-ink focus-visible:focus-ring"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
