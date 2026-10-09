/**
 * What the Share dialog, the invitation list and the runner say about a
 * project's place in an account, worked out from the session, the project's
 * link and what the backend returned. All pure, so the wording and the rules
 * behind it are unit-tested without a screen.
 */
import type { AuthStep } from "@/lib/account/auth-flow";
import { owesPassword } from "@/lib/account/auth-ui";
import type { SessionPhase } from "@/lib/account/types";
import { describeInviteError, type MyInvitation } from "./invitations";
import { awaitsFirstUpload, type Link } from "./links";
import { ROLE_LABEL, SyncError, canEdit, describeSyncError, type Member, type ProjectRole } from "./sync";

// --- What the Share dialog shows -------------------------------------------------------

/**
 * - `unavailable`: this build has no backend.
 * - `checking`: a saved session is still being checked.
 * - `signIn`: nobody is signed in, or the account screens are in the middle of
 *   something (see `accountScreensActive`): they are shown inside the dialog.
 * - `accountDialog`: the account screens are already open in their own dialog,
 *   so they are not shown a second time here.
 * - `password`: signed in, but a password is still owed and its step is closed.
 * - `otherAccount`: the project belongs to a different account on this device.
 * - `device`: the project is only on this device. "Add to my account" is offered.
 * - `adding`: the project is on its way into the account, but its content has
 *   not been uploaded there yet. Nobody is invited to a project the account
 *   holds nothing of.
 * - `account`: the project is in the signed-in person's account.
 */
export type ShareStage =
  | { kind: "unavailable" }
  | { kind: "checking" }
  | { kind: "signIn" }
  | { kind: "accountDialog" }
  | { kind: "password" }
  | { kind: "otherAccount" }
  | { kind: "device" }
  | { kind: "adding" }
  | { kind: "account"; serverId: string };

export function shareStage(input: {
  phase: SessionPhase;
  /** Who is signed in, or `null`. */
  userId: string | null;
  /** The session says the person still has to settle their password. */
  owesPassword: boolean;
  /** The account screens are in the middle of something. See `accountScreensActive`. */
  screensActive: boolean;
  /** The account screens are showing in their own dialog. */
  accountDialogOpen: boolean;
  link: Link | null | undefined;
}): ShareStage {
  if (input.phase === "unconfigured") return { kind: "unavailable" };
  if (input.phase === "loading") return { kind: "checking" };
  if (input.phase !== "ready" || input.userId === null || input.screensActive) {
    return { kind: input.accountDialogOpen ? "accountDialog" : "signIn" };
  }
  if (input.owesPassword) return { kind: "password" };

  const link = input.link;
  if (link?.kind !== "account") return { kind: "device" };
  if (link.owner !== input.userId) return { kind: "otherAccount" };
  return awaitsFirstUpload(link) ? { kind: "adding" } : { kind: "account", serverId: link.serverId };
}

/**
 * Whether the account screens are in the middle of something that the session
 * alone does not show: a step that settles the password, or a request that is
 * still under way on a later step than the plain sign-in form.
 *
 * The second half matters while a code is being checked. The session says
 * "signed in" as soon as the code is accepted, a moment before the password is
 * settled. Without this the dialog would drop the form the person is on, offer
 * the project to an account that is not secured yet, and bring the form back.
 * On the plain sign-in form there is nothing to protect: by the time the
 * session says "signed in" there, the screens are done.
 */
export function accountScreensActive(flow: AuthStep, busy: boolean): boolean {
  return owesPassword(flow) || (busy && flow.step !== "signIn");
}

/** What to tell someone who has to sign in before they can share. */
export function signInPrompt(link: Link | null | undefined): string {
  // Signed out without asking: the project is in an account already.
  if (link?.kind === "account") return "Sign in again to share this project or manage its team.";
  return "Sharing needs an account. Your project stays on this device until you choose to add it.";
}

export const DEVICE_ONLY_MESSAGE = "This project is only on this device. Add it to your account to invite collaborators.";
export const ADDING_MESSAGE = "Adding this project to your account…";
export const OTHER_ACCOUNT_MESSAGE = "This project belongs to a different account. Sign in to that account to share it.";
export const PASSWORD_FIRST_MESSAGE = "Choose a password for your account first. Then you can share this project.";

// --- Roles and members -------------------------------------------------------------------

/** "an Owner", "a Viewer": a role as it reads inside a sentence. */
export function roleWithArticle(role: ProjectRole): string {
  const label = ROLE_LABEL[role];
  return `${/^[AEIOU]/.test(label) ? "an" : "a"} ${label}`;
}

/** The roles an owner can give to someone who is already a member. */
export const MEMBER_ROLES: readonly ProjectRole[] = ["viewer", "editor", "supervisor", "owner"];

export interface ShareStatus {
  /** True once somebody other than the person has access. */
  shared: boolean;
  label: string;
}

/** The chip at the top of the Share dialog. */
export function shareStatus(role: ProjectRole | null, members: readonly Pick<Member, "user_id">[]): ShareStatus {
  // Anyone who is not an owner is in somebody else's project by definition.
  const shared = members.length > 1 || (role !== null && role !== "owner");
  if (!shared) return { shared, label: "In your account · not shared yet" };
  return { shared, label: `Shared · you are ${role ? roleWithArticle(role) : "a member"}` };
}

