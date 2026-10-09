/**
 * The organisation's accent colour, made safe for both themes.
 *
 * The colour an administrator enters is a seed, not a token value. For each
 * theme the seed's lightness is fitted until text in that colour is readable on
 * the app's hardest surface, the result is checked against every pair the
 * interface relies on, and anything that fails falls back to the stock palette.
 * A fixed `color-mix` ratio cannot promise contrast for an arbitrary seed, and
 * CSS cannot choose the colour of text on the brand colour, so this is worked
 * out here.
 *
 * Pure colour arithmetic: no DOM, no storage, no runtime imports. Mixing and
 * compositing use gamma-encoded sRGB, the way a browser paints.
 */
import type { Mode } from "@/lib/theme/theme-store";

/** Red, green and blue, each 0 to 255. Not necessarily whole numbers. */
export type Rgb = readonly [number, number, number];

/** The four colours one theme needs. Each is a lower-case `#rrggbb`. */
export interface AccentTokens {
  primary: string;
  hover: string;
  press: string;
  /** Colour of text and icons drawn on the three fills above. */
  onBrand: string;
}

export interface AccentPalette {
  /** The colour that was entered, as lower-case `#rrggbb`. */
  seed: string;
  light: AccentTokens;
  dark: AccentTokens;
  /** True where the theme's primary had to move away from the seed. */
  adjusted: { light: boolean; dark: boolean };
}

export interface AccentCheck {
  /** True only when every pair passes. */
  ok: boolean;
  pairs: { name: string; ratio: number; min: number; pass: boolean }[];
}

// --- Constants taken from src/styles/tokens.css --------------------------------
// accent.test.ts reads tokens.css, works each of these out again and fails when
// one has drifted. Change them only together with the tokens.

/** The stock primary, `--violet-500`. Entering it gives exactly the stock look. */
export const STOCK_ACCENT = "#6c5ce7";

/**
 * The surfaces contrast is measured against, per theme.
 * - `glass`: a glass-1 panel over the mesh colour that is hardest for text
 *   (the darkest in the light theme, the lightest in the dark theme).
 * - `mesh`: that same worst case with no panel in front of it.
 *
 * The model ignores the panel's blur and applies its `saturate()` with the CSS
 * filter matrix.
 */
export const ACCENT_SURFACES: Record<Mode, { glass: string; mesh: string }> = {
  light: { glass: "#ece7fd", mesh: "#d3ccf5" },
  dark: { glass: "#063846", mesh: "#0d4d54" },
};

/** How opaque the soft fill (`--color-primary-soft`) is in each theme. */
export const SOFT_ALPHA: Record<Mode, number> = { light: 0.14, dark: 0.22 };

/** The two candidates for text on the brand colour: `--paper-50` and `--ink-600`. */
export const ON_BRAND_PAPER = "#fffefb";
export const ON_BRAND_INK = "#0e1424";

// --- Contrast rules ------------------------------------------------------------

/** WCAG 2.1 AA for body text. */
const TEXT_MIN = 4.5;
/** WCAG 2.1 AA for a filled shape against what is behind it. */
const FILL_MIN = 3;

/** Names of the pairs `checkAccentTokens` reports, in the order it reports them. */
export const ACCENT_PAIR = {
  /** Primary as text on the worst-case glass panel. */
  textOnGlass: "text-on-glass",
  /** Primary as text on its own soft fill, over that panel. */
  textOnSoft: "text-on-soft",
  /** The hover colour as text on that panel. */
  hoverOnGlass: "hover-on-glass",
  /** The label of a filled button at rest, hovered and pressed. */
  onBrandPrimary: "on-brand-primary",
  onBrandHover: "on-brand-hover",
  onBrandPress: "on-brand-press",
  /** Primary as a filled shape straight on the worst-case mesh. */
  fillOnMesh: "fill-on-mesh",
} as const;

const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];

// --- Parsing and conversion ----------------------------------------------------

const HEX_SHORT = /^#[0-9a-f]{3}$/;
const HEX_LONG = /^#[0-9a-f]{6}$/;

/**
 * `#RGB` or `#RRGGBB` in any case, with surrounding spaces allowed, as
 * lower-case `#rrggbb`. Anything else, including every other CSS colour
 * syntax, is `null`.
 */
export function parseHexColor(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase();
  if (HEX_LONG.test(value)) return value;
  if (HEX_SHORT.test(value)) return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  return null;
}

