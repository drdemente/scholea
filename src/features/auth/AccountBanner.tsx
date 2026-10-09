import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Cloud, CloudUpload, HardDrive } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { ConfirmDialog, ErrorNote, toast } from "@/components/ui";
import {
  adoptionMessage,
  detachedMessage,
  divergedMessage,
  notLeftMessage,
  shouldShowPromo,
  signedOutAccount,
  signedOutMessage,
  stopsAdoption,
} from "@/lib/account/account-view";
import { useAuthUi } from "@/lib/account/auth-ui";
import { useSession } from "@/lib/account/session-store";
import { setLink } from "@/lib/collab/links";
import { ensureRemote, useSyncStatus } from "@/lib/collab/project-sync";
import { describeSyncError } from "@/lib/collab/sync";
import { Portal } from "./Portal";

/** Set once a guest has said "Not now" to making an account, or has signed in. */
const PROMO_DISMISSED_KEY = "scholea.account.promoDismissed";

function readPromoDismissed(): boolean {
  try {
    return localStorage.getItem(PROMO_DISMISSED_KEY) !== null;
  } catch {
    return false;
  }
}

function writePromoDismissed(): void {
  try {
    localStorage.setItem(PROMO_DISMISSED_KEY, "1");
  } catch {
    /* it is asked again next launch */
  }
}

/**
 * What Projects home says about the account, above the project list. At most
 * a couple show at once:
 *
 * - a guest is told, once, that an account is there if they want one;
 * - someone who was signed out without asking is told their projects are
 *   still here but no longer sync;
 * - after a sign-in, projects that were already on the device are offered to
 *   the account (they are never uploaded without this answer);
 * - a project whose copy in the account went away is pointed out, and so is
 *   one that was kept apart from the account's copy, and one the person could
 *   not leave after all.
 *
 * `adoptable` is the ids of the visible projects still waiting for that answer.
 * A build with no backend shows none of these.
 */
export function AccountBanners({ adoptable }: { adoptable: readonly string[] }) {
  const phase = useSession((s) => s.phase);
  const deviceAccount = useSession((s) => s.deviceAccount);
  // Nothing is offered to an account whose password is not settled yet: an
  // invited person cannot sync at all, and after a sign-up the account may
  // still open with a password somebody else set.
  const owesPassword = useSession((s) => s.passwordPending || s.profile?.mustSetPassword === true);
  const detached = useSyncStatus((s) => s.detached);
  const returned = useSyncStatus((s) => s.returned);

  const signedOut = signedOutAccount({ phase, deviceAccount });
  const gone = detached.filter((d) => d.reason === "gone").map((d) => d.title);
  const diverged = detached.filter((d) => d.reason === "diverged").map((d) => d.title);

  return (
    <>
      <PromoBanner />
      {signedOut && <SignedOutBanner email={signedOut.email} />}
      {phase === "ready" && detached.length > 0 && (
        <DetachedBanner messages={[...(gone.length > 0 ? [detachedMessage(gone)] : []), ...(diverged.length > 0 ? [divergedMessage(diverged)] : [])]} />
      )}
      {phase === "ready" && returned.length > 0 && <ReturnedBanner titles={returned.map((r) => r.title)} />}
      {/* Mounted whenever it could have something to say: what went wrong with an "Add" outlives the list it was about. */}
      {phase === "ready" && !owesPassword && <AdoptionBanner ids={adoptable} />}
    </>
  );
}

function Banner({ icon, children, actions, live = true }: { icon: ReactNode; children: ReactNode; actions: ReactNode; live?: boolean }) {
  return (
    <div role={live ? "status" : undefined} className="glass-1 mb-4 flex flex-col gap-3 rounded-card p-4 lg:flex-row lg:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span aria-hidden="true" className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-input bg-primary-soft text-primary">
          {icon}
        </span>
        <div className="min-w-0 flex-1 text-sm text-ink">{children}</div>
      </div>
      <div className="flex flex-wrap items-center gap-2 lg:shrink-0">{actions}</div>
    </div>
  );
}

function PromoBanner() {
  const phase = useSession((s) => s.phase);
  const deviceAccount = useSession((s) => s.deviceAccount);
  const openAccount = useAuthUi((s) => s.openAccount);
  const [dismissed, setDismissed] = useState(readPromoDismissed);

  // Someone with an account has no use for the invitation, now or after signing out.
  useEffect(() => {
    if (phase === "ready" && !dismissed) {
      writePromoDismissed();
      setDismissed(true);
    }
  }, [phase, dismissed]);

  if (!shouldShowPromo({ phase, deviceAccount, dismissed })) return null;

  const notNow = () => {
    writePromoDismissed();
    setDismissed(true);
  };

  return (
    <Banner
      live={false}
      icon={<Cloud className="h-4 w-4" />}
      actions={
        <>
          <GlassButton size="sm" onClick={() => openAccount("signUp")}>
            Create account
          </GlassButton>
          <GlassButton size="sm" variant="soft" onClick={() => openAccount("signIn")}>
            Sign in
          </GlassButton>
          <GlassButton size="sm" variant="ghost" onClick={notNow}>
            Not now
          </GlassButton>
        </>
      }
    >
      Your work is saved on this device. Create a free account to sync across devices and collaborate.
    </Banner>
  );
}

