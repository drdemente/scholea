/**
 * Puts an accent palette on the page as one `<style>` element, or takes it off
 * again. The stylesheet text comes from `accentCss`, which leaves the admin
 * theme out in its selectors, so this is safe to call whatever is mounted.
 */
import { accentCss, type AccentPalette } from "./accent";

/** Id of the one style element this module owns. */
export const ACCENT_STYLE_ID = "scholea-accent";

/**
 * Apply a palette, replacing the one applied before. `null` (or a palette that
 * does not pass its contrast check) removes the element, which brings the stock
 * palette back. Does nothing where there is no document.
 */
export function applyAccent(p: AccentPalette | null, doc?: Document): void {
  const target = doc ?? (typeof document === "undefined" ? null : document);
  if (!target) return;

  const css = p ? accentCss(p) : "";
  let existing = target.getElementById(ACCENT_STYLE_ID);
  // Something else holding the id is not ours to write into.
  if (existing && existing.tagName.toLowerCase() !== "style") {
    existing.remove();
    existing = null;
  }

  if (!css) {
    existing?.remove();
    return;
  }
  if (existing) {
    if (existing.textContent !== css) existing.textContent = css;
    return;
  }
  const style = target.createElement("style");
  style.id = ACCENT_STYLE_ID;
  style.textContent = css;
  (target.head ?? target.documentElement).appendChild(style);
}
