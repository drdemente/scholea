import { describe, expect, it } from "vitest";
import { SyncError } from "@/lib/supabase/errors";
import {
  DEFAULT_INVITE_ROLE,
  INVITE_ROLES,
  createInvitationsApi,
  createInvitationsStore,
  describeInviteError,
  invitationBadgeLabel,
  isValidEmail,
  memberRows,
  normaliseEmail,
  removeInvitation,
  type InvitationsDeps,
  type MyInvitation,
  type PendingInvitation,
} from "./invitations";
import { describeSyncError, type Member, type RpcCaller } from "./sync";

/** An en dash or an em dash. Copy uses plain sentences instead. */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

describe("email addresses", () => {
  it("normalises to trimmed lower case, as the backend stores them", () => {
    expect(normaliseEmail("  Ada.Lovelace@Example.TEST \n")).toBe("ada.lovelace@example.test");
    expect(normaliseEmail("\tb@example.test")).toBe("b@example.test");
    expect(normaliseEmail("")).toBe("");
  });

  it("accepts what looks like an address", () => {
    for (const ok of ["a@example.test", " A@Example.Test ", "first.last+tag@sub.example.test", "ü@exämple.test"]) {
      expect(isValidEmail(ok), ok).toBe(true);
    }
  });

  it("refuses what the backend would refuse", () => {
    const tooLong = `${"a".repeat(242)}@example.test`; // 255 characters
    for (const bad of ["", "   ", "ada", "ada@", "@example.test", "ada@example", "a b@example.test", "a@b@example.test", "ada@exam ple.test", tooLong]) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
    expect(isValidEmail(`${"a".repeat(241)}@example.test`)).toBe(true); // 254 characters exactly
  });
});

describe("describeInviteError", () => {
  const copy = (code: string, context?: "respond" | "manage") => describeInviteError(new SyncError(400, code), context);

  it("maps every invitation code to its sentence", () => {
    expect(copy("already_member")).toBe("That person is already a member of this project.");
    expect(copy("too_many_invitations")).toBe("This project already has 20 pending invitations. Cancel one before inviting someone else.");
    expect(copy("invite_rate_limited")).toBe("You have sent a lot of invitations today. Try again tomorrow.");
    expect(copy("invalid_email")).toBe("Enter a valid email address.");
    expect(copy("invalid_role")).toBe("Choose Viewer, Editor or Supervisor.");
    expect(copy("invitation_expired")).toBe("This invitation has expired. Ask the project owner to invite you again.");
    expect(copy("invitation_invalid")).toBe("This invitation is no longer valid.");
  });

  it("reads not_found as a dead invitation for the invited person, and as a missing project for an owner", () => {
    expect(copy("not_found")).toBe("This invitation is no longer valid.");
    expect(copy("not_found", "respond")).toBe("This invitation is no longer valid.");
    expect(copy("not_found", "manage")).toBe(describeSyncError(new SyncError(404, "not_found")));
  });

  it("tells a member who is not an owner why they cannot invite", () => {
    expect(copy("forbidden", "manage")).toBe("Only an owner can invite people to this project.");
    expect(copy("forbidden")).toBe(describeSyncError(new SyncError(403, "forbidden")));
  });

  it("falls back to the general sync copy", () => {
    for (const code of ["offline", "network", "unauthenticated", "last_owner", "rate_limited"]) {
      expect(copy(code)).toBe(describeSyncError(new SyncError(400, code)));
    }
    expect(describeInviteError(new Error("boom"))).toBe(describeSyncError(new Error("boom")));
    expect(describeInviteError(new SyncError(400, "constructor"))).toBe(describeSyncError(new SyncError(400, "constructor")));
  });

  it("uses plain sentences", () => {
    for (const code of ["already_member", "too_many_invitations", "invite_rate_limited", "invalid_email", "invalid_role", "invitation_expired", "invitation_invalid"]) {
      expect(copy(code), code).toMatch(/^[A-Z].*\.$/);
      expect(copy(code), code).not.toMatch(DASHES);
    }
  });
});