function SignedOutBanner({ email }: { email: string }) {
  const notice = useSession((s) => s.notice);
  const forgetDeviceAccount = useSession((s) => s.forgetDeviceAccount);
  const openAccount = useAuthUi((s) => s.openAccount);
  const [confirming, setConfirming] = useState(false);
  const cancel = useCallback(() => setConfirming(false), []);
  const remove = useCallback(() => {
    setConfirming(false);
    forgetDeviceAccount();
  }, [forgetDeviceAccount]);

  return (
    <>
      <Banner
        icon={<AlertTriangle className="h-4 w-4" />}
        actions={
          <>
            <GlassButton size="sm" onClick={() => openAccount("signIn", email)}>
              Sign in
            </GlassButton>
            <GlassButton size="sm" variant="ghost" onClick={() => setConfirming(true)}>
              Remove this account from this device
            </GlassButton>
          </>
        }
      >
        {signedOutMessage(notice, email)}
      </Banner>
      <Portal>
        <ConfirmDialog
          open={confirming}
          title="Remove this account from this device?"
          body={
            <>
              Projects from <strong className="[overflow-wrap:anywhere] text-ink">{email || "this account"}</strong> will be hidden on this device until you
              sign in again. Nothing is deleted, and projects that were never added to the account stay here.
            </>
          }
          confirmLabel="Remove account"
          onConfirm={remove}
          onCancel={cancel}
        />
      </Portal>
    </>
  );
}

function DetachedBanner({ messages }: { messages: string[] }) {
  const dismiss = useSyncStatus((s) => s.dismissDetached);
  return (
    <Banner
      icon={<HardDrive className="h-4 w-4" />}
      actions={
        <GlassButton size="sm" variant="soft" onClick={dismiss}>
          OK
        </GlassButton>
      }
    >
      {messages.map((message, i) => (
        <p key={message} className={i > 0 ? "mt-2" : undefined}>
          {message}
        </p>
      ))}
    </Banner>
  );
}

/** A project the person asked to leave while they were, by then, its only owner. It is still theirs. */
function ReturnedBanner({ titles }: { titles: string[] }) {
  const dismiss = useSyncStatus((s) => s.dismissReturned);
  return (
    <Banner
      icon={<AlertTriangle className="h-4 w-4" />}
      actions={
        <GlassButton size="sm" variant="soft" onClick={dismiss}>
          OK
        </GlassButton>
      }
    >
      {notLeftMessage(titles)}
    </Banner>
  );
}

function AdoptionBanner({ ids }: { ids: readonly string[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setBusy(true);
    setError(null);
    let added = 0;
    let failure: unknown = null;
    // One at a time: each is created in the account and then uploaded. It
    // counts as added only once its content is there.
    for (const id of ids) {
      try {
        await ensureRemote(id);
        added += 1;
      } catch (e) {
        // Those already added stay added. One that could not be added for a
        // reason of its own (it is too large, say) does not hold up the rest.
        // One that was created in the account and not uploaded yet uploads at
        // the next sync, and until then its card says "Not uploaded yet".
        failure ??= e;
        if (stopsAdoption(e)) break;
      }
    }
    if (failure !== null) setError(describeSyncError(failure));
    setBusy(false);
    if (added > 0) toast.success(added === 1 ? "1 project added to your account." : `${added} projects added to your account.`);
  };

  const keep = () => {
    for (const id of ids) setLink(id, { kind: "device", asked: true });
  };

  if (ids.length === 0) {
    // Nothing left to offer. If the last "Add" went wrong, that still has to be said.
    if (!error) return null;
    return (
      <Banner
        live={false}
        icon={<AlertTriangle className="h-4 w-4" />}
        actions={
          <GlassButton size="sm" variant="soft" onClick={() => setError(null)}>
            OK
          </GlassButton>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <p className="mt-2 text-ink-soft">A project that shows "Not uploaded yet" is uploaded the next time Scholea syncs.</p>
      </Banner>
    );
  }

  return (
    <Banner
      icon={<CloudUpload className="h-4 w-4" />}
      actions={
        <>
          <GlassButton size="sm" loading={busy} onClick={() => void add()}>
            Add to my account
          </GlassButton>
          <GlassButton size="sm" variant="ghost" disabled={busy} onClick={keep}>
            Keep on this device only
          </GlassButton>
        </>
      }
    >
      <p>{adoptionMessage(ids.length)}</p>
      {error && (
        <div className="mt-2">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </Banner>
  );
}
