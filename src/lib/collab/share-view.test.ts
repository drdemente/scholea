import { describe, expect, it } from "vitest";
import type { MyInvitation } from "./invitations";
import type { Link } from "./links";
import {
  ADDING_MESSAGE,
  DEVICE_ONLY_MESSAGE,
  INVITATION_ACCEPTED,
  INVITATION_DECLINED,
  INVITATION_HELP,
  INVITE_HELP,
  LEAVE_TITLE,
  LEFT_MESSAGE,
  MEMBER_ROLES,
  ONLY_OWNER_MESSAGE,
  OTHER_ACCOUNT_MESSAGE,
  PASSWORD_FIRST_MESSAGE,
  PENDING_HELP,
  SAVE_BADGE_LABEL,
  VIEW_ONLY_NOTICE,
  acceptLabel,
  accountScreensActive,
  canLeave,
  canManageMember,
  declineLabel,
  describeCancelError,
  describeLeaveError,
  cancelledMessage,
  confirmCopy,
  describeTeamAction,
  formatDay,
  invitationSentence,
  inviteSavedMessage,
  isOnlyOwner,
  isStaleTeam,
  isViewOnly,
  leaveBody,
  memberLabel,
  memberName,
  personLabel,
  personOf,
  removedMessage,
  roleChangedMessage,
  roleWithArticle,
  saveBadge,
  shareStage,
  shareStatus,
  signInPrompt,
} from "./share-view";
import { SyncError, type Member, type ProjectRole } from "./sync";

const ADA = "user-ada";
const BOB = "user-bob";

const account = (role: ProjectRole, over: Partial<Extract<Link, { kind: "account" }>> = {}): Link => ({
  kind: "account",
  owner: ADA,
  serverId: "proj_x",
  rev: 1,
  created: true,
  role,
  ...over,
});

const member = (user_id: string, role: ProjectRole, name = "", email = ""): Member => ({
  project_id: "proj_x",
  user_id,
  role,
  name,
  email,
  added_at: 1,
});

describe("shareStage", () => {
  const signedIn = { phase: "ready" as const, userId: ADA, owesPassword: false, screensActive: false, accountDialogOpen: false };

  it("has nothing to offer in a build with no backend", () => {
    expect(shareStage({ ...signedIn, phase: "unconfigured", userId: null, link: null })).toEqual({ kind: "unavailable" });
  });

  it("waits while a saved session is being checked", () => {
    expect(shareStage({ ...signedIn, phase: "loading", userId: null, link: account("owner") })).toEqual({ kind: "checking" });
  });

  it("asks a guest to sign in, whatever the project's link says", () => {
    for (const link of [null, undefined, { kind: "device", asked: true } as Link, account("owner")]) {
      expect(shareStage({ ...signedIn, phase: "anon", userId: null, link })).toEqual({ kind: "signIn" });
    }
  });

  it("never shows the account screens twice", () => {
    expect(shareStage({ ...signedIn, phase: "anon", userId: null, accountDialogOpen: true, link: null })).toEqual({ kind: "accountDialog" });
    expect(shareStage({ ...signedIn, screensActive: true, accountDialogOpen: true, link: account("owner") })).toEqual({
      kind: "accountDialog",
    });
  });

  it("keeps the account screens up while they are in the middle of something, though the person is signed in by then", () => {
    expect(shareStage({ ...signedIn, owesPassword: true, screensActive: true, link: null })).toEqual({ kind: "signIn" });
    expect(shareStage({ ...signedIn, screensActive: true, link: account("owner") })).toEqual({ kind: "signIn" });
    expect(shareStage({ ...signedIn, screensActive: true, link: { kind: "device", asked: false } })).toEqual({ kind: "signIn" });
  });

  it("holds sharing back while a password is owed and its step is closed", () => {
    expect(shareStage({ ...signedIn, owesPassword: true, link: account("owner") })).toEqual({ kind: "password" });
    expect(shareStage({ ...signedIn, owesPassword: true, link: null })).toEqual({ kind: "password" });
  });

  it("offers to add a project that is only on this device", () => {
    expect(shareStage({ ...signedIn, link: null })).toEqual({ kind: "device" });
    expect(shareStage({ ...signedIn, link: undefined })).toEqual({ kind: "device" });
    expect(shareStage({ ...signedIn, link: { kind: "device", asked: false } })).toEqual({ kind: "device" });
    expect(shareStage({ ...signedIn, link: { kind: "device", asked: true } })).toEqual({ kind: "device" });
  });

  it("finishes putting a project in the account when the server has not confirmed it", () => {
    expect(shareStage({ ...signedIn, link: account("owner", { created: false }) })).toEqual({ kind: "adding" });
  });

  it("does not open the team view, where people are invited, before the project's content is in the account", () => {
    // Created in the account, and the first upload has not succeeded: the account holds an empty project.
    expect(shareStage({ ...signedIn, link: account("owner", { rev: 0 }) })).toEqual({ kind: "adding" });
    // Uploaded once, or downloaded from the account (even with nothing in it yet): it is there.
    expect(shareStage({ ...signedIn, link: account("owner", { rev: 1, synced: "x" }) })).toEqual({ kind: "account", serverId: "proj_x" });
    expect(shareStage({ ...signedIn, link: account("editor", { rev: 0, synced: "x" }) })).toEqual({ kind: "account", serverId: "proj_x" });
  });

  it("opens the team view for a project in the person's account, under its server id", () => {
    expect(shareStage({ ...signedIn, link: account("owner", { serverId: "proj_abc" }) })).toEqual({ kind: "account", serverId: "proj_abc" });
    expect(shareStage({ ...signedIn, link: account("viewer") })).toEqual({ kind: "account", serverId: "proj_x" });
  });

  it("does not open another account's project", () => {
    expect(shareStage({ ...signedIn, userId: BOB, link: account("owner") })).toEqual({ kind: "otherAccount" });
    expect(shareStage({ ...signedIn, userId: BOB, link: account("owner", { created: false }) })).toEqual({ kind: "otherAccount" });
  });
});