const member = (over: Partial<Member>): Member => ({ project_id: "p", user_id: "u1", email: "ada@example.test", name: "Ada", role: "owner", added_at: 1, ...over });
const pending = (over: Partial<PendingInvitation>): PendingInvitation => ({
  id: "i1",
  email: "new@example.test",
  role: "editor",
  invited_by_name: "Ada",
  created_at: 10,
  expires_at: 99,
  ...over,
});

describe("memberRows", () => {
  it("puts members first, in their order, then the open invitations", () => {
    const rows = memberRows(
      [member({}), member({ user_id: "u2", email: "bob@example.test", name: "Bob", role: "viewer" })],
      [pending({}), pending({ id: "i2", email: "later@example.test", role: "supervisor", expires_at: 200 })],
    );
    expect(rows).toEqual([
      { kind: "member", key: "member:u1", userId: "u1", email: "ada@example.test", name: "Ada", role: "owner" },
      { kind: "member", key: "member:u2", userId: "u2", email: "bob@example.test", name: "Bob", role: "viewer" },
      { kind: "invitation", key: "invitation:i1", invitationId: "i1", email: "new@example.test", role: "editor", invitedByName: "Ada", expiresAt: 99 },
      { kind: "invitation", key: "invitation:i2", invitationId: "i2", email: "later@example.test", role: "supervisor", invitedByName: "Ada", expiresAt: 200 },
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it("leaves out an invitation whose address already belongs to a member", () => {
    const rows = memberRows([member({ email: "Ada@Example.test" })], [pending({ email: "ada@example.test" }), pending({ id: "i2" })]);
    expect(rows.map((r) => r.key)).toEqual(["member:u1", "invitation:i2"]);
  });

  it("does not match a deleted member's empty address against anything", () => {
    const rows = memberRows([member({ email: "" })], [pending({ email: "" })]);
    expect(rows).toHaveLength(2);
  });

  it("is empty for an empty project", () => {
    expect(memberRows([], [])).toEqual([]);
  });
});

describe("removeInvitation", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("removes the one invitation", () => {
    expect(removeInvitation(items, "b")).toEqual([{ id: "a" }, { id: "c" }]);
    expect(items).toHaveLength(3);
  });

  it("returns the same list when the id is not in it", () => {
    expect(removeInvitation(items, "zzz")).toBe(items);
  });
});

describe("invitationBadgeLabel", () => {
  it("names the count for none, one and many", () => {
    expect(invitationBadgeLabel(0)).toBe("Invitations");
    expect(invitationBadgeLabel(1)).toBe("Invitations, 1 pending");
    expect(invitationBadgeLabel(12)).toBe("Invitations, 12 pending");
  });

  it("treats nonsense as none", () => {
    expect(invitationBadgeLabel(-3)).toBe("Invitations");
    expect(invitationBadgeLabel(NaN)).toBe("Invitations");
    expect(invitationBadgeLabel(2.9)).toBe("Invitations, 2 pending");
  });
});

describe("invitation roles", () => {
  it("offers every role but owner, with editor as the default", () => {
    expect(INVITE_ROLES).toEqual(["viewer", "editor", "supervisor"]);
    expect(DEFAULT_INVITE_ROLE).toBe("editor");
  });
});

// --- The calls, through a hand-written stand-in for the backend ----------------------

function fakeCaller(replies: Record<string, unknown>) {
  const calls: Array<{ fn: string; args?: Record<string, unknown> }> = [];
  const call = (async (fn: string, args?: Record<string, unknown>) => {
    calls.push(args === undefined ? { fn } : { fn, args });
    const reply = replies[fn];
    if (reply instanceof Error) throw reply;
    return reply;
  }) as RpcCaller;
  return { call, calls };
}

async function rejection(promise: Promise<unknown>): Promise<SyncError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(SyncError);
    return e as SyncError;
  }
  throw new Error("expected the call to throw");
}

describe("invitation calls", () => {
  it("invites a normalised address", async () => {
    const sent = { id: "i1", project_id: "proj_a", email: "new@example.test", role: "supervisor", created_at: 10, expires_at: 99 };
    const f = fakeCaller({ invite_project_member: { invitation: sent } });
    const { invitation } = await createInvitationsApi(f.call).invite("proj_a", "  New@Example.TEST ", "supervisor");
    expect(f.calls).toEqual([{ fn: "invite_project_member", args: { p_project_id: "proj_a", p_email: "new@example.test", p_role: "supervisor" } }]);
    expect(invitation).toEqual(sent);
  });

  it("catches a mistyped address before any request", async () => {
    const f = fakeCaller({});
    expect(await rejection(createInvitationsApi(f.call).invite("proj_a", "not an address", "editor"))).toMatchObject({ code: "invalid_email", status: 400 });
    expect(f.calls).toEqual([]);
  });

  it("lists a project's open invitations for its owner", async () => {
    const open = { id: "i1", email: "new@example.test", role: "editor", invited_by_name: "Ada", created_at: 10, expires_at: 99 };
    const f = fakeCaller({ list_project_invitations: { invitations: [open, { broken: true }] } });
    expect(await createInvitationsApi(f.call).listForProject("proj_a")).toEqual({ invitations: [open] });
    expect(f.calls).toEqual([{ fn: "list_project_invitations", args: { p_project_id: "proj_a" } }]);
  });

  it("lists the invitations waiting for the caller", async () => {
    const mine = {
      id: "i1",
      project_id: "proj_a",
      project_title: "A review",
      study_type: "cohort",
      role: "viewer",
      inviter_name: "Ada",
      inviter_email: "ada@example.test",
      created_at: 10,
      expires_at: 99,
    };
    const f = fakeCaller({ list_my_invitations: { invitations: [mine] } });
    expect(await createInvitationsApi(f.call).listMine()).toEqual({ invitations: [mine] });
    expect(f.calls).toEqual([{ fn: "list_my_invitations" }]);
    expect(await createInvitationsApi(fakeCaller({ list_my_invitations: null }).call).listMine()).toEqual({ invitations: [] });
  });

  it("accepts, declines and cancels by invitation id", async () => {
    const f = fakeCaller({
      accept_project_invitation: { project_id: "proj_a", role: "editor" },
      decline_project_invitation: { ok: true },
      cancel_project_invitation: { ok: true },
    });
    const api = createInvitationsApi(f.call);
    expect(await api.accept("i1")).toEqual({ projectId: "proj_a", role: "editor" });
    expect(await api.decline("i2")).toEqual({ ok: true });
    expect(await api.cancel("i3")).toEqual({ ok: true });
    expect(f.calls).toEqual([
      { fn: "accept_project_invitation", args: { p_invitation_id: "i1" } },
      { fn: "decline_project_invitation", args: { p_invitation_id: "i2" } },
      { fn: "cancel_project_invitation", args: { p_invitation_id: "i3" } },
    ]);
  });

  it("does not take an answer it cannot read for success", async () => {
    const api = createInvitationsApi(fakeCaller({ accept_project_invitation: {}, invite_project_member: {} }).call);
    expect(await rejection(api.accept("i1"))).toMatchObject({ code: "server_error" });
    expect(await rejection(api.invite("proj_a", "a@example.test", "editor"))).toMatchObject({ code: "server_error" });
  });

  it("passes the backend's refusal through", async () => {
    const api = createInvitationsApi(fakeCaller({ invite_project_member: new SyncError(429, "invite_rate_limited") }).call);
    expect(await rejection(api.invite("proj_a", "a@example.test", "editor"))).toMatchObject({ code: "invite_rate_limited", status: 429 });
  });
});

// --- The store ---------------------------------------------------------------------------

const mine = (id: string): MyInvitation => ({
  id,
  project_id: `proj_${id}`,
  project_title: `Project ${id}`,
  study_type: "cohort",
  role: "editor",
  inviter_name: "Ada",
  inviter_email: "ada@example.test",
  created_at: 10,
  expires_at: 99,
});

function storeWith(over: Partial<InvitationsDeps["api"]> = {}) {
  const state = { waiting: [mine("a"), mine("b")] as MyInvitation[], afterAccept: 0, calls: [] as string[] };
  const api: InvitationsDeps["api"] = {
    listMine: async () => ({ invitations: state.waiting }),
    accept: async (id) => {
      state.calls.push(`accept:${id}`);
      return { projectId: `proj_${id}`, role: "editor" };
    },
    decline: async (id) => {
      state.calls.push(`decline:${id}`);
      return { ok: true };
    },
    ...over,
  };
  const store = createInvitationsStore({ api, afterAccept: () => void (state.afterAccept += 1) });
  return { store, state, get: () => store.getState() };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("useInvitations store", () => {
  it("starts empty and loads the waiting invitations", async () => {
    const s = storeWith();
    expect(s.get()).toMatchObject({ items: [], loaded: false });
    await s.get().refresh();
    expect(s.get().items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(s.get().loaded).toBe(true);
  });

  it("keeps the list when the backend cannot be reached, and never throws", async () => {
    const s = storeWith();
    await s.get().refresh();
    const failing = storeWith({
      listMine: async () => {
        throw new SyncError(0, "offline");
      },
    });
    failing.store.setState({ items: s.get().items, loaded: true });
    await expect(failing.get().refresh()).resolves.toBeUndefined();
    expect(failing.get().items).toHaveLength(2);
    expect(failing.get().loaded).toBe(true);
  });

  it("empties the list when nobody is signed in any more", async () => {
    const s = storeWith({
      listMine: async () => {
        throw new SyncError(401, "unauthenticated");
      },
    });
    s.store.setState({ items: [mine("a")], loaded: true });
    await s.get().refresh();
    expect(s.get()).toMatchObject({ items: [], loaded: false });
  });

  it("accept joins, removes the invitation and lets sync download the project", async () => {
    const s = storeWith();
    await s.get().refresh();
    await expect(s.get().accept("a")).resolves.toEqual({ projectId: "proj_a", role: "editor" });
    expect(s.state.calls).toEqual(["accept:a"]);
    expect(s.get().items.map((i) => i.id)).toEqual(["b"]);
    await tick();
    expect(s.state.afterAccept).toBe(1);
  });

  it("accept does not wait for the download, and survives it failing", async () => {
    const state = { started: 0 };
    const store = createInvitationsStore({
      api: { listMine: async () => ({ invitations: [] }), accept: async () => ({ projectId: "p", role: "viewer" }), decline: async () => ({ ok: true }) },
      afterAccept: () => {
        state.started += 1;
        throw new Error("sync blew up");
      },
    });
    await expect(store.getState().accept("a")).resolves.toEqual({ projectId: "p", role: "viewer" });
    await tick();
    expect(state.started).toBe(1);
  });

  it("drops an invitation that turned out to be dead, and still reports why", async () => {
    for (const code of ["invitation_expired", "invitation_invalid", "not_found"]) {
      const s = storeWith({
        accept: async () => {
          throw new SyncError(410, code);
        },
      });
      await s.get().refresh();
      expect(await rejection(s.get().accept("a"))).toMatchObject({ code });
      expect(s.get().items.map((i) => i.id)).toEqual(["b"]);
      await tick();
      expect(s.state.afterAccept).toBe(0);
    }
  });

  it("keeps an invitation whose answer could not be sent", async () => {
    const s = storeWith({
      accept: async () => {
        throw new SyncError(0, "network");
      },
      decline: async () => {
        throw new SyncError(0, "offline");
      },
    });
    await s.get().refresh();
    expect(await rejection(s.get().accept("a"))).toMatchObject({ code: "network" });
    expect(await rejection(s.get().decline("b"))).toMatchObject({ code: "offline" });
    expect(s.get().items).toHaveLength(2);
  });

  it("decline removes the invitation and starts no download", async () => {
    const s = storeWith();
    await s.get().refresh();
    await s.get().decline("b");
    expect(s.state.calls).toEqual(["decline:b"]);
    expect(s.get().items.map((i) => i.id)).toEqual(["a"]);
    await tick();
    expect(s.state.afterAccept).toBe(0);
  });

  it("clear forgets everything, and an answer that arrives afterwards is dropped", async () => {
    let release: (v: { invitations: MyInvitation[] }) => void = () => {};
    const s = storeWith({ listMine: () => new Promise((resolve) => (release = resolve)) });
    s.store.setState({ items: [mine("old")], loaded: true });

    const reading = s.get().refresh();
    s.get().clear(); // the person signed out while the list was being read
    expect(s.get()).toMatchObject({ items: [], loaded: false });
    release({ invitations: [mine("for-the-previous-person")] });
    await reading;
    expect(s.get()).toMatchObject({ items: [], loaded: false });
  });
});