/** True when the person is an owner and nobody else is. */
export function isOnlyOwner(members: readonly Pick<Member, "user_id" | "role">[], userId: string | null): boolean {
  const owners = members.filter((m) => m.role === "owner");
  return owners.length === 1 && owners[0].user_id === userId;
}

/** Whether "Leave project" is offered: to every member except the only owner. */
export function canLeave(members: readonly Pick<Member, "user_id" | "role">[], userId: string | null): boolean {
  return members.some((m) => m.user_id === userId) && !isOnlyOwner(members, userId);
}

/**
 * Whether the person may change this member's role or remove them: an owner
 * may, for anyone who is not an owner. Another owner's place is not offered
 * here, and neither is the person's own (they leave instead).
 */
export function canManageMember(myRole: ProjectRole | null, member: Pick<Member, "user_id" | "role">, userId: string | null): boolean {
  return myRole === "owner" && member.role !== "owner" && member.user_id !== userId;
}

// --- Who did something ---------------------------------------------------------------------

/** The name to show for a member: their name, or their address when they gave none. */
export function memberName(member: Pick<Member, "name" | "email">): string {
  return member.name.trim() || member.email.trim() || "Deleted user";
}

/** A member's name with their address, where a label has to tell two people apart. */
export function memberLabel(member: Pick<Member, "name" | "email">): string {
  const name = memberName(member);
  const email = member.email.trim();
  return email !== "" && email !== name ? `${name} (${email})` : name;
}

export interface Person {
  name: string;
  /** What tells this person apart from someone with the same name. Empty when there is nothing to add. */
  detail: string;
}

/**
 * Who an entry in the team's ledger belongs to. Names are free text and two
 * members may share one, so the account id decides: it is looked up in the
 * member list, and the member's current name is shown with their address (or
 * their role, when the name is the address). An account that is no longer on
 * the project keeps the name the entry was written under, and says so.
 */
export function personOf(actorId: string | null, storedName: string, members: readonly Member[]): Person {
  const member = actorId === null ? undefined : members.find((m) => m.user_id === actorId);
  if (member) {
    const name = memberName(member);
    const email = member.email.trim();
    return { name, detail: email !== "" && email !== name ? email : ROLE_LABEL[member.role] };
  }
  // No account behind the entry any more: only the name it was written under is left.
  if (actorId === null) return { name: storedName.trim() || "Deleted user", detail: "" };
  return { name: storedName.trim() || "Someone", detail: "no longer a member" };
}

export function personLabel(person: Person): string {
  return person.detail ? `${person.name} (${person.detail})` : person.name;
}

function roleFromDetail(detail: string | null): ProjectRole | null {
  return detail !== null && Object.hasOwn(ROLE_LABEL, detail) ? (detail as ProjectRole) : null;
}

const TEAM_ACTION: Record<string, string> = {
  "project.create": "created the project",
  "content.sync": "saved changes",
  "ownership.set": "assigned a step",
  "comment.add": "commented",
  "review.approve": "approved a step",
  "review.request_changes": "requested changes",
};

/** What somebody did, for the team's ledger. `detail` is the role for invitations and joins. */
export function describeTeamAction(action: string, detail: string | null): string {
  if (action === "member.invite") {
    const role = roleFromDetail(detail);
    return role ? `invited someone as ${roleWithArticle(role)}` : "invited someone";
  }
  if (action === "member.join") {
    const role = roleFromDetail(detail);
    return role ? `joined as ${roleWithArticle(role)}` : "joined the project";
  }
  return Object.hasOwn(TEAM_ACTION, action) ? TEAM_ACTION[action] : action.replace(/[._]/g, " ");
}

// --- Inviting, cancelling, leaving -----------------------------------------------------------

export const INVITE_HELP =
  "Scholea does not send an email, so tell the person yourself. They will see the invitation in Scholea when they sign in with this address, even if they create their account later. Invitations expire after 30 days.";

/** Under the owner's list of open invitations. A decline is never shown to the owner, so this is the way out. */
export const PENDING_HELP = "If someone cannot see their invitation, cancel it and invite them again.";

export function inviteSavedMessage(email: string): string {
  return `Invitation saved for ${email}. Scholea has not emailed them.`;
}

/** Why an invitation could not be cancelled. */
export function describeCancelError(e: unknown): string {
  // Accepted in the meantime, or cancelled from another device.
  if (e instanceof SyncError && e.code === "not_found") return "That invitation is no longer open.";
  return describeInviteError(e, "manage");
}

export const ONLY_OWNER_MESSAGE = "You are the only owner. Make someone else an owner before you leave.";

export const LEAVE_TITLE = "Leave this project?";

/** The body of the "Leave this project?" confirmation. */
export function leaveBody(title: string): string {
  const name = title.trim() || "this project";
  return `You will lose access to ${name}. The rest of the team keeps their copy. What is on this device now stays here as a copy that no longer syncs.`;
}

