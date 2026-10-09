import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { initialAuthStep, type AuthStep } from "@/lib/account/auth-flow";
import { useAuthUi } from "@/lib/account/auth-ui";
import { AuthFlow } from "./AuthFlow";

// The account screens driven through their own store: a test puts the screens
// on a step, as if the person had got there. No backend, no module mocking.

const EMAIL = "ada@example.test";
const codeStep: AuthStep = { step: "confirm", email: EMAIL, name: "", resendAt: 0 };

function at(flow: AuthStep) {
  useAuthUi.setState({ flow, open: true, busy: false, error: null, notice: null, sent: null });
}

afterEach(() => {
  cleanup();
  at(initialAuthStep());
  useAuthUi.setState({ open: false });
});

describe("the account screens where nobody may create an account", () => {
  it("offers no way from the code step to the sign-up form", () => {
    // Reached by signing in to a sign-up that was never confirmed.
    at(codeStep);
    render(<AuthFlow heading="h1" allowSignUp={false} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Check your email");
    expect(screen.queryByRole("button", { name: "Use a different email" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to sign in" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Sign in to Scholea");
    expect(screen.queryByRole("button", { name: "Create an account" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create account" })).toBeNull();
  });

  it("never shows the sign-up form, whichever way the screens got to it", async () => {
    at({ step: "signUp", name: "", email: EMAIL });
    render(<AuthFlow heading="h1" allowSignUp={false} />);
    expect(screen.queryByRole("button", { name: "Create account" })).toBeNull();
    await waitFor(() => expect(useAuthUi.getState().flow).toEqual({ step: "signIn", email: EMAIL }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Sign in to Scholea");
  });
});

describe("the account screens where an account can be created (the research app)", () => {
  it("still lets the person start over with a different email", () => {
    at(codeStep);
    render(<AuthFlow />);
    fireEvent.click(screen.getByRole("button", { name: "Use a different email" }));
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Create your account");
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
  });
});

describe("the step that settles a password that is owed", () => {
  it("has no way to put it off: only saving a password, or signing out", () => {
    for (const via of ["plain", "secure"] as const) {
      at({ step: "setPassword", email: EMAIL, name: "", via });
      render(<AuthFlow />);
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Choose a password");
      expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
      expect(screen.getByRole("button", { name: "Sign out instead" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save password" })).toBeInTheDocument();
      cleanup();
    }
  });

  it("asks the person to check the name on the account when it did not come with one from the sign-up form", () => {
    at({ step: "setPassword", email: EMAIL, name: "", via: "secure" });
    render(<AuthFlow />);
    expect(screen.getByLabelText("Your name")).toBeInTheDocument();
    expect(screen.getByLabelText("Institution")).toBeInTheDocument();
    cleanup();

    // The name typed at sign-up is saved as it is: it is not asked for again.
    at({ step: "setPassword", email: EMAIL, name: "Ada", via: "secure" });
    render(<AuthFlow />);
    expect(screen.queryByLabelText("Your name")).toBeNull();
  });
});
