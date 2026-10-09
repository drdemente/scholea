import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type MutableRefObject, type ReactNode } from "react";
import { Clock, Cloud, CloudUpload, DoorOpen, HardDrive, Info, KeyRound, Loader2, RefreshCw, Share2, Trash2, UserPlus, Users2, X } from "lucide-react";
import { GlassButton, GlassOverlay } from "@/components/glass";
import { ConfirmDialog, ErrorNote, SelectField, Spinner, TextField, toast } from "@/components/ui";
import { AuthFlow } from "@/features/auth/AuthFlow";
import { Portal } from "@/features/auth/Portal";
import { detachedMessage, divergedMessage, initialOf } from "@/lib/account/account-view";
import { pendingInputOf, useAuthUi } from "@/lib/account/auth-ui";
import { useSession } from "@/lib/account/session-store";
import { formatWhen } from "@/lib/collab/collab";
import {
  DEFAULT_INVITE_ROLE,
  INVITE_ROLES,
  describeInviteError,
  invitations,
  isValidEmail,
  memberRows,
  removeInvitation,
  type InviteRole,
  type PendingInvitation,
} from "@/lib/collab/invitations";
import { useLink } from "@/lib/collab/links";
import { ensureRemote, syncNow, useSyncStatus } from "@/lib/collab/project-sync";
import {
  ADDING_MESSAGE,
  DEVICE_ONLY_MESSAGE,
  INVITE_HELP,
  LEFT_MESSAGE,
  MEMBER_ROLES,
  ONLY_OWNER_MESSAGE,
  OTHER_ACCOUNT_MESSAGE,
  PASSWORD_FIRST_MESSAGE,
  PENDING_HELP,
  accountScreensActive,
  canLeave,
  canManageMember,
  cancelledMessage,
  confirmCopy,
  describeCancelError,
  describeLeaveError,
  describeTeamAction,
  formatDay,
  inviteSavedMessage,
  isOnlyOwner,
  isStaleTeam,
  memberLabel,
  memberName,
  personOf,
  removedMessage,
  roleChangedMessage,
  shareStage,
  shareStatus,
  signInPrompt,
} from "@/lib/collab/share-view";
import {
  ROLE_LABEL,
  SyncError,
  describeSyncError,
  sync,
  type ActivityEntry,
  type Contributor,
  type Member,
  type ProjectRole,
} from "@/lib/collab/sync";
import { useProject } from "@/lib/study/project-store";

const TITLE_ID = "share-title";

/** How many entries of the team's ledger show before "Show all". */
const ACTIVITY_PREVIEW = 12;

/**
 * Sharing the open project. What it shows follows where the project is:
 *
 * - nobody signed in: the account screens, right here;
 * - only on this device: the offer to add it to the account;
 * - in the account: the team (members, invitations, activity) and, for an
 *   owner, the controls to change it.
 *
 * People join by invitation only. An owner invites an address; whoever has
 * confirmed that address accepts in Scholea. No email is sent.
 *
 * Entirely optional: the offline research core works without ever opening
 * this, and a build with no backend never shows it.
 */