describe("accountScreensActive", () => {
  const EMAIL = "ada@example.test";

  it("is not, on the plain sign-in form, whether or not a request is under way", () => {
    expect(accountScreensActive({ step: "signIn", email: "" }, false)).toBe(false);
    // Signed in a moment ago, or a flow just ended and is saving the name: nothing left to protect.
    expect(accountScreensActive({ step: "signIn", email: EMAIL }, true)).toBe(false);
  });

  it("is, on every step that settles a password, busy or not", () => {
    for (const busy of [false, true]) {
      expect(accountScreensActive({ step: "securing", email: EMAIL, name: "Ada" }, busy)).toBe(true);
      expect(accountScreensActive({ step: "setPassword", email: EMAIL, name: "", via: "secure" }, busy)).toBe(true);
      expect(accountScreensActive({ step: "reset", email: EMAIL, name: "", kind: "recovery", resendAt: 0, reason: "security" }, busy)).toBe(true);
    }
  });

  it("is, while a code is being checked: the session is signed in before the password is settled", () => {
    expect(accountScreensActive({ step: "confirm", email: EMAIL, name: "Ada", resendAt: 0 }, true)).toBe(true);
    expect(accountScreensActive({ step: "reset", email: EMAIL, name: "", kind: "invite", resendAt: 0, reason: "requested" }, true)).toBe(true);
    expect(accountScreensActive({ step: "reset", email: EMAIL, name: "", kind: "recovery", resendAt: 0, reason: "requested" }, true)).toBe(true);
    expect(accountScreensActive({ step: "signUp", email: EMAIL, name: "Ada" }, true)).toBe(true);
  });

  it("is not, on a form that is only waiting to be filled in", () => {
    expect(accountScreensActive({ step: "confirm", email: EMAIL, name: "Ada", resendAt: 0 }, false)).toBe(false);
    expect(accountScreensActive({ step: "reset", email: EMAIL, name: "", kind: "invite", resendAt: 0, reason: "requested" }, false)).toBe(false);
    expect(accountScreensActive({ step: "forgot", email: EMAIL }, false)).toBe(false);
    expect(accountScreensActive({ step: "signUp", email: EMAIL, name: "" }, false)).toBe(false);
  });
});

