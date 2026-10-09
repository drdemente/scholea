import { useCallback, useState } from "react";
import { ConfirmDialog, toast } from "@/components/ui";
import { useSession } from "@/lib/account/session-store";
import { syncNow, useSyncStatus } from "@/lib/collab/project-sync";

/** How long signing out waits for a last upload before going ahead anyway. */
const SIGN_OUT_SYNC_MS = 8_000;

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/**
 * "Sign out?", for a place outside the account menu (the command palette).
 * It asks the same question and takes the same steps as the menu's own
 * "Sign out": one last upload while the session still exists, then this
 * device is signed out and the account's projects are hidden on it.
 *
 * `onClose` must keep its identity between renders (see `GlassOverlay`).
 */
export function SignOutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const syncState = useSyncStatus((s) => s.state);
  const [busy, setBusy] = useState(false);

  const signOut = useCallback(async () => {
    setBusy(true);
    try {
      // Not waited for long: whatever did not go up stays on this device and
      // goes up at the next sign-in.
      if (isOnline()) await Promise.race([syncNow(), new Promise<void>((resolve) => setTimeout(resolve, SIGN_OUT_SYNC_MS))]);
      await useSession.getState().signOut();
      toast.info("Signed out. Projects from your account are hidden on this device until you sign in again.");
    } finally {
      setBusy(false);
      onClose();
    }
  }, [onClose]);

  // Changes still on this device only: say so before signing out.
  const unsynced = !isOnline() || syncState === "offline" || syncState === "error";

  return (
    <ConfirmDialog
      open={open}
      title="Sign out?"
      body={
        <>
          <p>
            Projects from your account will be hidden on this device until you sign in again. Projects that were never added to your account stay
            here.
          </p>
          {unsynced && <p className="mt-2">Recent changes that haven't uploaded yet are kept on this device and will upload next time you sign in here.</p>}
        </>
      }
      confirmLabel="Sign out"
      loading={busy}
      onConfirm={() => void signOut()}
      onCancel={onClose}
    />
  );
}
