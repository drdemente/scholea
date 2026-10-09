import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { AlertTriangle, Building2, CheckCircle2, ChevronDown, Clock, CloudOff, KeyRound, LifeBuoy, LogIn, LogOut, Mail, MailCheck, RefreshCw, UserRound } from "lucide-react";
import { GlassButton, GlassOverlay } from "@/components/glass";
import { ConfirmDialog, ErrorNote, PasswordField, toast } from "@/components/ui";
import { displayName, initialOf, syncLine, type SyncTone } from "@/lib/account/account-view";
import { MIN_PASSWORD_LENGTH, describeAuthError } from "@/lib/account/auth-flow";
import { passwordFields, pendingInputOf, useAuthUi, type FieldErrors } from "@/lib/account/auth-ui";
import { emailProof } from "@/lib/account/email-proof";
import { PROOF_TITLE } from "@/lib/account/email-proof-flow";
import { useSession } from "@/lib/account/session-store";
import { invitationBadgeLabel, useInvitations } from "@/lib/collab/invitations";
import { syncNow, useSyncStatus } from "@/lib/collab/project-sync";
import { useInstance } from "@/lib/instance/instance-store";
import { SUPPORT_ITEM_LABEL, signedInLine, supportContact } from "@/lib/instance/instance-view";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { InvitationsDialog } from "@/features/collab/InvitationList";
import { ConfirmEmailDialog } from "./ConfirmEmailDialog";
import { EditProfileDialog } from "./EditProfileDialog";
import { focusFirstField } from "./focus";
import { Portal } from "./Portal";

/**
 * The account entry in the header. Nobody signed in: a "Sign in" button that
 * opens the account dialog. Signed in: an avatar button with a menu (the
 * organisation the account belongs to, sync status, sync now, invitations,
 * edit profile, change password, contact support, sign out). A build with no
 * backend renders nothing at all.
 */
export function AccountMenu() {
  const phase = useSession((s) => s.phase);
  if (!isSupabaseConfigured || phase === "unconfigured") return null;
  if (phase === "loading") {
    // A saved session is still being checked. Nothing waits on it.
    return (
      <span role="status" className="text-xs text-ink-soft">
        Checking account…
      </span>
    );
  }
  return phase === "ready" ? <SignedInMenu /> : <SignInButton />;
}

function SignInButton() {
  const openAccount = useAuthUi((s) => s.openAccount);
  return (
    <GlassButton variant="soft" size="sm" onClick={() => openAccount("signIn")}>
      <LogIn className="h-4 w-4" aria-hidden="true" /> Sign in
    </GlassButton>
  );
}

const SYNC_ICON: Record<SyncTone, typeof Clock> = {
  synced: CheckCircle2,
  syncing: RefreshCw,
  offline: CloudOff,
  error: AlertTriangle,
  waiting: Clock,
};

/** How long signing out waits for a last upload before going ahead anyway. */
const SIGN_OUT_SYNC_MS = 8_000;

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

const itemCls =
  "flex w-full items-center gap-2 rounded-input px-2.5 py-2 text-left text-sm text-ink hover:bg-primary-soft focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50";

type OpenDialog = null | "profile" | "password" | "signOut" | "confirmEmail";

