import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { CheckCircle2, Mail, X } from "lucide-react";
import { GlassButton, GlassOverlay } from "@/components/glass";
import { EmptyState, ErrorNote, Spinner, toast } from "@/components/ui";
import { useSession } from "@/lib/account/session-store";
import { formatWhen } from "@/lib/collab/collab";
import { describeInviteError, useInvitations, type MyInvitation } from "@/lib/collab/invitations";
import { syncNow } from "@/lib/collab/project-sync";
import {
  INVITATION_ACCEPTED,
  INVITATION_DECLINED,
  INVITATION_HELP,
  acceptLabel,
  declineLabel,
  formatDay,
  invitationSentence,
} from "@/lib/collab/share-view";
import { configById } from "@/lib/study/registry";

type Answer = "accept" | "decline";

interface Responding {
  /** The invitation being answered, and how. Every button waits meanwhile. */
  busy: { id: string; answer: Answer } | null;
  /** Why the last answer could not be given. */
  error: string | null;
  dismissError(): void;
  respond(invitation: MyInvitation, answer: Answer): Promise<void>;
}

/**
 * Accepting and declining. Accepting joins the project; the sync layer then
 * downloads it, and `onAccepted` runs once that sync has finished. `onDone`
 * is told what to say when an answer went through. `fallbackFocus` takes the
 * focus when the row that held it has gone. `outerFocus` takes it when the
 * fallback has gone as well: the list that shows nothing while it is empty
 * takes its own heading away with the last row.
 */
function useResponding(input: {
  onDone: (text: string, answer: Answer) => void;
  onAccepted?: () => void;
  fallbackFocus: RefObject<HTMLElement>;
  outerFocus?: RefObject<HTMLElement>;
}): Responding {
  const [busy, setBusy] = useState<Responding["busy"]>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const respond = async (invitation: MyInvitation, answer: Answer) => {
    if (busy) return;
    setBusy({ id: invitation.id, answer });
    setError(null);
    try {
      if (answer === "accept") {
        await useInvitations.getState().accept(invitation.id);
        input.onDone(INVITATION_ACCEPTED, answer);
        // Joining starts the download by itself. This waits for that sync, so
        // whoever lists the projects can read them again once it is there.
        void syncNow().then(() => input.onAccepted?.());
      } else {
        await useInvitations.getState().decline(invitation.id);
        input.onDone(INVITATION_DECLINED, answer);
      }
    } catch (e) {
      if (live.current) setError(describeInviteError(e));
    } finally {
      if (live.current) {
        setBusy(null);
        // An answered invitation leaves the list, and the button that was pressed goes with it.
        const gone = !useInvitations.getState().items.some((item) => item.id === invitation.id);
        if (gone && document.activeElement === document.body) (input.fallbackFocus.current ?? input.outerFocus?.current)?.focus();
      }
    }
  };

  return { busy, error, dismissError: () => setError(null), respond };
}

/** The line under an invitation: the kind of study, when it was sent, when it runs out. */
function detailLine(invitation: MyInvitation): string {
  const parts = [configById(invitation.study_type)?.label ?? invitation.study_type];
  if (invitation.created_at > 0) parts.push(`invited ${formatWhen(invitation.created_at)}`);
  if (invitation.expires_at > 0) parts.push(`expires ${formatDay(invitation.expires_at)}`);
  return parts.filter((part) => part !== "").join(" · ");
}