describe("copy for the stages", () => {
  it("tells a guest why an account is needed, and a signed-out member to sign in again", () => {
    const guest = "Sharing needs an account. Your project stays on this device until you choose to add it.";
    expect(signInPrompt(null)).toBe(guest);
    expect(signInPrompt(undefined)).toBe(guest);
    expect(signInPrompt({ kind: "device", asked: true })).toBe(guest);
    expect(signInPrompt(account("editor"))).toBe("Sign in again to share this project or manage its team.");
  });

  it("uses the agreed sentences", () => {
    expect(DEVICE_ONLY_MESSAGE).toBe("This project is only on this device. Add it to your account to invite collaborators.");
    expect(INVITE_HELP).toBe(
      "Scholea does not send an email, so tell the person yourself. They will see the invitation in Scholea when they sign in with this address, even if they create their account later. Invitations expire after 30 days.",
    );
    expect(inviteSavedMessage("bob@example.test")).toBe("Invitation saved for bob@example.test. Scholea has not emailed them.");
    expect(INVITATION_HELP).toBe(
      "Accepting adds the project to your account and downloads it to this device. Only accept invitations from people you know.",
    );
    expect(INVITATION_ACCEPTED).toBe("Added. Downloading the project.");
    expect(INVITATION_DECLINED).toBe("Invitation declined.");
    expect(LEAVE_TITLE).toBe("Leave this project?");
    expect(ONLY_OWNER_MESSAGE).toBe("You are the only owner. Make someone else an owner before you leave.");
    expect(VIEW_ONLY_NOTICE).toBe("You can view this project. Changes you make here are not saved to the shared project.");
    expect(SAVE_BADGE_LABEL).toEqual({ device: "Saved on this device", account: "Synced to your account" });
  });

  it("uses plain sentences, with no em-dashes", () => {
    const all = [
      signInPrompt(null),
      signInPrompt(account("owner")),
      DEVICE_ONLY_MESSAGE,
      ADDING_MESSAGE,
      OTHER_ACCOUNT_MESSAGE,
      PASSWORD_FIRST_MESSAGE,
      INVITE_HELP,
      PENDING_HELP,
      inviteSavedMessage("x@example.test"),
      describeCancelError(new SyncError(404, "not_found")),
      ONLY_OWNER_MESSAGE,
      LEAVE_TITLE,
      leaveBody("A study"),
      LEFT_MESSAGE,
      describeLeaveError(new SyncError(404, "not_found")),
      INVITATION_HELP,
      INVITATION_ACCEPTED,
      INVITATION_DECLINED,
      VIEW_ONLY_NOTICE,
      ...Object.values(SAVE_BADGE_LABEL),
      ...(["remove", "promote"] as const).flatMap((kind) => {
        const copy = confirmCopy({ kind, member: { name: "Bob", email: "bob@example.test" } }, "A study");
        return [copy.title, copy.body, copy.confirmLabel];
      }),
      confirmCopy({ kind: "leave" }, "A study").confirmLabel,
      roleChangedMessage({ name: "Bob", email: "" }, "viewer"),
      removedMessage({ name: "Bob", email: "" }),
      cancelledMessage("bob@example.test"),
    ];
    for (const text of all) {
      expect(text).not.toMatch(/[—–]/);
      expect(text.trim()).toBe(text);
      expect(text).not.toBe("");
    }
  });
});

describe("roles", () => {
  it("reads a role inside a sentence", () => {
    expect(roleWithArticle("owner")).toBe("an Owner");
    expect(roleWithArticle("editor")).toBe("an Editor");
    expect(roleWithArticle("viewer")).toBe("a Viewer");
    expect(roleWithArticle("supervisor")).toBe("a Supervisor");
  });

  it("lets an owner give any role to a member", () => {
    expect(MEMBER_ROLES).toEqual(["viewer", "editor", "supervisor", "owner"]);
  });
});