export const LEFT_MESSAGE = "You left the project. The copy on this device no longer syncs.";

/** Why leaving did not work. */
export function describeLeaveError(e: unknown): string {
  if (e instanceof SyncError && e.code === "last_owner") return ONLY_OWNER_MESSAGE;
  if (e instanceof SyncError && e.code === "not_found") return "You are no longer a member of this project.";
  return describeSyncError(e);
}

// --- Changes to the team that are asked about first ---------------------------------------------

/** What an owner, or a member who wants to leave, is asked to confirm. */
export type TeamConfirm =
  | { kind: "remove"; member: Pick<Member, "name" | "email"> }
  | { kind: "promote"; member: Pick<Member, "name" | "email"> }
  | { kind: "leave" };

export interface ConfirmCopy {
  title: string;
  body: string;
  confirmLabel: string;
  /** The change takes something away. */
  danger: boolean;
}

export function confirmCopy(ask: TeamConfirm, projectTitle: string): ConfirmCopy {
  if (ask.kind === "leave") {
    return { title: LEAVE_TITLE, body: leaveBody(projectTitle), confirmLabel: "Leave project", danger: true };
  }
  const name = memberName(ask.member);
  if (ask.kind === "remove") {
    return {
      title: `Remove ${name}?`,
      body: `${memberLabel(ask.member)} will lose access to this project. What is already on their devices stays there as a copy that no longer syncs.`,
      confirmLabel: "Remove",
      danger: true,
    };
  }
  return {
    title: `Make ${name} an owner?`,
    body: "Owners can invite and remove people, change roles, and delete the project for everyone. An owner cannot be removed or given another role here.",
    confirmLabel: "Make owner",
    danger: false,
  };
}

/** What to say once a member's role has changed. */
export function roleChangedMessage(member: Pick<Member, "name" | "email">, role: ProjectRole): string {
  return `${memberName(member)} is now ${roleWithArticle(role)}.`;
}

export function removedMessage(member: Pick<Member, "name" | "email">): string {
  return `${memberName(member)} was removed from the project.`;
}

export function cancelledMessage(email: string): string {
  return `Invitation for ${email} cancelled.`;
}

/**
 * A refusal that says the team is not what this device last saw: someone else
 * changed it, or the person's own place on it. The team is then read again.
 */
export function isStaleTeam(e: unknown): boolean {
  return e instanceof SyncError && ["not_found", "not_a_member", "forbidden", "last_owner"].includes(e.code);
}

// --- Invitations waiting for the person ------------------------------------------------------

export const INVITATION_HELP =
  "Accepting adds the project to your account and downloads it to this device. Only accept invitations from people you know.";
export const INVITATION_ACCEPTED = "Added. Downloading the project.";
export const INVITATION_DECLINED = "Invitation declined.";

function invitedTitle(invitation: Pick<MyInvitation, "project_title">): string {
  return invitation.project_title.trim() || "Untitled project";
}

/** `Ada (ada@example.org) invited you to "Sleep and recall" as Editor.` */
export function invitationSentence(invitation: Pick<MyInvitation, "inviter_name" | "inviter_email" | "project_title" | "role">): string {
  const name = invitation.inviter_name.trim();
  const email = invitation.inviter_email.trim();
  // The address is what tells two people with the same name apart.
  const who = name && email && name !== email ? `${name} (${email})` : name || email || "Someone";
  return `${who} invited you to "${invitedTitle(invitation)}" as ${ROLE_LABEL[invitation.role]}.`;
}

/** Accessible names for the two buttons of an invitation: they say which project. */
export function acceptLabel(invitation: Pick<MyInvitation, "project_title">): string {
  return `Accept invitation to ${invitedTitle(invitation)}`;
}

export function declineLabel(invitation: Pick<MyInvitation, "project_title">): string {
  return `Decline invitation to ${invitedTitle(invitation)}`;
}

/** A day, written out: "7 Nov 2026". */
export function formatDay(ms: number, locale?: string, timeZone?: string): string {
  return new Date(ms).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric", ...(timeZone ? { timeZone } : {}) });
}

// --- The open project, in the runner -----------------------------------------------------------

/** `account`: the project is in the signed-in person's account. `device`: it is saved here and nowhere else right now. */
export type SaveBadge = "device" | "account";

export const SAVE_BADGE_LABEL: Record<SaveBadge, string> = {
  device: "Saved on this device",
  account: "Synced to your account",
};

/** The badge beside the open project's actions. */
export function saveBadge(link: Link | null | undefined, signedInId: string | null): SaveBadge {
  // Not uploaded to the account yet, or its account is signed out: it is only saved here for now.
  return link?.kind === "account" && !awaitsFirstUpload(link) && signedInId !== null && link.owner === signedInId ? "account" : "device";
}

export const VIEW_ONLY_NOTICE = "You can view this project. Changes you make here are not saved to the shared project.";

/** Whether the open project is one the person can read but not change: they are a viewer or a supervisor on it. */
export function isViewOnly(link: Link | null | undefined): boolean {
  return link?.kind === "account" && !canEdit(link.role);
}
