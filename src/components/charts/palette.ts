import type { Mode } from "@/lib/theme/theme-store";

/**
 * Literal (non-CSS-var) colours for charts, so a serialised SVG export renders
 * correctly outside the app. Mode-aware to keep light/dark parity.
 */
export interface ChartPalette {
  axis: string;
  line: string;
  box: string;
  boxStroke: string;
  diamond: string;
  nullLine: string;
  text: string;
  sub: string;
  grid: string;
  accent: string;
}

const light: ChartPalette = {
  axis: "#4A5168",
  line: "#0E1424",
  box: "#6C5CE7",
  boxStroke: "#4338CA",
  diamond: "#2FCC8B",
  nullLine: "#4A5168",
  text: "#0E1424",
  sub: "#4A5168",
  grid: "#E7E4D7",
  accent: "#14C8C8",
};

const dark: ChartPalette = {
  axis: "#8A90A2",
  line: "#FAF9F5",
  box: "#8473ED",
  boxStroke: "#A395F4",
  diamond: "#4FD6A0",
  nullLine: "#8A90A2",
  text: "#FAF9F5",
  sub: "#B9BCC9",
  grid: "#2E3447",
  accent: "#3FD0D0",
};

export const chartPalette = (mode: Mode): ChartPalette => (mode === "dark" ? dark : light);