describe("shareStatus", () => {
  it("says a project nobody else can open is not shared yet", () => {
    expect(shareStatus("owner", [member(ADA, "owner")])).toEqual({ shared: false, label: "In your account · not shared yet" });
    // The team has not been read yet.
    expect(shareStatus(null, [])).toEqual({ shared: false, label: "In your account · not shared yet" });
  });

  it("names the person's role once someone else is on the project", () => {
    const team = [member(ADA, "owner"), member(BOB, "editor")];
    expect(shareStatus("owner", team)).toEqual({ shared: true, label: "Shared · you are an Owner" });
    expect(shareStatus("editor", team)).toEqual({ shared: true, label: "Shared · you are an Editor" });
    expect(shareStatus("viewer", team)).toEqual({ shared: true, label: "Shared · you are a Viewer" });
    expect(shareStatus("supervisor", team)).toEqual({ shared: true, label: "Shared · you are a Supervisor" });
    expect(shareStatus(null, team)).toEqual({ shared: true, label: "Shared · you are a member" });
  });

  it("counts a project the person does not own as shared even when they are its only member left", () => {
    expect(shareStatus("editor", [member(ADA, "editor")]).shared).toBe(true);
  });
});

describe("leaving", () => {
  it("knows the only owner", () => {
    expect(isOnlyOwner([member(ADA, "owner"), member(BOB, "editor")], ADA)).toBe(true);
    expect(isOnlyOwner([member(ADA, "owner"), member(BOB, "owner")], ADA)).toBe(false);
    expect(isOnlyOwner([member(ADA, "owner"), member(BOB, "editor")], BOB)).toBe(false);
    expect(isOnlyOwner([], ADA)).toBe(false);
    expect(isOnlyOwner([member(ADA, "owner")], null)).toBe(false);
  });

  it("offers leaving to every member except the only owner", () => {
    const team = [member(ADA, "owner"), member(BOB, "editor")];
    expect(canLeave(team, ADA)).toBe(false);
    expect(canLeave(team, BOB)).toBe(true);
    expect(canLeave([member(ADA, "owner"), member(BOB, "owner")], ADA)).toBe(true);
    expect(canLeave([member(ADA, "owner"), member(BOB, "viewer")], BOB)).toBe(true);
    expect(canLeave([member(ADA, "owner"), member(BOB, "supervisor")], BOB)).toBe(true);
  });

  it("does not offer leaving to someone who is not on the project, or before the team is known", () => {
    expect(canLeave([member(ADA, "owner"), member(BOB, "owner")], "user-eve")).toBe(false);
    expect(canLeave([], ADA)).toBe(false);
    expect(canLeave([member(ADA, "editor")], null)).toBe(false);
  });

  it("asks with the project's name and says what happens to the copy on this device", () => {
    expect(leaveBody("Sleep and recall")).toBe(
      "You will lose access to Sleep and recall. The rest of the team keeps their copy. What is on this device now stays here as a copy that no longer syncs.",
    );
    expect(leaveBody("  ")).toMatch(/^You will lose access to this project\. /);
  });

  it("explains a refusal", () => {
    expect(describeLeaveError(new SyncError(409, "last_owner"))).toBe("You are the only owner. Make someone else an owner before you leave.");
    expect(describeLeaveError(new SyncError(404, "not_found"))).toBe("You are no longer a member of this project.");
    expect(describeLeaveError(new SyncError(0, "offline"))).toBe("You're offline. Connect to the internet and try again.");
    expect(describeLeaveError(new Error("boom"))).toBe("Something went wrong. Try again in a moment.");
  });
});

describe("canManageMember", () => {
  it("lets an owner manage members who are not owners", () => {
    expect(canManageMember("owner", member(BOB, "editor"), ADA)).toBe(true);
    expect(canManageMember("owner", member(BOB, "viewer"), ADA)).toBe(true);
    expect(canManageMember("owner", member(BOB, "supervisor"), ADA)).toBe(true);
  });

  it("offers nothing for another owner or for the person's own row", () => {
    expect(canManageMember("owner", member(BOB, "owner"), ADA)).toBe(false);
    expect(canManageMember("owner", member(ADA, "owner"), ADA)).toBe(false);
    expect(canManageMember("owner", member(ADA, "editor"), ADA)).toBe(false);
  });

  it("offers nothing to anyone who is not an owner", () => {
    for (const role of ["viewer", "editor", "supervisor", null] as const) {
      expect(canManageMember(role, member(BOB, "viewer"), ADA)).toBe(false);
    }
  });
});