/** The channels of a hex colour. Black for anything `parseHexColor` refuses. */
export function hexToRgb(hex: string): Rgb {
  const value = parseHexColor(hex);
  if (!value) return BLACK;
  return [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16)];
}

function toByte(channel: number): number {
  const n = Number(channel);
  if (Number.isNaN(n)) return 0;
  return Math.round(Math.min(255, Math.max(0, n)));
}

/**
 * A colour as lower-case `#rrggbb`. Channels are rounded and kept within 0 to
 * 255, so the result is a valid colour whatever numbers come in. This is the
 * only function whose output is ever written into a stylesheet.
 */
export function rgbToHex(rgb: Rgb): string {
  const [r, g, b] = rgb;
  return `#${[r, g, b].map((c) => toByte(c).toString(16).padStart(2, "0")).join("")}`;
}

/** A colour snapped to the whole numbers a screen can show. */
function onScreen(rgb: Rgb): Rgb {
  return [toByte(rgb[0]), toByte(rgb[1]), toByte(rgb[2])];
}

// --- Contrast ------------------------------------------------------------------

function linear(channel: number): number {
  const c = Math.min(255, Math.max(0, channel)) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.1 relative luminance: 0 for black, 1 for white. */
export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}

/** WCAG 2.1 contrast ratio, from 1 (identical) to 21 (black on white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function unit(value: number): number {
  const n = Number(value);
  return Number.isNaN(n) ? 0 : Math.min(1, Math.max(0, n));
}

/** What `fg` looks like at opacity `alpha` (0 to 1) in front of an opaque `bg`. */
export function compositeOver(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  const a = unit(alpha);
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)];
}

/** The colour a fraction `t` (0 to 1) of the way from `a` to `b`. */
export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const f = unit(t);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// --- Fitting -------------------------------------------------------------------

/** The soft fill as it is painted: the primary at the theme's opacity over the glass panel. */
function softFill(primary: Rgb, mode: Mode): Rgb {
  return onScreen(compositeOver(primary, SOFT_ALPHA[mode], hexToRgb(ACCENT_SURFACES[mode].glass)));
}

/** The two text pairs the fit works towards. */
function readableAsText(primary: Rgb, mode: Mode): boolean {
  const glass = hexToRgb(ACCENT_SURFACES[mode].glass);
  return contrastRatio(primary, glass) >= TEXT_MIN && contrastRatio(primary, softFill(primary, mode)) >= TEXT_MIN;
}

/**
 * Fit a seed to one theme. The primary is the seed shaded towards black (light
 * theme) or tinted towards white (dark theme) in steps of one percent, stopping
 * at the first step that is readable as text. Hover and press follow from it,
 * and the text colour on the fills is whichever candidate reads better across
 * all three. `null` when the seed is not a hex colour or the result fails
 * `checkAccentTokens`: the caller then keeps the stock palette.
 */
export function deriveAccentTokens(seedHex: string, mode: Mode): AccentTokens | null {
  const seed = parseHexColor(seedHex);
  if (!seed) return null;
  const from = hexToRgb(seed);
  const towards = mode === "light" ? BLACK : WHITE;

  for (let step = 0; step <= 100; step += 1) {
    const primary = onScreen(mixRgb(from, towards, step / 100));
    if (!readableAsText(primary, mode)) continue;

    const hover = onScreen(mode === "light" ? mixRgb(primary, BLACK, 0.14) : mixRgb(primary, WHITE, 0.18));
    const press = onScreen(mode === "light" ? mixRgb(primary, BLACK, 0.28) : mixRgb(primary, BLACK, 0.12));
    const worst = (text: Rgb) =>
      Math.min(contrastRatio(text, primary), contrastRatio(text, hover), contrastRatio(text, press));
    const onBrand = worst(hexToRgb(ON_BRAND_PAPER)) >= worst(hexToRgb(ON_BRAND_INK)) ? ON_BRAND_PAPER : ON_BRAND_INK;

    const tokens: AccentTokens = {
      primary: rgbToHex(primary),
      hover: rgbToHex(hover),
      press: rgbToHex(press),
      onBrand,
    };
    return checkAccentTokens(tokens, mode).ok ? tokens : null;
  }
  return null;
}

/**
 * Measure a theme's tokens against every pair the interface relies on. This is
 * the condition a palette must meet before it may be applied. Tokens that are
 * not hex colours fail with no pairs.
 */
