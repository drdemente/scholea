import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { reducedFade, withReduced } from "@/lib/motion";
import { ToastHost, toast, toastSlide, useToasts } from "./toast";

// Whoever asked their system for less motion gets a fade, not a slide.

/** Whether any step of an animation moves the element. */
function moves(variants: object): boolean {
  return Object.values(variants).some((step) => typeof step === "object" && step !== null && ("y" in step || "x" in step || "scale" in step));
}

describe("how a toast comes and goes", () => {
  it("slides by default, and only fades when less motion was asked for", () => {
    expect(moves(withReduced(toastSlide, reducedFade, false))).toBe(true);
    expect(moves(withReduced(toastSlide, reducedFade, true))).toBe(false);
  });
});

describe("ToastHost for someone who asked for less motion", () => {
  beforeAll(() => {
    // The page says yes to every question about reduced motion.
    window.matchMedia = ((query: string) => ({
      matches: /prefers-reduced-motion/.test(query),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    cleanup();
    useToasts.setState({ toasts: [] });
  });

  it("puts a toast in place without moving it", () => {
    render(<ToastHost />);
    act(() => void toast.info("Signed out."));
    const shown = screen.getByRole("status");
    expect(shown).toHaveTextContent("Signed out.");
    // Where it starts from is where it stays: nothing to slide in from.
    expect(shown.style.transform === "" || shown.style.transform === "none").toBe(true);
  });

  it("still announces an error as an alert", () => {
    render(<ToastHost />);
    act(() => void toast.error("Something went wrong."));
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong.");
  });
});
