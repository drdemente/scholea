import { beforeEach, describe, expect, it } from "vitest";
import { useTheme } from "./theme-store";

describe("theme store", () => {
  beforeEach(() => {
    useTheme.setState({ mode: "light", level: "basic" });
    document.documentElement.setAttribute("data-mode", "light");
  });

  it("toggleMode flips mode and reflects it on <html>", () => {
    useTheme.getState().toggleMode();
    expect(useTheme.getState().mode).toBe("dark");
    expect(document.documentElement.getAttribute("data-mode")).toBe("dark");
  });

  it("setLevel updates the progressive-disclosure level", () => {
    useTheme.getState().setLevel("advanced");
    expect(useTheme.getState().level).toBe("advanced");
  });
});
