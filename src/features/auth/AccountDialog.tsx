import { useEffect, useRef } from "react";
import { GlassOverlay } from "@/components/glass";
import { toast } from "@/components/ui";
import { outcomeMessage } from "@/lib/account/account-view";
import { useAuthUi } from "@/lib/account/auth-ui";
import { useSession } from "@/lib/account/session-store";
import { syncNow } from "@/lib/collab/project-sync";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { AuthFlow } from "./AuthFlow";

const TITLE_ID = "account-title";

/**
 * The account screens in a dialog. Mounted once, at the top of the research
 * app. It opens from `useAuthUi` (the account menu, the banners on Projects
 * home, or by itself for someone who still owes a password) and closes when a
 * flow runs to its end, with a short confirmation.
 *
 * A build with no backend never shows it.
 */
export function AccountDialog() {
  const open = useAuthUi((s) => s.open);
  const close = useAuthUi((s) => s.close);
  const finished = useAuthUi((s) => s.finished);

  const announced = useRef(finished?.id ?? 0);
  useEffect(() => {
    if (!finished || finished.id === announced.current) return;
    announced.current = finished.id;
    toast.success(outcomeMessage(finished.outcome, useSession.getState().profile));
    // Signing in again as the same person does not restart sync by itself.
    if (finished.outcome === "signedIn") void syncNow();
  }, [finished]);

  if (!isSupabaseConfigured) return null;

  return (
    <GlassOverlay open={open} onClose={close} labelledBy={TITLE_ID} className="max-h-[calc(100dvh-2rem)] w-full !max-w-sm overflow-y-auto !p-6">
      <AuthFlow headingId={TITLE_ID} guestNote />
    </GlassOverlay>
  );
}
