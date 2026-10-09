import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { AlertTriangle, CheckCircle2, CloudOff, Lock, MessageSquare, RefreshCw, Send, ShieldCheck } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { useSession } from "@/lib/account/session-store";
import { useIdentity } from "@/lib/collab/identity-store";
import {
  addComment,
  discardUnsent,
  formatWhen,
  getCollabSync,
  getReview,
  listComments,
  listUnsent,
  retryUnsent,
  setReview,
} from "@/lib/collab/collab";
import {
  COMMENT_MAX,
  HELD_NOTE,
  NOTE_MAX,
  READONLY_NOTE,
  REFRESH_SYNC_MS,
  UNSENT_REVIEW_HINT,
  canRetry,
  describeUnsentError,
  effectiveReview,
  gateNote,
  mergeThread,
  pendingHint,
  reviewGate,
  teamSyncAnnouncement,
  teamSyncLine,
  viewerOf,
  type ThreadItem,
} from "@/lib/collab/collab-plan";
import { requestCollabSync, useCollabMode } from "@/lib/collab/collab-sync";
import { useSyncStatus } from "@/lib/collab/project-sync";
import { personOf, type Person } from "@/lib/collab/share-view";
import { ROLE_LABEL, type Member, type ProjectRole } from "@/lib/collab/sync";
import type { CollabMember, CollaboratorRole, Comment, OutboxItem } from "@/lib/db/schema";

const NO_COMMENTS: Comment[] = [];
const NO_UNSENT: OutboxItem[] = [];

const inputCls = "w-full rounded-input border border-hairline bg-elevated/70 px-3 text-sm text-ink outline-none focus-visible:focus-ring";
const hintCls = "flex items-start gap-1.5 text-xs text-ink-soft";
const noteCls = "mt-3 flex items-start gap-2 rounded-input border border-hairline bg-elevated/40 p-3 text-sm text-ink-soft";

/** The stored team as the member list `personOf` reads. */
function teamOf(members: CollabMember[] | undefined): Member[] | null {
  if (!members) return null;
  return members.map((m) => ({
    project_id: "",
    user_id: m.id,
    email: m.email,
    name: m.name,
    role: Object.hasOwn(ROLE_LABEL, m.role) ? (m.role as ProjectRole) : "viewer",
    added_at: 0,
  }));
}

/**
 * Per-step discussion + supervisor review (§10).
 *
 * On a project kept on this device, comments and sign-offs are attributed to
 * the local identity and stored offline, and whoever chose the supervisor role
 * here can approve a step or request changes.
 *
 * On a project in the signed-in person's account the discussion is the
 * team's: it is read from this device's copy, which sync keeps up to date,
 * and what the person writes is queued and uploaded. Their name comes from the
 * account, and only their role on the project decides whether they may sign
 * off.
 */
export function StepCollab({ projectId, stepId }: { projectId: string; stepId: string }) {
  // One thread per step: nothing of another step's discussion or drafts shows here, even for a moment.
  return <StepThread key={`${projectId}:${stepId}`} projectId={projectId} stepId={stepId} />;
}

