import type { ReactNode } from "react";
import { GlassButton, GlassOverlay } from "@/components/glass";

// --- Confirm dialog (destructive guard) --------------------------------------

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  danger,
  loading,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <GlassOverlay open={open} onClose={onCancel} labelledBy="confirm-title" className="grid place-items-center p-4">
      <div className="glass-2 glass-highlight w-full max-w-md rounded-modal p-5">
        <h2 id="confirm-title" className="text-lg font-bold text-ink">
          {title}
        </h2>
        <div className="mt-2 text-sm text-ink-soft">{body}</div>
        <div className="mt-5 flex justify-end gap-2">
          <GlassButton variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </GlassButton>
          <GlassButton
            variant="filled"
            size="sm"
            loading={loading}
            onClick={onConfirm}
            className={danger ? "!bg-danger hover:!brightness-110" : ""}
          >
            {confirmLabel}
          </GlassButton>
        </div>
      </div>
    </GlassOverlay>
  );
}
