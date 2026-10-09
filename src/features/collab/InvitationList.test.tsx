import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useInvitations, type MyInvitation } from "@/lib/collab/invitations";
import { InvitationList } from "./InvitationList";

// The list driven through its own store: the invitations are put there, and the
// two answers are stand-ins that do what the real ones do on success (the
// answered invitation leaves the list). No backend, no module mocking.

const invitation = (id: string, title: string): MyInvitation => ({
  id,
  project_id: `proj_${id}`,
  project_title: title,
  study_type: "cohort",
  role: "editor",
  inviter_name: "Ada",
  inviter_email: "ada@example.test",
  created_at: 1,
  expires_at: 2,
});

const original = useInvitations.getState();

function show(items: MyInvitation[]) {
  const answered = (id: string) => useInvitations.setState({ items: useInvitations.getState().items.filter((i) => i.id !== id) });
  useInvitations.setState({
    items,
    loaded: true,
    accept: async (id) => {
      answered(id);
      return { projectId: `proj_${id}`, role: "editor" };
    },
    decline: async (id) => answered(id),
  });
  const page = createRef<HTMLHeadingElement>();
  render(
    <div>
      <h1 ref={page} tabIndex={-1}>
        Your projects
      </h1>
      <InvitationList focusAfter={page} />
    </div>,
  );
}

describe("InvitationList: where the focus goes when an invitation is answered", () => {
  afterEach(() => {
    cleanup();
    useInvitations.setState(original, true);
  });

  it("goes to the list's own heading while other invitations are left", async () => {
    show([invitation("1", "Sleep"), invitation("2", "Recall")]);
    const decline = screen.getByRole("button", { name: "Decline invitation to Sleep" });
    decline.focus();
    fireEvent.click(decline);

    await waitFor(() => expect(screen.queryByRole("button", { name: "Decline invitation to Sleep" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Invitations" })));
  });

  it("goes to the page's heading when the last one is answered and the list goes with it", async () => {
    for (const answer of ["Decline", "Accept"]) {
      show([invitation("1", "Sleep")]);
      const button = screen.getByRole("button", { name: `${answer} invitation to Sleep` });
      button.focus();
      fireEvent.click(button);

      await waitFor(() => expect(screen.queryByRole("heading", { name: "Invitations" })).toBeNull());
      // Not the page body: a keyboard or screen-reader user stays where the list was.
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Your projects" })));
      cleanup();
    }
  });
});