export function checkAccentTokens(t: AccentTokens, mode: Mode): AccentCheck {
  const parsed = [t?.primary, t?.hover, t?.press, t?.onBrand].map(parseHexColor);
  if (parsed.some((value) => value === null)) return { ok: false, pairs: [] };
  const [primary, hover, press, onBrand] = parsed.map((value) => hexToRgb(value as string));
  const glass = hexToRgb(ACCENT_SURFACES[mode].glass);
  const mesh = hexToRgb(ACCENT_SURFACES[mode].mesh);
  const soft = softFill(primary, mode);

  const pair = (name: string, a: Rgb, b: Rgb, min: number) => {
    const ratio = contrastRatio(a, b);
    return { name, ratio, min, pass: ratio >= min };
  };
  const pairs = [
    pair(ACCENT_PAIR.textOnGlass, primary, glass, TEXT_MIN),
    pair(ACCENT_PAIR.textOnSoft, primary, soft, TEXT_MIN),
    pair(ACCENT_PAIR.hoverOnGlass, hover, glass, TEXT_MIN),
    pair(ACCENT_PAIR.onBrandPrimary, onBrand, primary, TEXT_MIN),
    pair(ACCENT_PAIR.onBrandHover, onBrand, hover, TEXT_MIN),
    pair(ACCENT_PAIR.onBrandPress, onBrand, press, TEXT_MIN),
    pair(ACCENT_PAIR.fillOnMesh, primary, mesh, FILL_MIN),
  ];
  return { ok: pairs.every((p) => p.pass), pairs };
}

/**
 * The palette for an entered colour, or `null` for the stock palette: when the
 * entry is not a hex colour, when it is the stock violet itself, or when either
 * theme could not be fitted.
 */
export function deriveAccentPalette(input: unknown): AccentPalette | null {
  const seed = parseHexColor(input);
  if (!seed || seed === STOCK_ACCENT) return null;
  const light = deriveAccentTokens(seed, "light");
  const dark = deriveAccentTokens(seed, "dark");
  if (!light || !dark) return null;
  return { seed, light, dark, adjusted: { light: light.primary !== seed, dark: dark.primary !== seed } };
}

// --- Stylesheet ----------------------------------------------------------------

/** The soft fill and the glow, written the way tokens.css writes them. */
function softOf(primary: string, mode: Mode): string {
  return `color-mix(in oklab, ${primary} ${Math.round(SOFT_ALPHA[mode] * 100)}%, transparent)`;
}

function glowOf(primary: string, mode: Mode): string {
  return mode === "light"
    ? `0 0 0 4px color-mix(in oklab, ${primary} 22%, transparent)`
    : `0 0 0 4px color-mix(in oklab, ${primary} 35%, transparent), 0 0 28px color-mix(in oklab, ${primary} 30%, transparent)`;
}

function ruleFor(t: AccentTokens, mode: Mode): string {
  // Every colour goes through rgbToHex again here, so no text from outside
  // this file can reach the stylesheet.
  const hex = (value: string) => rgbToHex(hexToRgb(value));
  const primary = hex(t.primary);
  const declarations = [
    `--color-primary:${primary}`,
    `--color-primary-hover:${hex(t.hover)}`,
    `--color-primary-press:${hex(t.press)}`,
    `--color-primary-soft:${softOf(primary, mode)}`,
    `--text-on-brand:${hex(t.onBrand)}`,
    `--shadow-glow-primary:${glowOf(primary, mode)}`,
  ];
  // A page marked `data-theme="admin"` is left out in the selector itself: an
  // administration surface keeps its own colours wherever it is mounted, and
  // an organisation's colour never repaints it. The app has no such page; the
  // rule holds for any that is built on these tokens. Three attribute or
  // pseudo-class parts outrank every rule in tokens.css.
  return `:root:not([data-theme="admin"])[data-mode="${mode}"]{${declarations.join(";")}}`;
}

/**
 * The stylesheet text that applies a palette: one rule per theme, overriding
 * the primary colour, its hover, press and soft forms, the text colour on it
 * and the primary glow. The focus ring and the mesh are deliberately left
 * alone. Empty when the palette does not pass `checkAccentTokens`, so an
 * unreadable palette can never be applied.
 */
export function accentCss(p: AccentPalette): string {
  if (!p || !checkAccentTokens(p.light, "light").ok || !checkAccentTokens(p.dark, "dark").ok) return "";
  return `${ruleFor(p.light, "light")}\n${ruleFor(p.dark, "dark")}`;
}