export function ShareDialog({ onClose }: { onClose: () => void }) {
  const project = useProject((s) => s.project);
  const phase = useSession((s) => s.phase);
  const userId = useSession((s) => (s.phase === "ready" ? (s.profile?.id ?? null) : null));
  // After a sign-up the account may still open with a password somebody else
  // set, and an invited person has none yet. Neither shares anything until it is settled.
  const sessionOwes = useSession((s) => s.passwordPending || s.profile?.mustSetPassword === true);
  // The account screens can be part-way through something the session does not show yet.
  const screensActive = useAuthUi((s) => accountScreensActive(s.flow, s.busy));
  const accountDialogOpen = useAuthUi((s) => s.open);
  const link = useLink(project?.id);
  // Why sync kept this project as a copy on this device, if it did.
  const keptBecause = useSyncStatus((s) => s.detached.find((d) => d.localId === project?.id)?.reason);
  const heading = useRef<HTMLHeadingElement>(null);

  // A confirmation opened from here, and the account dialog, answer Escape
  // themselves. While one is up, Escape must not close this dialog as well.
  const confirming = useRef(false);
  const close = useCallback(() => {
    if (!confirming.current && !useAuthUi.getState().open) onClose();
  }, [onClose]);

  const stage = shareStage({ phase, userId, owesPassword: sessionOwes, screensActive, accountDialogOpen, link });

  // The project left the account while this was open (its owner deleted it, or
  // removed this person). Sync kept the copy here; say so instead of just
  // changing what is offered.
  const [leftAccount, setLeftAccount] = useState(false);
  const lastStage = useRef(stage.kind);
  useEffect(() => {
    if (stage.kind === "account") setLeftAccount(false);
    else if (lastStage.current === "account" && stage.kind === "device") setLeftAccount(true);
    lastStage.current = stage.kind;
  }, [stage.kind]);

  // What held the focus may have just gone (a form, a row). Keep it in the dialog.
  const keepFocus = useCallback(() => {
    if (document.activeElement === document.body) heading.current?.focus();
  }, []);
  useEffect(keepFocus, [keepFocus, stage.kind]);

  let body: ReactNode = null;
  if (project) {
    switch (stage.kind) {
      case "unavailable":
        body = <Note>{describeSyncError(new SyncError(0, "not_configured"))}</Note>;
        break;
      case "checking":
        body = <Spinner label="Checking your account…" />;
        break;
      case "signIn":
        body = (
          <div className="flex flex-col gap-4">
            <Note>{signInPrompt(link)}</Note>
            <AuthFlow />
          </div>
        );
        break;
      case "accountDialog":
        body = <p className="text-sm text-ink-soft">Finish signing in to continue.</p>;
        break;
      case "password":
        body = (
          <div className="flex flex-col gap-3">
            <Note icon={KeyRound}>{PASSWORD_FIRST_MESSAGE}</Note>
            <GlassButton onClick={() => useAuthUi.getState().resumePending(pendingInputOf(useSession.getState()))} className="justify-center">
              Choose a password
            </GlassButton>
          </div>
        );
        break;
      case "otherAccount":
        body = <Note>{OTHER_ACCOUNT_MESSAGE}</Note>;
        break;
      case "device":
      case "adding":
        body = (
          <div className="flex flex-col gap-3">
            {leftAccount && stage.kind === "device" && (
              <Note>{keptBecause === "diverged" ? divergedMessage([project.title]) : detachedMessage([project.title])}</Note>
            )}
            <AddToAccount projectId={project.id} auto={stage.kind === "adding"} />
          </div>
        );
        break;
      case "account":
        body = (
          <TeamPanel
            key={stage.serverId}
            serverId={stage.serverId}
            title={project.title}
            userId={userId}
            confirming={confirming}
            keepFocus={keepFocus}
            onClose={onClose}
          />
        );
        break;
    }
  }

  return (
    <GlassOverlay open onClose={close} labelledBy={TITLE_ID} className="max-h-[calc(100dvh-2rem)] w-full !max-w-lg overflow-y-auto !p-5 sm:!p-6">
      <div className="mb-1 flex items-center gap-2">
        <Share2 className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
        <h2 ref={heading} id={TITLE_ID} tabIndex={-1} className="mr-auto rounded-input text-lg font-bold text-ink outline-none focus-visible:focus-ring">
          Share &amp; collaborate
        </h2>
        <GlassButton variant="ghost" size="sm" aria-label="Close" onClick={onClose} className="!px-2">
          <X className="h-5 w-5" aria-hidden="true" />
        </GlassButton>
      </div>
      {project && <p className="mb-4 truncate text-sm text-ink-soft">{project.title}</p>}
      {body}
    </GlassOverlay>
  );
}

