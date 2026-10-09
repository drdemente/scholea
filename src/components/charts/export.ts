import { platform } from "@/lib/platform";

/** Serialise a live <svg> element to a standalone file and save it. */
export function exportSvg(svg: SVGSVGElement | null, filename: string): void {
  if (!svg) return;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const source = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
  void platform.saveFile(filename, source);
}