function StepThread({ projectId, stepId }: { projectId: string; stepId: string }) {
  const name = useIdentity((s) => s.name);
  const role = useIdentity((s) => s.role);
  const setName = useIdentity((s) => s.setName);
  const setRole = useIdentity((s) => s.setRole);
  const isSet = name.trim() !== "";

  const mode = useCollabMode(projectId);
  const viewer = viewerOf(mode);
  const offline = useSyncStatus((s) => s.state === "offline");
  const suspended = useSession((s) => s.notice === "suspended");

  // Read live from this device: sync writes there, and the thread follows.
  // A read that fails leaves the thread as it is instead of breaking the step.
  const stored = useLiveQuery(() => listComments(projectId, stepId).catch(() => NO_COMMENTS), [projectId, stepId], NO_COMMENTS);
  const storedReview = useLiveQuery(
    () =>
      getReview(projectId, stepId).then(
        (r) => r ?? null,
        () => null,
      ),
    [projectId, stepId],
    null,
  );
  const unsent = useLiveQuery(() => listUnsent(projectId, stepId).catch(() => NO_UNSENT), [projectId, stepId], NO_UNSENT);
  const syncRow = useLiveQuery(
    () =>
      getCollabSync(projectId).then(
        (r) => r ?? null,
        () => null,
      ),
    [projectId],
    null,
  );

  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [cooling, setCooling] = useState(false);
  const cooldown = useRef<ReturnType<typeof setTimeout> | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const ids = useId();

  useEffect(
    () => () => {
      if (cooldown.current) clearTimeout(cooldown.current);
    },
    [],
  );

  const thread = useMemo(() => mergeThread(stored, unsent, viewer), [stored, unsent, viewer]);
  const review = useMemo(() => effectiveReview(storedReview, unsent, viewer), [storedReview, unsent, viewer]);
  const gate = reviewGate(mode, role);
  // Names are free text. On an account project the account behind a row says who wrote it.
  const team = useMemo(() => (mode.kind === "local" ? null : teamOf(syncRow?.members)), [mode.kind, syncRow]);
  const who = (accountId: string | undefined, storedName: string): Person =>
    team ? personOf(accountId ?? null, storedName, team) : { name: storedName, detail: "" };

  // A waiting row that is retried or discarded takes its buttons with it. Keep the keyboard in the discussion.
  const settle = useRef(false);
  useEffect(() => {
    if (!settle.current) return;
    settle.current = false;
    if (document.activeElement === document.body) title.current?.focus();
  }, [thread, review]);

  const submitComment = async () => {
    if (!draft.trim() || mode.kind === "readonly" || (mode.kind === "local" && !isSet)) return;
    setBusy(true);
    try {
      if (await addComment(projectId, stepId, draft, mode)) setDraft("");
      if (mode.kind === "account") void requestCollabSync(projectId);
    } finally {
      setBusy(false);
    }
  };

  const submitReview = async (status: "approved" | "changes") => {
    setBusy(true);
    try {
      if (await setReview(projectId, stepId, status, note, mode)) setNote("");
      if (mode.kind === "account") void requestCollabSync(projectId);
    } finally {
      setBusy(false);
    }
  };

  const retry = async (uid: string) => {
    settle.current = true;
    await retryUnsent(uid);
    void requestCollabSync(projectId);
  };

  const discard = async (uid: string) => {
    settle.current = true;
    await discardUnsent(uid);
  };

  const refresh = () => {
    if (cooling) return;
    setCooling(true);
    setChecking(true);
    cooldown.current = setTimeout(() => setCooling(false), REFRESH_SYNC_MS);
    void requestCollabSync(projectId).finally(() => setChecking(false));
  };

  const current = review?.current ?? null;
  const failed = review?.failed ?? null;
  const reviewer = current ? who(current.reviewerId, current.reviewer) : null;
  const held = mode.kind === "account" ? syncRow?.error === "account_suspended" : suspended && thread.some((item) => item.state === "pending");

  return (
    <section aria-labelledby="collab-title" className="border-t border-hairline pt-4">
      <h3
        id="collab-title"
        ref={title}
        tabIndex={-1}
        className="flex items-center gap-2 rounded-input text-sm font-semibold text-ink outline-none focus-visible:focus-ring"
      >
        <MessageSquare className="h-4 w-4 text-primary" aria-hidden="true" />
        Discussion &amp; review
        {thread.length > 0 && <span className="rounded-pill bg-elevated px-1.5 py-0.5 text-xs font-medium text-ink-muted">{thread.length}</span>}
      </h3>

      {/* Current review status */}
      {current && reviewer && (
        <div
          className={`mt-3 flex items-start gap-2 rounded-input p-3 text-sm ${current.status === "approved" ? "bg-success-soft" : "bg-warning-soft"}`}
        >
          {current.status === "approved" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          )}
          <div>
            <p className="font-medium text-ink">
              {current.status === "approved" ? "Approved" : "Changes requested"} by {reviewer.name}
              {reviewer.detail && <span className="ml-1 font-normal text-ink-soft">({reviewer.detail})</span>}
              <span className="ml-1 font-normal text-ink-muted">· {formatWhen(current.timestamp)}</span>
            </p>
            {current.note && <p className="mt-0.5 text-ink-soft">{current.note}</p>}
            {current.state === "pending" && (
              <p className={`mt-1.5 ${hintCls}`}>
                <CloudOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{UNSENT_REVIEW_HINT}</span>
              </p>
            )}
          </div>
        </div>
      )}

      {/* The person's own sign-off that was held back or refused */}
      {failed && (
        <div className="mt-3 rounded-input border border-hairline bg-warning-soft p-3 text-sm">
          <p id={`${ids}-signoff`} className="flex items-start gap-2 text-ink">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <span>{describeUnsentError("review", failed.error)}</span>
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {canRetry(failed.error) && (
              <GlassButton size="sm" variant="soft" aria-describedby={`${ids}-signoff`} onClick={() => void retry(failed.uid)}>
                Try again
              </GlassButton>
            )}
            <GlassButton size="sm" variant="ghost" aria-describedby={`${ids}-signoff`} onClick={() => void discard(failed.uid)}>
              Discard
            </GlassButton>
          </div>
        </div>
      )}

      {/* Comments */}
      {thread.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2.5">
          {thread.map((item) => (
            <ThreadRow
              key={item.key}
              item={item}
              person={who(item.authorId, item.author)}
              offline={offline}
              describedBy={`${ids}-${item.key}`}
              onRetry={retry}
              onDiscard={discard}
            />
          ))}
        </ul>
      )}

      {mode.kind === "readonly" ? (
        // The project's account is not signed in: nothing typed under a device name may join a team's thread.
        <p role="note" className={noteCls}>
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{held ? HELD_NOTE : READONLY_NOTE}</span>
        </p>
      ) : mode.kind === "local" && !isSet ? (
        /* Identity prompt (first time) */
        <div className="mt-3 rounded-input border border-hairline bg-elevated/40 p-3">
          <p className="text-sm text-ink">Add your name to join the discussion and attribute your work.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="Your name"
              aria-label="Your name"
              className="min-w-[10rem] flex-1 rounded-input border border-hairline bg-elevated/70 px-3 py-1.5 text-sm text-ink outline-none focus-visible:focus-ring"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as CollaboratorRole)}
              aria-label="Your role"
              className="rounded-input border border-hairline bg-elevated/70 px-2 py-1.5 text-sm text-ink outline-none focus-visible:focus-ring"
            >
              <option value="researcher">Researcher</option>
              <option value="supervisor">Supervisor</option>
            </select>
            <GlassButton size="sm" onClick={() => setName(nameDraft)} disabled={!nameDraft.trim()}>Save</GlassButton>
          </div>
        </div>
      ) : (
        <>
          {held && (
            <p role="note" className={noteCls}>
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
              <span>{HELD_NOTE}</span>
            </p>
          )}

          {/* Comment composer */}
          <div className="mt-3">
            <label htmlFor="collab-comment" className="sr-only">Add a comment</label>
            <textarea
              id="collab-comment"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              maxLength={COMMENT_MAX}
              placeholder={`Comment as ${mode.kind === "account" ? mode.me.name : name}…`}
              className={`${inputCls} py-2`}
            />
            <div className="mt-1.5 flex justify-end">
              <GlassButton size="sm" variant="soft" onClick={submitComment} loading={busy} disabled={!draft.trim()}>
                <Send className="h-3.5 w-3.5" aria-hidden="true" /> Comment
              </GlassButton>
            </div>
          </div>

          {/* Supervisor sign-off */}
          {gate.show &&
            (gate.allowed ? (
              <div className="mt-3 rounded-input border border-accent/30 bg-accent-soft/30 p-3">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-accent">
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> Supervisor sign-off
                </p>
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={NOTE_MAX}
                  placeholder="Optional note for the researcher"
                  aria-label="Review note"
                  className={`mt-2 ${inputCls} py-1.5`}
                />
                <div className="mt-2 flex flex-wrap gap-2">
                  <GlassButton size="sm" onClick={() => submitReview("approved")} loading={busy}>
                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Approve step
                  </GlassButton>
                  <GlassButton size="sm" variant="soft" onClick={() => submitReview("changes")} loading={busy}>
                    <AlertTriangle className="h-4 w-4" aria-hidden="true" /> Request changes
                  </GlassButton>
                </div>
              </div>
            ) : (
              (gate.reason === "viewer" || gate.reason === "editor") && (
                // Shown instead of buttons that would only be refused.
                <p role="note" className={noteCls}>
                  <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{gateNote(gate.reason)}</span>
                </p>
              )
            ))}
        </>
      )}

      {/* How fresh the team's side is. Only an account project has one. */}
      {mode.kind === "account" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p className="mr-auto text-xs text-ink-soft">{teamSyncLine({ pulledAt: syncRow?.pulledAt ?? null, offline }, formatWhen)}</p>
          {/* Announced when the state changes, not every time the "5m ago" above moves on. */}
          <p role="status" className="sr-only">
            {teamSyncAnnouncement({ pulledAt: syncRow?.pulledAt ?? null, offline })}
          </p>
          <GlassButton
            variant="ghost"
            size="sm"
            aria-label="Refresh: check for new comments"
            aria-disabled={cooling || undefined}
            onClick={refresh}
            className={cooling ? "cursor-not-allowed opacity-50" : ""}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${checking ? "animate-spin motion-reduce:animate-none" : ""}`} aria-hidden="true" /> Refresh
          </GlassButton>
        </div>
      )}
    </section>
  );
}

function ThreadRow({
  item,
  person,
  offline,
  describedBy,
  onRetry,
  onDiscard,
}: {
  item: ThreadItem;
  /** Who wrote it: the stored name, or the member behind it on an account project. */
  person: Person;
  offline: boolean;
  describedBy: string;
  onRetry: (uid: string) => Promise<void>;
  onDiscard: (uid: string) => Promise<void>;
}) {
  const { uid, error } = item;
  return (
    <li className="rounded-input bg-elevated/40 p-2.5">
      {/* A team row can carry an address beside the name, so its line may wrap. */}
      <p className={`flex items-center gap-1.5 text-xs ${item.state === "local" ? "" : "flex-wrap"}`}>
        <span className="font-semibold text-ink">{person.name}</span>
        {person.detail && <span className="text-ink-soft">({person.detail})</span>}
        {item.state === "local" && item.role === "supervisor" && (
          <span className="inline-flex items-center gap-0.5 rounded-pill bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent">
            <ShieldCheck className="h-2.5 w-2.5" aria-hidden="true" /> Supervisor
          </span>
        )}
        <span className="text-ink-muted">· {formatWhen(item.timestamp)}</span>
      </p>
      <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{item.text}</p>
      {item.state === "pending" && (
        <p className={`mt-1.5 ${hintCls}`}>
          <CloudOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{pendingHint(offline)}</span>
        </p>
      )}
      {item.state === "failed" && uid && error && (
        <div className="mt-1.5">
          <p id={describedBy} className="flex items-start gap-1.5 text-xs text-ink">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
            <span>{describeUnsentError("comment", error)}</span>
          </p>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <GlassButton size="sm" variant="soft" aria-describedby={describedBy} onClick={() => void onRetry(uid)}>
              Try again
            </GlassButton>
            <GlassButton size="sm" variant="ghost" aria-describedby={describedBy} onClick={() => void onDiscard(uid)}>
              Discard
            </GlassButton>
          </div>
        </div>
      )}
    </li>
  );
}
