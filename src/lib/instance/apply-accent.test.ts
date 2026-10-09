import { afterEach, describe, expect, it } from "vitest";
import { accentCss, deriveAccentPalette, type AccentPalette } from "./accent";
import { ACCENT_STYLE_ID, applyAccent } from "./apply-accent";

const green = deriveAccentPalette("#00A651") as AccentPalette;
const yellow = deriveAccentPalette("#FFD400") as AccentPalette;

const styles = (doc: Document = document) => Array.from(doc.querySelectorAll(`#${ACCENT_STYLE_ID}`));

describe("applyAccent", () => {
  afterEach(() => {
    for (const el of styles()) el.remove();
  });

  it("creates one style element in the head, holding the palette's stylesheet", () => {
    expect(ACCENT_STYLE_ID).toBe("scholea-accent");
    expect(styles()).toHaveLength(0);
    applyAccent(green);
    const found = styles();
    expect(found).toHaveLength(1);
    expect(found[0].tagName).toBe("STYLE");
    expect(found[0].parentElement).toBe(document.head);
    expect(found[0].textContent).toBe(accentCss(green));
    expect(found[0].textContent).toContain(green.light.primary);
    expect(found[0].textContent).toContain(green.dark.primary);
  });

  it("replaces the stylesheet in place when the palette changes", () => {
    applyAccent(green);
    const first = styles()[0];
    applyAccent(yellow);
    expect(styles()).toHaveLength(1);
    expect(styles()[0]).toBe(first);
    expect(first.textContent).toBe(accentCss(yellow));
    expect(first.textContent).not.toContain(green.light.primary);
  });

  it("leaves the element untouched when the same palette is applied again", () => {
    applyAccent(green);
    const first = styles()[0];
    const text = first.firstChild;
    applyAccent(deriveAccentPalette("#00a651"));
    expect(styles()).toEqual([first]);
    expect(first.firstChild).toBe(text);
  });

  it("removes the element for null, which brings the stock palette back", () => {
    applyAccent(green);
    applyAccent(null);
    expect(styles()).toHaveLength(0);
    // Removing when there is nothing to remove is fine.
    applyAccent(null);
    expect(styles()).toHaveLength(0);
  });

  it("removes the element rather than apply a palette that does not pass its check", () => {
    applyAccent(green);
    applyAccent({ ...green, light: { ...green.light, primary: "#fff;} body{display:none}" } });
    expect(styles()).toHaveLength(0);
    applyAccent({ ...green, dark: { ...green.dark, onBrand: "#fffefb" } });
    expect(styles()).toHaveLength(0);
  });

  it("takes over an element that holds its id but is not a style element", () => {
    const squatter = document.createElement("div");
    squatter.id = ACCENT_STYLE_ID;
    document.body.appendChild(squatter);
    applyAccent(green);
    expect(squatter.isConnected).toBe(false);
    expect(styles()).toHaveLength(1);
    expect(styles()[0].tagName).toBe("STYLE");
  });

  it("works on the document it is given and leaves the others alone", () => {
    const other = document.implementation.createHTMLDocument("other");
    applyAccent(green, other);
    expect(styles(other)).toHaveLength(1);
    expect(styles(other)[0].parentElement).toBe(other.head);
    expect(styles()).toHaveLength(0);
    applyAccent(null, other);
    expect(styles(other)).toHaveLength(0);
  });

  it("never changes the page's theme attributes", () => {
    const root = document.documentElement;
    const before = { mode: root.getAttribute("data-mode"), theme: root.getAttribute("data-theme") };
    applyAccent(green);
    applyAccent(null);
    expect({ mode: root.getAttribute("data-mode"), theme: root.getAttribute("data-theme") }).toEqual(before);
  });
});