function SignedInMenu() {
  const profile = useSession((s) => s.profile);
  // A code was accepted and no password is settled yet: nothing syncs until one is.
  const passwordPending = useSession((s) => s.passwordPending);
  const syncState = useSyncStatus((s) => s.state);
  const lastSyncedAt = useSyncStatus((s) => s.lastSyncedAt);
  const errorCode = useSyncStatus((s) => s.errorCode);
  const invitationCount = useInvitations((s) => s.items.length);
  const resumePending = useAuthUi((s) => s.resumePending);
  const openInvitations = useAuthUi((s) => s.openInvitations);
  const invitationsOpen = useAuthUi((s) => s.invitationsOpen);
  const closeInvitations = useAuthUi((s) => s.closeInvitations);
  const openAccount = useAuthUi((s) => s.openAccount);
  // What the organisation's administrator set, if anything. Both are left out when empty.
  const instance = useInstance((s) => s.instance);
  const organisation = signedInLine(instance);
  const support = supportContact(instance);

  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [signingOut, setSigningOut] = useState(false);
  /** Whether the account's address is proven. `null` until the backend has said. */
  const [emailConfirmed, setEmailConfirmed] = useState<boolean | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const userId = profile?.id ?? null;

  const closeMenu = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  }, []);
  // Stable, so an open dialog is not disturbed when this menu re-renders.
  const closeDialog = useCallback(() => setDialog(null), []);

  // While the menu is open: focus starts on its first item, and a press
  // anywhere else closes it.
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Ask, each time the menu opens, whether the address still needs proving.
  useEffect(() => {
    if (!open || !userId) return;
    let live = true;
    void (async () => {
      const value = await emailProof.isConfirmed();
      // An unproven address was set by an administrator, possibly while this
      // device was signed in: read the account again, so the code goes to the
      // address it has now and not to the one this device remembers.
      if (value === false) await useSession.getState().refreshProfile().catch(() => null);
      if (live) setEmailConfirmed(value);
    })();
    return () => {
      live = false;
    };
  }, [open, userId]);

  // The invitations belong to whoever is signed in. When this menu goes (the
  // session ended), the list goes with it and does not reopen for the next person.
  useEffect(() => closeInvitations, [closeInvitations]);

  const signOut = useCallback(async () => {
    setSigningOut(true);
    try {
      // One last upload while the session still exists. Not waited for long:
      // whatever did not go up stays on this device and goes up at the next sign-in.
      if (isOnline()) await Promise.race([syncNow(), new Promise<void>((resolve) => setTimeout(resolve, SIGN_OUT_SYNC_MS))]);
      await useSession.getState().signOut();
      toast.info("Signed out. Projects from your account are hidden on this device until you sign in again.");
    } finally {
      setSigningOut(false);
      setDialog(null);
    }
  }, []);

  if (!profile) return null;

  const toggle = () => {
    if (open) return closeMenu(false);
    // Someone who still owes a password is taken to that step first.
    if (resumePending(pendingInputOf(useSession.getState()))) return;
    setOpen(true);
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      e.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    };
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu(true);
    } else if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(items.length - 1);
    // Tab leaves the menu: it closes, and focus carries on from the button.
    else if (e.key === "Tab") closeMenu(true);
  };

  const choose = (next: OpenDialog) => {
    // Focus goes back to the button first, so that is where it returns when the dialog closes.
    closeMenu(true);
    setDialog(next);
  };

  const name = displayName(profile);
  const owesPassword = profile.mustSetPassword || passwordPending;
  const line = syncLine({ state: syncState, lastSyncedAt, errorCode }, Date.now(), owesPassword);
  const LineIcon = SYNC_ICON[line.tone];
  // Changes still on this device only: say so before signing out.
  const unsynced = !isOnline() || syncState === "offline" || syncState === "error";
  const sessionEnded = syncState === "error" && errorCode === "unauthenticated";

  return (
    <div ref={wrap} className="relative">
      <button
        ref={trigger}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-input px-2 py-1.5 text-sm text-ink hover:bg-primary-soft focus-visible:focus-ring"
      >
        <span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary-soft text-xs font-bold text-primary">
          {initialOf(profile.name, profile.email)}
        </span>
        <span className="sr-only">Account menu for</span>
        <span className="sr-only text-left sm:not-sr-only sm:block">
          <span className="block max-w-[12rem] truncate text-xs font-semibold leading-tight text-ink">{name}</span>
          {name !== profile.email && <span className="block max-w-[12rem] truncate text-[11px] leading-tight text-ink-soft">{profile.email}</span>}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-ink-soft" aria-hidden="true" />
      </button>

      {open && (
        // Opaque, not glass: it opens over whatever is on the page.
        <div className="absolute right-0 z-40 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-card border border-hairline bg-elevated p-1.5 shadow-2">
          <div className="px-2.5 py-2">
            <p className="truncate text-sm font-semibold text-ink">{name}</p>
            {name !== profile.email && <p className="truncate text-xs text-ink-soft">{profile.email}</p>}
            {organisation && (
              <p title={organisation} className="mt-1 flex items-center gap-1.5 text-xs text-ink-soft">
                <Building2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{organisation}</span>
              </p>
            )}
          </div>
          <p role="status" className="flex items-start gap-2 border-y border-hairline px-2.5 py-2 text-xs text-ink-soft">
            <LineIcon
              className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${line.tone === "syncing" ? "animate-spin motion-reduce:animate-none" : ""}`}
              aria-hidden="true"
            />
            <span>{line.text}</span>
          </p>
          <div ref={menu} role="menu" aria-label="Account" onKeyDown={onMenuKeyDown} className="pt-1.5">
            {sessionEnded && (
              // The backend no longer accepts this session (it was revoked, or the
              // account was signed out everywhere). Signing in again restores sync.
              <MenuItem
                icon={<LogIn className="h-4 w-4" aria-hidden="true" />}
                onClick={() => {
                  closeMenu(true);
                  openAccount("signIn", profile.email);
                }}
              >
                Sign in again
              </MenuItem>
            )}
            <MenuItem icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />} disabled={syncState === "syncing" || owesPassword} onClick={() => void syncNow()}>
              Sync now
            </MenuItem>
            <MenuItem
              icon={<Mail className="h-4 w-4" aria-hidden="true" />}
              label={invitationBadgeLabel(invitationCount)}
              onClick={() => {
                closeMenu(true);
                openInvitations();
              }}
            >
              <span className="flex-1">Invitations</span>
              {invitationCount > 0 && (
                <span className="num-tabular rounded-pill bg-primary px-1.5 py-0.5 text-[11px] font-semibold leading-none text-ink-onBrand">{invitationCount}</span>
              )}
            </MenuItem>
            {emailConfirmed === false && (
              <MenuItem icon={<MailCheck className="h-4 w-4" aria-hidden="true" />} onClick={() => choose("confirmEmail")}>
                {PROOF_TITLE}
              </MenuItem>
            )}
            <MenuItem icon={<UserRound className="h-4 w-4" aria-hidden="true" />} onClick={() => choose("profile")}>
              Edit profile
            </MenuItem>
            <MenuItem icon={<KeyRound className="h-4 w-4" aria-hidden="true" />} onClick={() => choose("password")}>
              Change password
            </MenuItem>
            {support && (
              // A link, so the person's own mail app opens. The address is shown
              // too, for anyone whose device has no mail app set up.
              <a
                role="menuitem"
                href={support.href}
                onClick={() => closeMenu(true)}
                onKeyDown={(e) => {
                  // A link answers Enter by itself. A menu item answers Space too.
                  if (e.key !== " ") return;
                  e.preventDefault();
                  e.currentTarget.click();
                }}
                className={itemCls}
              >
                <LifeBuoy className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block">{SUPPORT_ITEM_LABEL}</span>
                  <span className="block truncate text-xs text-ink-soft">{support.email}</span>
                </span>
              </a>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => choose("signOut")}
              className="flex w-full items-center gap-2 rounded-input px-2.5 py-2 text-left text-sm text-danger hover:bg-danger-soft focus-visible:focus-ring"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" /> Sign out
            </button>
          </div>
        </div>
      )}

      {/* The header this menu sits in is glass, so its dialogs are rendered at the end of the page. */}
      <Portal>
        {dialog === "profile" && <EditProfileDialog profile={profile} onClose={closeDialog} />}
        {dialog === "password" && <ChangePasswordDialog email={profile.email} onClose={closeDialog} />}
        {dialog === "confirmEmail" && <ConfirmEmailDialog email={profile.email} onClose={closeDialog} onConfirmed={() => setEmailConfirmed(true)} />}
        {invitationsOpen && <InvitationsDialog onClose={closeInvitations} />}
        <ConfirmDialog
          open={dialog === "signOut"}
          title="Sign out?"
          body={
            <>
              <p>
                Projects from your account will be hidden on this device until you sign in again. Projects that were never added to your account stay
                here.
              </p>
              {unsynced && (
                <p className="mt-2">Recent changes that haven't uploaded yet are kept on this device and will upload next time you sign in here.</p>
              )}
            </>
          }
          confirmLabel="Sign out"
          loading={signingOut}
          onConfirm={() => void signOut()}
          onCancel={closeDialog}
        />
      </Portal>
    </div>
  );
}

function MenuItem({
  icon,
  label,
  disabled,
  onClick,
  children,
}: {
  icon: ReactNode;
  /** Accessible name, when it says more than the visible text. */
  label?: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" role="menuitem" aria-label={label} disabled={disabled} onClick={onClick} className={itemCls}>
      {icon}
      {children}
    </button>
  );
}

function ChangePasswordDialog({ email, onClose }: { email: string; onClose: () => void }) {
  const changePassword = useSession((s) => s.changePassword);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fields, setFields] = useState<FieldErrors & { current?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => focusFirstField(() => form.current), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const problems: FieldErrors & { current?: string } = { ...passwordFields(next, confirm) };
    if (!current) problems.current = "Enter your current password.";
    setFields(problems);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    try {
      // The current password is checked first, by signing in with it again.
      await changePassword(current, next);
      toast.success("Password changed.");
      onClose();
    } catch (err) {
      setError(describeAuthError(err, "changePassword"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <GlassOverlay open onClose={onClose} labelledBy="account-password-title" className="max-h-[calc(100dvh-2rem)] w-full !max-w-sm overflow-y-auto !p-6">
      <form ref={form} onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <h2 id="account-password-title" className="text-lg font-bold text-ink">
          Change password
        </h2>
        <input type="text" name="username" autoComplete="username" value={email} readOnly tabIndex={-1} aria-hidden="true" className="sr-only" />
        <PasswordField label="Current password" value={current} onChange={setCurrent} required autoComplete="current-password" error={fields.current} />
        <PasswordField
          label="New password"
          value={next}
          onChange={setNext}
          required
          autoComplete="new-password"
          help={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          error={fields.password}
        />
        <PasswordField label="Confirm new password" value={confirm} onChange={setConfirm} required autoComplete="new-password" error={fields.confirm} />
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex justify-end gap-2">
          <GlassButton type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </GlassButton>
          <GlassButton type="submit" size="sm" loading={busy}>
            Update password
          </GlassButton>
        </div>
      </form>
    </GlassOverlay>
  );
}