function Rows({ items, responding }: { items: readonly MyInvitation[]; responding: Responding }) {
  const { busy, respond } = responding;
  return (
    <ul className="flex flex-col gap-2">
      {items.map((invitation) => {
        const mine = busy?.id === invitation.id ? busy.answer : null;
        return (
          <li key={invitation.id} className="flex flex-col gap-2 rounded-input border border-hairline bg-elevated p-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm text-ink">{invitationSentence(invitation)}</p>
              <p className="mt-0.5 break-words text-xs text-ink-soft">{detailLine(invitation)}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <GlassButton
                size="sm"
                aria-label={acceptLabel(invitation)}
                loading={mine === "accept"}
                disabled={busy !== null}
                onClick={() => void respond(invitation, "accept")}
              >
                Accept
              </GlassButton>
              <GlassButton
                size="sm"
                variant="ghost"
                aria-label={declineLabel(invitation)}
                loading={mine === "decline"}
                disabled={busy !== null}
                onClick={() => void respond(invitation, "decline")}
              >
                Decline
              </GlassButton>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const headingCls = "rounded-input font-semibold text-ink outline-none focus-visible:focus-ring";

/**
 * The project invitations waiting for the signed-in person, above the project
 * list. Nothing reaches this device without an answer here: accepting is the
 * only way into someone else's project.
 *
 * Shows nothing while no invitation is waiting. What an answer did is said in
 * a toast, because the list itself may be gone by then. For the same reason
 * `focusAfter` names something on the page that outlives the list (the page's
 * own heading): it takes the focus when the last invitation is answered, so
 * a keyboard or screen-reader user is not dropped back to the top of the page.
 */
export function InvitationList({ onAccepted, focusAfter }: { onAccepted?: () => void; focusAfter?: RefObject<HTMLElement> }) {
  const items = useInvitations((s) => s.items);
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const responding = useResponding({
    onDone: (text, answer) => (answer === "accept" ? toast.success(text) : toast.info(text)),
    onAccepted,
    fallbackFocus: heading,
    outerFocus: focusAfter,
  });

  if (items.length === 0 && responding.error === null) return null;

  return (
    <section aria-labelledby={headingId} className="glass-1 mb-4 rounded-card p-4">
      <div className="mb-3 flex items-center gap-3">
        <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-input bg-primary-soft text-primary">
          <Mail className="h-4 w-4" />
        </span>
        <h2 ref={heading} id={headingId} tabIndex={-1} className={`text-base ${headingCls}`}>
          Invitations
        </h2>
      </div>
      {responding.error && (
        <div className="mb-3 flex flex-wrap items-start gap-2">
          <div className="min-w-0 flex-1">
            <ErrorNote>{responding.error}</ErrorNote>
          </div>
          {items.length === 0 && (
            <GlassButton size="sm" variant="soft" onClick={responding.dismissError}>
              OK
            </GlassButton>
          )}
        </div>
      )}
      {items.length > 0 && (
        <>
          <Rows items={items} responding={responding} />
          <p className="mt-3 text-xs text-ink-soft">{INVITATION_HELP}</p>
        </>
      )}
    </section>
  );
}

const DIALOG_TITLE_ID = "invitations-title";

/**
 * The same invitations in a dialog, opened from the account menu. It stays up
 * when the list empties, and says in place what an answer did: a toast would
 * sit behind it.
 */
export function InvitationsDialog({ onClose }: { onClose: () => void }) {
  const items = useInvitations((s) => s.items);
  const loaded = useInvitations((s) => s.loaded);
  const email = useSession((s) => s.profile?.email ?? "");
  const heading = useRef<HTMLHeadingElement>(null);
  const [checking, setChecking] = useState(true);
  const [done, setDone] = useState<{ id: number; text: string } | null>(null);
  const responding = useResponding({
    onDone: (text) => setDone((last) => ({ id: (last?.id ?? 0) + 1, text })),
    fallbackFocus: heading,
  });

  // The list is read at every sync. Opening this asks once more, so it is not a minute old.
  useEffect(() => {
    let live = true;
    void useInvitations
      .getState()
      .refresh()
      .finally(() => {
        if (live) setChecking(false);
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <GlassOverlay
      open
      onClose={onClose}
      labelledBy={DIALOG_TITLE_ID}
      className="max-h-[calc(100dvh-2rem)] w-full !max-w-lg overflow-y-auto !p-5 sm:!p-6"
    >
      <div className="mb-4 flex items-center gap-2">
        <Mail className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
        <h2 ref={heading} id={DIALOG_TITLE_ID} tabIndex={-1} className={`mr-auto text-lg ${headingCls}`}>
          Invitations
        </h2>
        <GlassButton variant="ghost" size="sm" aria-label="Close" onClick={onClose} className="!px-2">
          <X className="h-5 w-5" aria-hidden="true" />
        </GlassButton>
      </div>

      {/* Always present, so that what it comes to hold is announced. */}
      <p role="status" aria-live="polite" className={done ? "mb-3 text-sm font-medium text-ink" : undefined}>
        {done && (
          <span key={done.id} className="inline-flex items-start gap-1.5">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {done.text}
          </span>
        )}
      </p>

      <div className="flex flex-col gap-3">
        {responding.error && <ErrorNote>{responding.error}</ErrorNote>}

        {items.length > 0 ? (
          <>
            <Rows items={items} responding={responding} />
            <p className="text-xs text-ink-soft">{INVITATION_HELP}</p>
          </>
        ) : checking ? (
          <Spinner label="Checking for invitations…" />
        ) : loaded ? (
          <EmptyState
            title="No invitations"
            hint={
              email
                ? `When someone invites ${email} to a project, the invitation appears here.`
                : "When someone invites you to a project, the invitation appears here."
            }
          />
        ) : (
          <p className="text-sm text-ink-soft">Scholea could not check for invitations just now. It checks again the next time it syncs.</p>
        )}
      </div>
    </GlassOverlay>
  );
}
