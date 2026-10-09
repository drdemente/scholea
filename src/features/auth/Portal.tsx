import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Renders its children at the end of the page instead of where it is used.
 *
 * A dialog opened from inside a glass surface needs this. A surface with a
 * filter or a backdrop filter becomes the box its "fixed" descendants are laid
 * out in, so the dialog would be sized and centred to the header or panel it
 * came from instead of to the window.
 */
export function Portal({ children }: { children: ReactNode }) {
  return typeof document === "undefined" ? null : createPortal(children, document.body);
}