function Note({ icon: Icon = Info, children }: { icon?: typeof Info; children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-input bg-info-soft p-3 text-sm text-ink">
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/**
 * Puts the project in the signed-in person's account, and uploads it. Asked
 * for with a button when the project is kept on this device. `auto` is a
 * project that was made while signed in: it is going into the account anyway,
 * so the step that was still missing is done without asking.
 */
function AddToAccount({ projectId, auto }: { projectId: string; auto: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  const add = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      // Never makes a second server copy: the same project is asked for again.
      await ensureRemote(projectId);
    } catch (e) {
      setError(describeSyncError(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (auto) void add();
  }, [auto, add]);

  return (
    <div className="flex flex-col gap-3">
      {auto ? (
        !error && (
          <p role="status" className="flex items-center gap-2 text-sm text-ink-soft">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {ADDING_MESSAGE}
          </p>
        )
      ) : (
        <Note icon={HardDrive}>{DEVICE_ONLY_MESSAGE}</Note>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      {(!auto || error) && (
        <GlassButton onClick={() => void add()} loading={busy} className="justify-center">
          {!busy && <CloudUpload className="h-4 w-4" aria-hidden="true" />}
          {auto ? "Try again" : "Add to my account"}
        </GlassButton>
      )}
    </div>
  );
}

const sectionTitleCls = "flex items-center gap-1.5 text-sm font-semibold text-ink";
// A hairline, not a fill: the role pill and the hover of the remove button are the raised surface, and must show on the row.
const rowCls = "flex flex-wrap items-center gap-2 rounded-input border border-hairline px-2.5 py-1.5";
const pillCls = "inline-flex items-center gap-1 rounded-pill bg-elevated px-2 py-0.5 text-xs font-medium text-ink-soft";

/** A change to the team that is asked about before it is made. */
type Asking = { kind: "remove" | "promote"; member: Member } | { kind: "leave" };

/** The team of a project that is in the signed-in person's account. */
function TeamPanel({
  serverId,
  title,
  userId,
  confirming,
  keepFocus,
  onClose,
}: {
  serverId: string;
  title: string;
  userId: string | null;
  /** Set while a confirmation is up, so the dialog behind it stays. */
  confirming: MutableRefObject<boolean>;
  keepFocus: () => void;
  onClose: () => void;
}) {
  const [role, setRole] = useState<ProjectRole | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [pending, setPending] = useState<PendingInvitation[]>([]);
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [contributors, setContributors] = useState<Contributor[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** The member or invitation a request is under way for. */
  const [working, setWorking] = useState<string | null>(null);
  const [ask, setAsk] = useState<Asking | null>(null);
  const [answering, setAnswering] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const ids = useId();
  const request = useRef(0);

  /**
   * Read the team from the backend. `quiet` is a re-read after something
   * changed: an error already on screen stays, and a failure adds none.
   */
  const load = useCallback(
    async (quiet = false) => {
      const mine = ++request.current;
      setLoading(true);
      if (!quiet) setError(null);
      try {
        const project = await sync.getProject(serverId);
        const [activity, open] = await Promise.all([
          sync.activity(serverId),
          // Only owners may see who has been invited.
          project.role === "owner" ? invitations.listForProject(serverId) : { invitations: [] },
        ]);
        if (mine !== request.current) return;
        setRole(project.role);
        setMembers(project.members);
        setPending(open.invitations);
        setEntries(activity.entries);
        setContributors(activity.contributors);
        setLoaded(true);
      } catch (e) {
        if (mine !== request.current) return;
        if (!quiet) setError(describeSyncError(e));
        // The project has left this account (deleted, or this person was
        // removed). Sync notices, and keeps this copy on the device only.
        if (e instanceof SyncError && e.code === "not_found") void syncNow();
      } finally {
        if (mine === request.current) setLoading(false);
      }
    },
    [serverId],
  );

  useEffect(() => {
    void load();
    return () => {
      // Whatever is still on its way belongs to a panel that is gone.
      request.current += 1;
    };
  }, [load]);

  useEffect(() => {
    confirming.current = ask !== null;
    return () => {
      confirming.current = false;
    };
  }, [ask, confirming]);

  // A row that held the focus may have gone with the change.
  useEffect(keepFocus, [keepFocus, members, pending, loaded]);

  // Stable, so the open confirmation keeps its focus when this panel re-renders.
  const cancelAsk = useCallback(() => setAsk(null), []);

  /** One change at a time. A refusal that says the team has moved on reads it again. */
  const change = async (target: string, work: () => Promise<void>, describe: (e: unknown) => string = describeSyncError) => {
    setWorking(target);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(describe(e));
      if (isStaleTeam(e)) void load(true);
    } finally {
      setWorking(null);
    }
  };

  const setMemberRole = (member: Member, next: ProjectRole) =>
    change(member.user_id, async () => {
      const result = await sync.setMemberRole(serverId, member.user_id, next);
      setMembers(result.members);
      toast.success(roleChangedMessage(member, next));
    });

  const pickRole = (member: Member, next: ProjectRole) => {
    if (next === member.role) return;
    // Ownership cannot be taken back here, so it is asked about first.
    if (next === "owner") setAsk({ kind: "promote", member: member });
    else void setMemberRole(member, next);
  };

  const cancelInvitation = (invitationId: string, email: string) =>
    change(
      invitationId,
      async () => {
        await invitations.cancel(invitationId);
        setPending((list) => removeInvitation(list, invitationId));
        toast.info(cancelledMessage(email));
      },
      describeCancelError,
    );

  const confirm = async () => {
    if (!ask || answering) return;
    setAnswering(true);
    setError(null);
    try {
      if (ask.kind === "leave") {
        await sync.leaveProject(serverId);
        setAsk(null);
        toast.success(LEFT_MESSAGE);
        // The next sync sees the project is gone from the account and keeps
        // what is here as a copy on this device only.
        void syncNow();
        onClose();
      } else if (ask.kind === "remove") {
        await sync.removeMember(serverId, ask.member.user_id);
        setAsk(null);
        toast.success(removedMessage(ask.member));
        await load(true);
      } else {
        const result = await sync.setMemberRole(serverId, ask.member.user_id, "owner");
        setMembers(result.members);
        setAsk(null);
        toast.success(roleChangedMessage(ask.member, "owner"));
      }
    } catch (e) {
      setAsk(null);
      setError(ask.kind === "leave" ? describeLeaveError(e) : describeSyncError(e));
      if (isStaleTeam(e)) void load(true);
    } finally {
      setAnswering(false);
    }
  };

  if (!loaded) {
    if (loading) return <Spinner label="Loading the team…" />;
    return (
      <div className="flex flex-col gap-3">
        {error && <ErrorNote>{error}</ErrorNote>}
        <GlassButton variant="soft" size="sm" onClick={() => void load()} className="self-start">
          <RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again
        </GlassButton>
      </div>
    );
  }

  const status = shareStatus(role, members);
  const StatusIcon = status.shared ? Users2 : Cloud;
  const isOwner = role === "owner";
  // Members first, then the open invitations (one that was accepted a moment ago is left out).
  const invited = memberRows(members, pending).filter((row) => row.kind === "invitation");
  const shown = showAll ? entries : entries.slice(0, ACTIVITY_PREVIEW);
  const copy = ask ? confirmCopy(ask, title) : null;

  return (
    <div className="flex flex-col gap-5">
      <span className="inline-flex w-fit items-center gap-1.5 rounded-pill bg-primary-soft px-2.5 py-1 text-xs font-semibold text-primary">
        <StatusIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {status.label}
      </span>

      {error && <ErrorNote>{error}</ErrorNote>}

      <section aria-labelledby={`${ids}-members`}>
        <div className="mb-2 flex items-center gap-2">
          <h3 id={`${ids}-members`} className={`mr-auto ${sectionTitleCls}`}>
            <Users2 className="h-4 w-4 text-ink-soft" aria-hidden="true" /> Members
          </h3>
          <GlassButton variant="ghost" size="sm" loading={loading} onClick={() => void load()}>
            {!loading && <RefreshCw className="h-4 w-4" aria-hidden="true" />} Refresh
          </GlassButton>
        </div>
        <ul className="flex flex-col gap-1.5">
          {members.map((m) => {
            const name = memberName(m);
            const label = memberLabel(m);
            const selectId = `${ids}-role-${m.user_id}`;
            return (
              <li key={m.user_id} className={rowCls}>
                <span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary-soft text-xs font-bold text-primary">
                  {initialOf(m.name, m.email)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">
                    {name}
                    {m.user_id === userId && <span className="font-normal text-ink-soft"> (you)</span>}
                  </span>
                  {label !== name && <span className="block truncate text-xs text-ink-soft">{m.email}</span>}
                </span>
                {canManageMember(role, m, userId) ? (
                  <>
                    <label className="sr-only" htmlFor={selectId}>
                      Role for {label}
                    </label>
                    <select
                      id={selectId}
                      value={m.role}
                      disabled={working !== null}
                      onChange={(e) => pickRole(m, e.target.value as ProjectRole)}
                      className="rounded-input border border-hairline bg-elevated px-1.5 py-1 text-xs text-ink outline-none focus-visible:focus-ring disabled:opacity-50"
                    >
                      {MEMBER_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => setAsk({ kind: "remove", member: m })}
                      disabled={working !== null}
                      aria-label={`Remove ${label}`}
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-input text-ink-soft hover:bg-elevated hover:text-danger focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </>
                ) : (
                  <span className={pillCls}>{ROLE_LABEL[m.role]}</span>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {isOwner && invited.length > 0 && (
        <section aria-labelledby={`${ids}-pending`}>
          <h3 id={`${ids}-pending`} className={`mb-2 ${sectionTitleCls}`}>
            <Clock className="h-4 w-4 text-ink-soft" aria-hidden="true" /> Pending invitations
          </h3>
          <ul className="flex flex-col gap-1.5">
            {invited.map((row) => (
              <li key={row.key} className={rowCls}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{row.email}</span>
                  {row.expiresAt > 0 && <span className="block text-xs text-ink-soft">expires {formatDay(row.expiresAt)}</span>}
                </span>
                <span className={pillCls}>
                  <Clock className="h-3 w-3 shrink-0" aria-hidden="true" /> Invited · {ROLE_LABEL[row.role]}
                </span>
                <GlassButton
                  variant="ghost"
                  size="sm"
                  aria-label={`Cancel invitation for ${row.email}`}
                  loading={working === row.invitationId}
                  disabled={working !== null}
                  onClick={() => void cancelInvitation(row.invitationId, row.email)}
                >
                  Cancel
                </GlassButton>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-soft">{PENDING_HELP}</p>
        </section>
      )}

      {isOwner && <InviteForm serverId={serverId} onInvited={() => void load(true)} />}

      <section aria-labelledby={`${ids}-activity`}>
        <h3 id={`${ids}-activity`} className={`mb-2 ${sectionTitleCls}`}>
          Team activity
        </h3>
        {contributors.length > 0 && (
          <ul aria-label="Contributors" className="mb-2 flex flex-wrap gap-1.5">
            {contributors.map((c, i) => {
              // People are told apart by account, never by name.
              const person = personOf(c.actorId, c.actor, members);
              return (
                <li key={c.actorId ?? `name:${c.actor}:${i}`} className="rounded-pill bg-elevated px-2 py-0.5 text-xs text-ink">
                  <span className="font-medium">{person.name}</span>
                  {person.detail && <span className="text-ink-soft"> ({person.detail})</span>}
                  <span className="num-tabular text-ink-soft">
                    {" "}
                    · {c.count}
                    <span className="sr-only"> {c.count === 1 ? "entry" : "entries"}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {entries.length === 0 ? (
          <p className="text-sm text-ink-soft">No shared activity yet.</p>
        ) : (
          <ol className="flex flex-col gap-1.5 text-sm">
            {shown.map((e) => {
              const person = personOf(e.actor_id, e.actor_name, members);
              return (
                <li key={e.id} className="break-words text-ink">
                  <span className="font-semibold">{person.name}</span>
                  {person.detail && <span className="text-ink-soft"> ({person.detail})</span>} {describeTeamAction(e.action, e.detail)}
                  <span className="text-ink-soft"> · {formatWhen(e.created_at)}</span>
                </li>
              );
            })}
          </ol>
        )}
        {entries.length > shown.length && (
          <GlassButton variant="ghost" size="sm" onClick={() => setShowAll(true)} className="mt-2">
            Show all {entries.length}
          </GlassButton>
        )}
      </section>

      {canLeave(members, userId) ? (
        <div className="border-t border-hairline pt-4">
          <GlassButton variant="ghost" size="sm" onClick={() => setAsk({ kind: "leave" })}>
            <DoorOpen className="h-4 w-4" aria-hidden="true" /> Leave project
          </GlassButton>
        </div>
      ) : (
        members.length > 1 && isOnlyOwner(members, userId) && <p className="border-t border-hairline pt-4 text-xs text-ink-soft">{ONLY_OWNER_MESSAGE}</p>
      )}

      {/* This dialog is glass, and a dialog inside it would be laid out to it: the confirmation goes to the end of the page. */}
      <Portal>
        <ConfirmDialog
          open={copy !== null}
          title={copy?.title ?? ""}
          body={copy?.body ?? ""}
          confirmLabel={copy?.confirmLabel}
          danger={copy?.danger}
          loading={answering}
          onConfirm={() => void confirm()}
          onCancel={cancelAsk}
        />
      </Portal>
    </div>
  );
}

/**
 * "Invite by email", for owners. The invitation waits in Scholea for whoever
 * confirms that address. The answer is the same whether or not the address
 * has an account, so nothing here says which it is.
 */
function InviteForm({ serverId, onInvited }: { serverId: string; onInvited: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>(DEFAULT_INVITE_ROLE);
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ id: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const helpId = useId();

  // A mistyped address: back to the field.
  useEffect(() => {
    if (attempt > 0) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [attempt]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(null);
    if (!isValidEmail(email)) {
      setEmailError(describeInviteError(new SyncError(400, "invalid_email"), "manage"));
      setAttempt((n) => n + 1);
      return;
    }
    setEmailError(undefined);
    setBusy(true);
    try {
      const { invitation } = await invitations.invite(serverId, email, role);
      setEmail("");
      setSaved((last) => ({ id: (last?.id ?? 0) + 1, text: inviteSavedMessage(invitation.email) }));
      onInvited();
    } catch (err) {
      setError(describeInviteError(err, "manage"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form ref={form} onSubmit={submit} aria-describedby={helpId} className="flex flex-col gap-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
        <TextField label="Invite by email" type="email" value={email} onChange={setEmail} autoComplete="off" error={emailError} />
        <SelectField
          label="Role"
          value={role}
          onChange={(value) => setRole(INVITE_ROLES.find((r) => r === value) ?? DEFAULT_INVITE_ROLE)}
          options={INVITE_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
        />
      </div>
      <p id={helpId} className="text-xs text-ink-soft">
        {INVITE_HELP}
      </p>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {/* Always present, so that what it comes to hold is announced. */}
        <p role="status" aria-live="polite" className="min-w-0 flex-1 text-sm font-medium text-ink">
          {saved && <span key={saved.id}>{saved.text}</span>}
        </p>
        <GlassButton type="submit" size="sm" loading={busy}>
          {!busy && <UserPlus className="h-4 w-4" aria-hidden="true" />} Invite
        </GlassButton>
      </div>
    </form>
  );
}