describe("changes that are asked about first", () => {
  const bob = { name: "Bob Stone", email: "bob@example.test" };

  it("asks before leaving, with the agreed title and the project's name", () => {
    expect(confirmCopy({ kind: "leave" }, "Sleep and recall")).toEqual({
      title: "Leave this project?",
      body: leaveBody("Sleep and recall"),
      confirmLabel: "Leave project",
      danger: true,
    });
  });

  it("asks before removing a member, naming them by name and address", () => {
    expect(confirmCopy({ kind: "remove", member: bob }, "Sleep and recall")).toEqual({
      title: "Remove Bob Stone?",
      body: "Bob Stone (bob@example.test) will lose access to this project. What is already on their devices stays there as a copy that no longer syncs.",
      confirmLabel: "Remove",
      danger: true,
    });
    expect(confirmCopy({ kind: "remove", member: { name: "", email: "bob@example.test" } }, "x").title).toBe("Remove bob@example.test?");
  });

  it("asks before making someone an owner, and says it cannot be undone here", () => {
    const copy = confirmCopy({ kind: "promote", member: bob }, "Sleep and recall");
    expect(copy.title).toBe("Make Bob Stone an owner?");
    expect(copy.body).toBe(
      "Owners can invite and remove people, change roles, and delete the project for everyone. An owner cannot be removed or given another role here.",
    );
    expect(copy.confirmLabel).toBe("Make owner");
    expect(copy.danger).toBe(false);
  });

  it("says what was done", () => {
    expect(roleChangedMessage(bob, "viewer")).toBe("Bob Stone is now a Viewer.");
    expect(roleChangedMessage(bob, "owner")).toBe("Bob Stone is now an Owner.");
    expect(roleChangedMessage({ name: "", email: "bob@example.test" }, "editor")).toBe("bob@example.test is now an Editor.");
    expect(removedMessage(bob)).toBe("Bob Stone was removed from the project.");
    expect(cancelledMessage("bob@example.test")).toBe("Invitation for bob@example.test cancelled.");
  });

  it("reads the team again after a refusal that says it has changed", () => {
    for (const code of ["not_found", "not_a_member", "forbidden", "last_owner"]) {
      expect(isStaleTeam(new SyncError(400, code))).toBe(true);
    }
    for (const code of ["offline", "network", "server_error", "invalid_role", "already_member", "rate_limited"]) {
      expect(isStaleTeam(new SyncError(400, code))).toBe(false);
    }
    // Only a refusal from the backend counts, not something that merely looks like one.
    expect(isStaleTeam(new Error("not_found"))).toBe(false);
    expect(isStaleTeam({ code: "not_found" })).toBe(false);
  });
});

