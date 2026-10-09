/**
 * Move focus to the first field inside `root`, or to its heading when it has
 * no field. Run one frame after the content appears, so a dialog that has just
 * opened has finished its own focusing. Returns the undo for an effect.
 */
export function focusFirstField(root: () => HTMLElement | null): () => void {
  const frame = requestAnimationFrame(() => {
    const el = root();
    if (!el) return;
    // A field that is skipped by the Tab key is not meant to be typed in.
    const target = el.querySelector<HTMLElement>('input:not([disabled]):not([tabindex="-1"])') ?? el.querySelector<HTMLElement>("[data-auth-heading]");
    target?.focus();
  });
  return () => cancelAnimationFrame(frame);
}