describe("who did something", () => {
  const team = [
    member(ADA, "owner", "Ada Lovelace", "ada@example.test"),
    member(BOB, "editor", "", "bob@example.test"),
    member("user-sam", "viewer", "Ada Lovelace", "sam@example.test"),
  ];

  it("names a member by name, or by address when they gave none", () => {
    expect(memberName(team[0])).toBe("Ada Lovelace");
    expect(memberName(team[1])).toBe("bob@example.test");
    expect(memberName({ name: "  ", email: "" })).toBe("Deleted user");
    expect(memberName({ name: "Deleted user", email: "" })).toBe("Deleted user");
  });

  it("labels a member by name and address, without saying the address twice", () => {
    expect(memberLabel(team[0])).toBe("Ada Lovelace (ada@example.test)");
    expect(memberLabel(team[1])).toBe("bob@example.test");
    expect(memberLabel({ name: "Deleted user", email: "" })).toBe("Deleted user");
  });

  it("resolves the account against the member list and adds the address", () => {
    expect(personOf(ADA, "An older name", team)).toEqual({ name: "Ada Lovelace", detail: "ada@example.test" });
  });

  it("tells two members with the same name apart", () => {
    const first = personOf(ADA, "Ada Lovelace", team);
    const second = personOf("user-sam", "Ada Lovelace", team);
    expect(first.name).toBe(second.name);
    expect(personLabel(first)).toBe("Ada Lovelace (ada@example.test)");
    expect(personLabel(second)).toBe("Ada Lovelace (sam@example.test)");
  });

  it("adds the role when the name is the address itself", () => {
    expect(personOf(BOB, "bob", team)).toEqual({ name: "bob@example.test", detail: "Editor" });
    expect(personLabel(personOf(BOB, "bob", team))).toBe("bob@example.test (Editor)");
  });

  it("never trusts the stored name over the account", () => {
    // Bob's entry was written under a name that looks like Ada's.
    expect(personOf(BOB, "Ada Lovelace", team).name).toBe("bob@example.test");
  });

  it("says when the account is no longer on the project", () => {
    expect(personOf("user-gone", "Grace", team)).toEqual({ name: "Grace", detail: "no longer a member" });
    expect(personOf("user-gone", "  ", team)).toEqual({ name: "Someone", detail: "no longer a member" });
    expect(personLabel(personOf("user-gone", "Grace", team))).toBe("Grace (no longer a member)");
  });

  it("keeps only the stored name once the account itself is gone", () => {
    expect(personOf(null, "Deleted user", team)).toEqual({ name: "Deleted user", detail: "" });
    expect(personOf(null, "", team)).toEqual({ name: "Deleted user", detail: "" });
    expect(personLabel(personOf(null, "Deleted user", team))).toBe("Deleted user");
  });

  it("shows a deleted member without an address by role", () => {
    const withDeleted = [...team, member("user-del", "editor", "Deleted user", "")];
    expect(personOf("user-del", "Dee", withDeleted)).toEqual({ name: "Deleted user", detail: "Editor" });
  });
});

describe("describeTeamAction", () => {
  it("phrases what the backend records", () => {
    expect(describeTeamAction("project.create", "A study")).toBe("created the project");
    expect(describeTeamAction("content.sync", "rev 4")).toBe("saved changes");
    expect(describeTeamAction("ownership.set", "step-1")).toBe("assigned a step");
    expect(describeTeamAction("comment.add", "step-1")).toBe("commented");
    expect(describeTeamAction("review.approve", "step-1")).toBe("approved a step");
    expect(describeTeamAction("review.request_changes", "step-1")).toBe("requested changes");
  });

  it("names the role of an invitation or a join, and never an address", () => {
    expect(describeTeamAction("member.invite", "editor")).toBe("invited someone as an Editor");
    expect(describeTeamAction("member.invite", "viewer")).toBe("invited someone as a Viewer");
    expect(describeTeamAction("member.join", "supervisor")).toBe("joined as a Supervisor");
    expect(describeTeamAction("member.invite", null)).toBe("invited someone");
    expect(describeTeamAction("member.join", "bob@example.test")).toBe("joined the project");
    expect(describeTeamAction("member.invite", "toString")).toBe("invited someone");
  });

  it("falls back to the action's own words", () => {
    expect(describeTeamAction("member.role_changed", null)).toBe("member role changed");
    expect(describeTeamAction("constructor", null)).toBe("constructor");
  });
});

describe("cancelling an invitation", () => {
  it("says the invitation is no longer open when it was accepted or cancelled meanwhile", () => {
    expect(describeCancelError(new SyncError(404, "not_found"))).toBe("That invitation is no longer open.");
  });

  it("uses the invitation copy for everything else", () => {
    expect(describeCancelError(new SyncError(403, "forbidden"))).toBe("Only an owner can invite people to this project.");
    expect(describeCancelError(new SyncError(0, "network"))).toBe("Can't reach the Scholea server. Check your connection and try again.");
  });
});

describe("an invitation waiting for the person", () => {
  const invitation: MyInvitation = {
    id: "inv-1",
    project_id: "proj_x",
    project_title: "Sleep and recall",
    study_type: "cohort",
    role: "editor",
    inviter_name: "Ada Lovelace",
    inviter_email: "ada@example.test",
    created_at: 1,
    expires_at: 2,
  };

  it("says who invited them, to what, and as what", () => {
    expect(invitationSentence(invitation)).toBe('Ada Lovelace (ada@example.test) invited you to "Sleep and recall" as Editor.');
    expect(invitationSentence({ ...invitation, role: "viewer" })).toMatch(/ as Viewer\.$/);
    expect(invitationSentence({ ...invitation, role: "supervisor" })).toMatch(/ as Supervisor\.$/);
  });

  it("copes with a missing name, address or title", () => {
    expect(invitationSentence({ ...invitation, inviter_name: " " })).toBe('ada@example.test invited you to "Sleep and recall" as Editor.');
    expect(invitationSentence({ ...invitation, inviter_email: "" })).toBe('Ada Lovelace invited you to "Sleep and recall" as Editor.');
    expect(invitationSentence({ ...invitation, inviter_name: "", inviter_email: "" })).toBe('Someone invited you to "Sleep and recall" as Editor.');
    expect(invitationSentence({ ...invitation, project_title: "  " })).toBe('Ada Lovelace (ada@example.test) invited you to "Untitled project" as Editor.');
  });

  it("does not repeat an address that is also the name", () => {
    expect(invitationSentence({ ...invitation, inviter_name: "ada@example.test" })).toBe(
      'ada@example.test invited you to "Sleep and recall" as Editor.',
    );
  });

  it("names the project on both buttons", () => {
    expect(acceptLabel(invitation)).toBe("Accept invitation to Sleep and recall");
    expect(declineLabel(invitation)).toBe("Decline invitation to Sleep and recall");
    expect(acceptLabel({ project_title: "" })).toBe("Accept invitation to Untitled project");
    expect(declineLabel({ project_title: "" })).toBe("Decline invitation to Untitled project");
  });

  it("writes a day out", () => {
    expect(formatDay(Date.UTC(2026, 10, 7, 12), "en-GB", "UTC")).toBe("7 Nov 2026");
    expect(formatDay(Date.UTC(2026, 0, 31, 23, 59), "en-GB", "UTC")).toBe("31 Jan 2026");
  });
});

describe("the open project in the runner", () => {
  it("is synced only when it is in the signed-in person's account and the server has it", () => {
    expect(saveBadge(account("owner"), ADA)).toBe("account");
    expect(saveBadge(account("viewer"), ADA)).toBe("account");
  });

  it("is saved on this device in every other case", () => {
    expect(saveBadge(null, ADA)).toBe("device");
    expect(saveBadge(undefined, null)).toBe("device");
    expect(saveBadge({ kind: "device", asked: true }, ADA)).toBe("device");
    // Not confirmed on the server yet.
    expect(saveBadge(account("owner", { created: false }), ADA)).toBe("device");
    // In the account, but its content has not been uploaded there yet.
    expect(saveBadge(account("owner", { rev: 0 }), ADA)).toBe("device");
    expect(saveBadge(account("owner", { rev: 0, synced: "x" }), ADA)).toBe("account");
    // Its account is signed out, or somebody else is signed in.
    expect(saveBadge(account("owner"), null)).toBe("device");
    expect(saveBadge(account("owner"), BOB)).toBe("device");
  });

  it("is view-only for a viewer and a supervisor of an account project", () => {
    expect(isViewOnly(account("viewer"))).toBe(true);
    expect(isViewOnly(account("supervisor"))).toBe(true);
    expect(isViewOnly(account("editor"))).toBe(false);
    expect(isViewOnly(account("owner"))).toBe(false);
  });

  it("is never view-only for a project kept on this device", () => {
    expect(isViewOnly(null)).toBe(false);
    expect(isViewOnly(undefined)).toBe(false);
    expect(isViewOnly({ kind: "device", asked: false })).toBe(false);
  });
});
