import { describe, expect, it } from "vitest";
import tokensCss from "@/styles/tokens.css?raw";
import type { Mode } from "@/lib/theme/theme-store";
import {
  ACCENT_PAIR,
  ACCENT_SURFACES,
  ON_BRAND_INK,
  ON_BRAND_PAPER,
  SOFT_ALPHA,
  STOCK_ACCENT,
  accentCss,
  checkAccentTokens,
  compositeOver,
  contrastRatio,
  deriveAccentPalette,
  deriveAccentTokens,
  hexToRgb,
  mixRgb,
  parseHexColor,
  relativeLuminance,
  rgbToHex,
  type AccentPalette,
  type AccentTokens,
  type Rgb,
} from "./accent";

const MODES: readonly Mode[] = ["light", "dark"];
const HEX = /^#[0-9a-f]{6}$/;

/** Every colour with each channel on a 16-step ladder: 4,096 seeds. */
function seedGrid(): string[] {
  const seeds: string[] = [];
  for (let r = 0; r <= 255; r += 17) for (let g = 0; g <= 255; g += 17) for (let b = 0; b <= 255; b += 17) seeds.push(rgbToHex([r, g, b]));
  return seeds;
}

/** The whole grid fitted to both themes, worked out once for the tests that sweep it. */
let fittedGrid: { seed: string; mode: Mode; tokens: AccentTokens | null }[] | null = null;
function fitted() {
  fittedGrid ??= seedGrid().flatMap((seed) => MODES.map((mode) => ({ seed, mode, tokens: deriveAccentTokens(seed, mode) })));
  return fittedGrid;
}

const ratioOf = (check: ReturnType<typeof checkAccentTokens>, name: string): number => {
  const pair = check.pairs.find((p) => p.name === name);
  if (!pair) throw new Error(`no pair named ${name}`);
  return pair.ratio;
};

describe("parseHexColor", () => {
  it("accepts #RGB and #RRGGBB in any case and returns lower-case #rrggbb", () => {
    expect(parseHexColor("#1A7F5A")).toBe("#1a7f5a");
    expect(parseHexColor("#1a7f5a")).toBe("#1a7f5a");
    expect(parseHexColor("#FA0")).toBe("#ffaa00");
    expect(parseHexColor("#abc")).toBe("#aabbcc");
    expect(parseHexColor("  #FFD400\n")).toBe("#ffd400");
  });

  it("rejects every other way of writing a colour, and anything trying to carry more than one", () => {
    const refused: unknown[] = [
      "red",
      "rgb()",
      "rgb(1, 2, 3)",
      "hsl(120 50% 50%)",
      "#12",
      "#1234",
      "#12345",
      "#1234567",
      "#12345678",
      "#gggggg",
      "1a7f5a",
      "#fff;}",
      "#ffffff;} body{display:none}",
      "#fff /* x */",
      "# fff",
      "#ff ff ff",
      "transparent",
      "var(--violet-500)",
      "url(https://example.test/x)",
      "",
      "   ",
      null,
      undefined,
      0xffffff,
      ["#ffffff"],
      { toString: () => "#ffffff" },
    ];
    for (const input of refused) expect(parseHexColor(input), String(input)).toBeNull();
  });
});

describe("hexToRgb and rgbToHex", () => {
  it("convert both ways", () => {
    expect(hexToRgb("#6c5ce7")).toEqual([108, 92, 231]);
    expect(hexToRgb("#FA0")).toEqual([255, 170, 0]);
    expect(rgbToHex([108, 92, 231])).toBe("#6c5ce7");
    for (const seed of seedGrid().filter((_, i) => i % 97 === 0)) expect(rgbToHex(hexToRgb(seed))).toBe(seed);
  });

  it("hexToRgb answers black for something that is not a hex colour", () => {
    expect(hexToRgb("red")).toEqual([0, 0, 0]);
    expect(hexToRgb("#fff;}")).toEqual([0, 0, 0]);
  });

  it("rgbToHex always produces a valid colour, whatever numbers come in", () => {
    expect(rgbToHex([12.4, 12.5, 12.6])).toBe("#0c0d0d");
    expect(rgbToHex([-40, 300, 255.4])).toBe("#00ffff");
    expect(rgbToHex([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])).toBe("#00ff00");
    const hostile = ["0;}", undefined, {}] as unknown as Rgb;
    expect(rgbToHex(hostile)).toMatch(HEX);
    expect(rgbToHex([] as unknown as Rgb)).toMatch(HEX);
  });
});

describe("contrast arithmetic", () => {
  it("relativeLuminance runs from 0 for black to 1 for white", () => {
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 10);
    // Green carries most of the luminance, blue the least.
    expect(relativeLuminance([0, 255, 0])).toBeCloseTo(0.7152, 10);
    expect(relativeLuminance([0, 0, 255])).toBeCloseTo(0.0722, 10);
    // Very dark channels are on the straight part of the curve, the rest on the power part.
    expect(relativeLuminance([10, 10, 10])).toBeCloseTo(10 / 255 / 12.92, 12);
    expect(relativeLuminance([11, 11, 11])).toBeCloseTo(((11 / 255 + 0.055) / 1.055) ** 2.4, 12);
    expect(relativeLuminance([128, 128, 128])).toBeCloseTo(0.2158605, 6);
  });

  it("contrastRatio is 21 for black on white, 1 for a colour on itself, and the same both ways round", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 10);
    expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 10);
    expect(contrastRatio([108, 92, 231], [108, 92, 231])).toBe(1);
    // The well-known lightest grey that passes AA on white.
    expect(contrastRatio(hexToRgb("#767676"), [255, 255, 255])).toBeCloseTo(4.54, 2);
    expect(contrastRatio(hexToRgb("#777777"), [255, 255, 255])).toBeLessThan(4.5);
  });

  it("compositeOver blends a see-through colour onto an opaque one", () => {
    const fg: Rgb = [200, 100, 0];
    const bg: Rgb = [0, 100, 200];
    expect(compositeOver(fg, 0, bg)).toEqual(bg);
    expect(compositeOver(fg, 1, bg)).toEqual(fg);
    expect(compositeOver(fg, 0.5, bg)).toEqual([100, 100, 100]);
    expect(compositeOver(fg, 0.25, bg)).toEqual([50, 100, 150]);
    // Opacity outside 0 to 1 is pinned.
    expect(compositeOver(fg, 7, bg)).toEqual(fg);
    expect(compositeOver(fg, -1, bg)).toEqual(bg);
    expect(compositeOver(fg, Number.NaN, bg)).toEqual(bg);
  });

  it("mixRgb moves a fraction of the way from one colour to another", () => {
    const a: Rgb = [0, 100, 200];
    const b: Rgb = [100, 200, 0];
    expect(mixRgb(a, b, 0)).toEqual(a);
    expect(mixRgb(a, b, 1)).toEqual(b);
    expect(mixRgb(a, b, 0.25)).toEqual([25, 125, 150]);
    expect(mixRgb(a, b, 3)).toEqual(b);
    expect(mixRgb(a, b, -3)).toEqual(a);
  });
});

describe("fitting a seed to a theme", () => {
  it("every seed on the grid gives tokens that pass every pair, in both themes", () => {
    const all = fitted();
    expect(all).toHaveLength(2 * 4096);
    const failures: string[] = [];
    for (const { seed, mode, tokens } of all) {
      if (!tokens) {
        failures.push(`${seed} ${mode}: no tokens`);
        continue;
      }
      const check = checkAccentTokens(tokens, mode);
      if (!check.ok || check.pairs.length !== 7) {
        failures.push(`${seed} ${mode}: ${JSON.stringify(check.pairs.filter((p) => !p.pass))}`);
      }
      if (!Object.values(tokens).every((value) => HEX.test(value))) failures.push(`${seed} ${mode}: not a hex colour`);
    }
    expect(failures).toEqual([]);
  });

  it("text on the brand colour is always paper in the light theme and ink in the dark theme", () => {
    const expected: Record<Mode, string> = { light: "#fffefb", dark: "#0e1424" };
    const odd = fitted().filter(({ mode, tokens }) => tokens?.onBrand !== expected[mode]);
    expect(odd.map(({ seed, mode, tokens }) => `${seed} ${mode}: ${tokens?.onBrand}`)).toEqual([]);
  });

  it("only ever darkens for the light theme and lightens for the dark theme, keeping hover and press in order", () => {
    const lum = (hex: string) => relativeLuminance(hexToRgb(hex));
    const failures: string[] = [];
    for (const { seed, mode, tokens } of fitted()) {
      if (!tokens) continue;
      const from = hexToRgb(seed);
      const primary = hexToRgb(tokens.primary);
      const moved = primary.map((channel, i) => channel - from[i]);
      if (mode === "light") {
        if (moved.some((d) => d > 0)) failures.push(`${seed} light: primary got lighter`);
        if (lum(tokens.hover) > lum(tokens.primary)) failures.push(`${seed} light: hover is lighter than primary`);
        if (lum(tokens.press) > lum(tokens.hover)) failures.push(`${seed} light: press is lighter than hover`);
      } else {
        if (moved.some((d) => d < 0)) failures.push(`${seed} dark: primary got darker`);
        if (lum(tokens.hover) < lum(tokens.primary)) failures.push(`${seed} dark: hover is darker than primary`);
        if (lum(tokens.press) > lum(tokens.primary)) failures.push(`${seed} dark: press is lighter than primary`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("leaves a seed alone when it already reads as text, and moves it no further than it has to", () => {
    const failures: string[] = [];
    let moved = 0;
    for (const { seed, mode, tokens } of fitted()) {
      if (!tokens) continue;
      /** Whether this primary passes the two text pairs the fit works towards. */
      const readable = (primary: string) =>
        checkAccentTokens({ ...tokens, primary }, mode)
          .pairs.slice(0, 2)
          .every((p) => p.pass);

      if ((tokens.primary === seed) !== readable(seed)) failures.push(`${seed} ${mode}: adjusted without need, or not adjusted`);
      if (tokens.primary === seed) continue;
      moved += 1;

      // One step back towards the seed must fail, or the fit overshot.
      const towards: Rgb = mode === "light" ? [0, 0, 0] : [255, 255, 255];
      const from = hexToRgb(seed);
      let step = 1;
      while (step <= 100 && rgbToHex(mixRgb(from, towards, step / 100)) !== tokens.primary) step += 1;
      if (step > 100) failures.push(`${seed} ${mode}: not a whole step from the seed`);
      else if (readable(rgbToHex(mixRgb(from, towards, (step - 1) / 100)))) failures.push(`${seed} ${mode}: overshot at step ${step}`);
    }
    expect(failures).toEqual([]);
    // The sweep really did exercise the fit: most seeds need moving in one theme or the other.
    expect(moved).toBeGreaterThan(4096);
  });

  it("gives the worked examples from the design", () => {
    const green = deriveAccentPalette("#00A651") as AccentPalette;
    expect(green.seed).toBe("#00a651");
    expect(green.light).toEqual({ primary: "#006a34", hover: "#005b2d", press: "#004c25", onBrand: "#fffefb" });
    expect(green.dark).toEqual({ primary: "#8ad6af", hover: "#9fddbd", press: "#79bc9a", onBrand: "#0e1424" });
    expect(green.adjusted).toEqual({ light: true, dark: true });

    // A bright brand gets darker in the light theme and is left alone in the dark one.
    const yellow = deriveAccentPalette("#FFD400") as AccentPalette;
    expect(yellow.light.primary).toBe("#6e5b00");
    expect(yellow.dark.primary).toBe("#ffd400");
    expect(yellow.adjusted).toEqual({ light: true, dark: false });

    // A dark brand is the other way round.
    const navy = deriveAccentPalette("#001F5B") as AccentPalette;
    expect(navy.light.primary).toBe("#001f5b");
    expect(navy.dark.primary).toBe("#bdc5d4");
    expect(navy.adjusted).toEqual({ light: false, dark: true });
  });

  it("handles the extremes", () => {
    const black = deriveAccentPalette("#000") as AccentPalette;
    expect(black.light.primary).toBe("#000000");
    expect(black.adjusted.dark).toBe(true);
    const white = deriveAccentPalette("#fff") as AccentPalette;
    expect(white.dark.primary).toBe("#ffffff");
    expect(white.adjusted.light).toBe(true);
  });

  it("deriveAccentTokens refuses a seed that is not a hex colour", () => {
    expect(deriveAccentTokens("red", "light")).toBeNull();
    expect(deriveAccentTokens("#fff;}", "dark")).toBeNull();
    expect(deriveAccentTokens("", "light")).toBeNull();
  });
});

describe("deriveAccentPalette", () => {
  it("is null, meaning the stock palette, for the stock violet itself", () => {
    expect(deriveAccentPalette(STOCK_ACCENT)).toBeNull();
    expect(deriveAccentPalette("#6C5CE7")).toBeNull();
    expect(deriveAccentPalette(" #6c5ce7 ")).toBeNull();
    // One step away from it is an ordinary seed.
    expect(deriveAccentPalette("#6c5ce8")).not.toBeNull();
  });

  it("is null for anything that is not a hex colour", () => {
    for (const input of ["", "red", "rgb(0,0,0)", "#12", "#fff;}", null, undefined, 42, {}]) {
      expect(deriveAccentPalette(input), String(input)).toBeNull();
    }
  });

  it("gives a palette for every seed on the grid, with the seed normalised", () => {
    for (const seed of seedGrid()) {
      const palette = deriveAccentPalette(seed.toUpperCase());
      expect(palette?.seed, seed).toBe(seed);
      expect(palette?.adjusted.light, seed).toBe(palette?.light.primary !== seed);
      expect(palette?.adjusted.dark, seed).toBe(palette?.dark.primary !== seed);
    }
  });
});

describe("checkAccentTokens", () => {
  // The stock palette, read off tokens.css.
  const stockLight: AccentTokens = { primary: "#6c5ce7", hover: "#5848d6", press: "#4338ca", onBrand: "#fffefb" };
  const stockDark: AccentTokens = { primary: "#8473ed", hover: "#a395f4", press: "#6c5ce7", onBrand: "#fffefb" };

  it("reports the seven pairs in a fixed order with their minimums", () => {
    const check = checkAccentTokens(deriveAccentTokens("#00a651", "light") as AccentTokens, "light");
    expect(check.ok).toBe(true);
    expect(check.pairs.map((p) => [p.name, p.min])).toEqual([
      [ACCENT_PAIR.textOnGlass, 4.5],
      [ACCENT_PAIR.textOnSoft, 4.5],
      [ACCENT_PAIR.hoverOnGlass, 4.5],
      [ACCENT_PAIR.onBrandPrimary, 4.5],
      [ACCENT_PAIR.onBrandHover, 4.5],
      [ACCENT_PAIR.onBrandPress, 4.5],
      [ACCENT_PAIR.fillOnMesh, 3],
    ]);
    for (const p of check.pairs) expect(p.pass).toBe(p.ratio >= p.min);
  });

  it("measures each pair between the two colours its name says", () => {
    for (const mode of MODES) {
      const tokens = deriveAccentTokens("#00a651", mode) as AccentTokens;
      const check = checkAccentTokens(tokens, mode);
      const primary = hexToRgb(tokens.primary);
      const hover = hexToRgb(tokens.hover);
      const press = hexToRgb(tokens.press);
      const onBrand = hexToRgb(tokens.onBrand);
      const glass = hexToRgb(ACCENT_SURFACES[mode].glass);
      const mesh = hexToRgb(ACCENT_SURFACES[mode].mesh);
      // The soft fill is the primary at the theme's opacity over the glass, as a screen shows it.
      const soft = hexToRgb(rgbToHex(compositeOver(primary, SOFT_ALPHA[mode], glass)));

      const measured = Object.fromEntries(check.pairs.map((p) => [p.name, p.ratio]));
      expect(measured).toEqual({
        [ACCENT_PAIR.textOnGlass]: contrastRatio(primary, glass),
        [ACCENT_PAIR.textOnSoft]: contrastRatio(primary, soft),
        [ACCENT_PAIR.hoverOnGlass]: contrastRatio(hover, glass),
        [ACCENT_PAIR.onBrandPrimary]: contrastRatio(onBrand, primary),
        [ACCENT_PAIR.onBrandHover]: contrastRatio(onBrand, hover),
        [ACCENT_PAIR.onBrandPress]: contrastRatio(onBrand, press),
        [ACCENT_PAIR.fillOnMesh]: contrastRatio(primary, mesh),
      });
      // Seven different measurements, not one repeated.
      expect(new Set(Object.values(measured)).size).toBe(7);
    }
  });

  it("measures the stock palette's known shortfalls, to the figures in the design", () => {
    // Text on glass, text on the soft pill, a filled button's label, and that label hovered.
    const figures = (check: ReturnType<typeof checkAccentTokens>) =>
      [ACCENT_PAIR.textOnGlass, ACCENT_PAIR.textOnSoft, ACCENT_PAIR.onBrandPrimary, ACCENT_PAIR.onBrandHover].map((name) =>
        ratioOf(check, name).toFixed(2),
      );

    const light = checkAccentTokens(stockLight, "light");
    expect(light.ok).toBe(false);
    expect(figures(light)).toEqual(["4.03", "3.42", "4.82", "6.29"]);
    expect(light.pairs.filter((p) => !p.pass).map((p) => p.name)).toEqual([ACCENT_PAIR.textOnGlass, ACCENT_PAIR.textOnSoft]);

    const dark = checkAccentTokens(stockDark, "dark");
    expect(dark.ok).toBe(false);
    expect(figures(dark)).toEqual(["3.40", "2.65", "3.68", "2.55"]);
  });

  it("fails a single weak pair", () => {
    const good = deriveAccentTokens("#00a651", "dark") as AccentTokens;
    // Pale text on the pale dark-theme fill.
    const check = checkAccentTokens({ ...good, onBrand: "#fffefb" }, "dark");
    expect(check.ok).toBe(false);
    expect(check.pairs.filter((p) => !p.pass).map((p) => p.name)).toEqual([
      ACCENT_PAIR.onBrandPrimary,
      ACCENT_PAIR.onBrandHover,
      ACCENT_PAIR.onBrandPress,
    ]);
  });

  it("fails tokens that are not hex colours, with nothing measured", () => {
    const good = deriveAccentTokens("#00a651", "light") as AccentTokens;
    expect(checkAccentTokens({ ...good, hover: "red" }, "light")).toEqual({ ok: false, pairs: [] });
    expect(checkAccentTokens({ ...good, primary: "#000;}" }, "light")).toEqual({ ok: false, pairs: [] });
    expect(checkAccentTokens(null as unknown as AccentTokens, "light")).toEqual({ ok: false, pairs: [] });
  });
});

describe("accentCss", () => {
  const palette = deriveAccentPalette("#00A651") as AccentPalette;
  const css = accentCss(palette);

  it("is one rule per theme, each leaving the admin theme out in its selector", () => {
    const rules = css.split("\n");
    expect(rules).toHaveLength(2);
    expect(rules[0].startsWith(':root:not([data-theme="admin"])[data-mode="light"]{')).toBe(true);
    expect(rules[1].startsWith(':root:not([data-theme="admin"])[data-mode="dark"]{')).toBe(true);
    for (const rule of rules) {
      expect(rule.endsWith("}")).toBe(true);
      // One block, nothing nested and nothing after it.
      expect(rule.match(/[{}]/g)).toEqual(["{", "}"]);
    }
  });

  it("overrides exactly the six brand tokens, and not the focus ring or the mesh", () => {
    for (const rule of css.split("\n")) {
      const names = Array.from(rule.matchAll(/(--[a-z0-9-]+):/g), (m) => m[1]);
      expect(names).toEqual([
        "--color-primary",
        "--color-primary-hover",
        "--color-primary-press",
        "--color-primary-soft",
        "--text-on-brand",
        "--shadow-glow-primary",
      ]);
    }
    expect(css).not.toMatch(/focus-ring|mesh-stop/);
  });

  it("gives each token its own colour, per theme", () => {
    const rules = css.split("\n");
    MODES.forEach((mode, i) => {
      const value = (name: string) => new RegExp(`${name}:([^;}]+)`).exec(rules[i])?.[1];
      const t = palette[mode];
      expect(value("--color-primary")).toBe(t.primary);
      expect(value("--color-primary-hover")).toBe(t.hover);
      expect(value("--color-primary-press")).toBe(t.press);
      expect(value("--text-on-brand")).toBe(t.onBrand);
      expect(new Set([t.primary, t.hover, t.press, t.onBrand]).size).toBe(4);
    });
  });

  it("writes every colour as lower-case #rrggbb even when a token was spelled another way", () => {
    const shouted: AccentPalette = {
      ...palette,
      light: { primary: "#006A34", hover: "#005B2D", press: "#004C25", onBrand: "#FFFEFB" },
      dark: { ...palette.dark, press: " #79BC9A " },
    };
    expect(accentCss(shouted)).toBe(css);
    // Short form too: #000 is black, which passes in the light theme.
    const black = deriveAccentPalette("#000") as AccentPalette;
    const short = accentCss({ ...black, light: { ...black.light, primary: "#000", hover: "#000", press: "#000" } });
    expect(short).toBe(accentCss(black));
    expect(short).not.toMatch(/#000[;,) ]/);
  });

  it("contains no colour except lower-case #rrggbb ones that came from the palette", () => {
    for (const seed of seedGrid().filter((_, i) => i % 13 === 0)) {
      const p = deriveAccentPalette(seed) as AccentPalette;
      const text = accentCss(p);
      const allowed = new Set([...Object.values(p.light), ...Object.values(p.dark)]);
      const colours = text.match(/#[^\s;,)}]*/g) ?? [];
      // 2 themes x (primary, hover, press, on-brand, soft) plus 1 glow in light and 2 in dark.
      expect(colours).toHaveLength(13);
      for (const colour of colours) {
        expect(colour, seed).toMatch(HEX);
        expect(allowed.has(colour), `${seed} ${colour}`).toBe(true);
      }
      // No other colour syntax, and nothing that could reach outside the two rules.
      expect(text).not.toMatch(/rgb|hsl|url\(|@|\\|<|\/\*/);
      const withoutKnownParts = text
        .replaceAll(':not([data-theme="admin"])', "")
        .replace(/color-mix\(in oklab, #[0-9a-f]{6} \d+%, transparent\)/g, "");
      expect(withoutKnownParts).not.toMatch(/[()]/);
    }
  });

  it("writes nothing for a palette whose tokens are not colours, however it was put together", () => {
    const forged = { ...palette, light: { ...palette.light, primary: "#000;} body{display:none} x{" } };
    expect(accentCss(forged)).toBe("");
    expect(accentCss({ ...palette, dark: { ...palette.dark, onBrand: "red" } })).toBe("");
    expect(accentCss(null as unknown as AccentPalette)).toBe("");
  });

  it("writes nothing for a palette that would not be readable", () => {
    // Real colours, but the stock violet does not pass as text on glass.
    const unreadable: AccentPalette = {
      seed: "#6c5ce7",
      light: { primary: "#6c5ce7", hover: "#5848d6", press: "#4338ca", onBrand: "#fffefb" },
      dark: palette.dark,
      adjusted: { light: false, dark: true },
    };
    expect(accentCss(unreadable)).toBe("");
  });
});

// --- Drift against src/styles/tokens.css ---------------------------------------
// accent.ts carries a few values worked out from the design tokens. These tests
// work them out again from the stylesheet itself, so editing a mesh colour, the
// glass fill or the soft opacity without updating accent.ts fails here.

/** The custom properties declared in the first top-level block with this selector. */
function declarationsOf(selector: string): Map<string, string> {
  const at = tokensCss.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`tokens.css has no block for ${selector}`);
  const open = tokensCss.indexOf("{", at);
  const body = tokensCss.slice(open + 1, tokensCss.indexOf("}", open)).replace(/\/\*[\s\S]*?\*\//g, "");
  const found = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) found.set(m[1], m[2].replace(/\s+/g, " ").trim());
  return found;
}

const SCALES = declarationsOf(":root");
const THEME: Record<Mode, Map<string, string>> = {
  light: declarationsOf(':root,\n[data-mode="light"]'),
  dark: declarationsOf('[data-mode="dark"]'),
};

function token(map: Map<string, string>, name: string): string {
  const value = map.get(name);
  if (value === undefined) throw new Error(`tokens.css does not declare ${name} where expected`);
  return value;
}

/** A token that is a colour from the scales, as lower-case hex. */
function colourOf(map: Map<string, string>, name: string): string {
  const value = token(map, name);
  const viaScale = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  const hex = parseHexColor(viaScale ? token(SCALES, viaScale[1]) : value);
  if (!hex) throw new Error(`${name} is not a plain colour: ${value}`);
  return hex;
}

function rgbaOf(value: string): { rgb: Rgb; alpha: number } {
  const m = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(value);
  if (!m) throw new Error(`not an rgba() colour: ${value}`);
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: Number(m[4]) };
}

/** The CSS `saturate()` filter, as its colour matrix. */
function saturate([r, g, b]: Rgb, s: number): Rgb {
  const pin = (v: number) => Math.min(255, Math.max(0, v));
  return [
    pin((0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b),
    pin((0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b),
    pin((0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b),
  ];
}

/** Both surfaces for each of the four mesh colours of a theme. */
function surfacesOf(mode: Mode): { stop: string; mesh: string; glass: string }[] {
  const theme = THEME[mode];
  const canvas = hexToRgb(colourOf(theme, "--bg-canvas"));
  const meshOpacity = Number(token(theme, "--mesh-opacity"));
  const fill = rgbaOf(token(theme, "--glass-1-fill"));
  const saturation = Number.parseFloat(token(theme, "--glass-1-saturate")) / 100;
  expect(token(theme, "--glass-1-saturate")).toMatch(/^\d+%$/);
  expect(meshOpacity).toBeGreaterThan(0);

  return [1, 2, 3, 4].map((n) => {
    const stop = colourOf(theme, `--mesh-stop-${n}`);
    // The mesh layer is the stop colour at the mesh opacity over the canvas...
    const mesh = compositeOver(hexToRgb(stop), meshOpacity, canvas);
    // ...and a glass-1 panel saturates what is behind it, then lays its fill on top.
    const glass = compositeOver(fill.rgb, fill.alpha, saturate(mesh, saturation));
    return { stop, mesh: rgbToHex(mesh), glass: rgbToHex(glass) };
  });
}

/** The hardest surface for text: the darkest in the light theme, the lightest in the dark one. */
function worst(mode: Mode, colours: string[]): string {
  const lum = (hex: string) => relativeLuminance(hexToRgb(hex));
  return colours.reduce((a, b) => ((mode === "light" ? lum(b) < lum(a) : lum(b) > lum(a)) ? b : a));
}

describe("the constants taken from tokens.css", () => {
  it("the worst-case glass and mesh surfaces are still what accent.ts measures against", () => {
    for (const mode of MODES) {
      const all = surfacesOf(mode);
      expect(all).toHaveLength(4);
      expect(new Set(all.map((s) => s.stop)).size).toBe(4);
      expect({ mode, glass: worst(mode, all.map((s) => s.glass)), mesh: worst(mode, all.map((s) => s.mesh)) }).toEqual({
        mode,
        ...ACCENT_SURFACES[mode],
      });
    }
  });

  it("the four constants are the ones the design worked out", () => {
    expect(ACCENT_SURFACES).toEqual({
      light: { glass: "#ece7fd", mesh: "#d3ccf5" },
      dark: { glass: "#063846", mesh: "#0d4d54" },
    });
    // Violet is the hardest light mesh colour and turquoise the hardest dark one.
    expect(surfacesOf("light").find((s) => s.glass === ACCENT_SURFACES.light.glass)?.stop).toBe(colourOf(SCALES, "--violet-300"));
    expect(surfacesOf("dark").find((s) => s.glass === ACCENT_SURFACES.dark.glass)?.stop).toBe(colourOf(SCALES, "--turquoise-700"));
  });

  it("the more opaque glass-2 panel is never a harder surface than glass-1", () => {
    for (const mode of MODES) {
      const theme = THEME[mode];
      const canvas = hexToRgb(colourOf(theme, "--bg-canvas"));
      const fill = rgbaOf(token(theme, "--glass-2-fill"));
      const saturation = Number.parseFloat(token(theme, "--glass-2-saturate")) / 100;
      const glass2 = [1, 2, 3, 4].map((n) => {
        const mesh = compositeOver(hexToRgb(colourOf(theme, `--mesh-stop-${n}`)), Number(token(theme, "--mesh-opacity")), canvas);
        return rgbToHex(compositeOver(fill.rgb, fill.alpha, saturate(mesh, saturation)));
      });
      const hardest = relativeLuminance(hexToRgb(worst(mode, glass2)));
      const measured = relativeLuminance(hexToRgb(ACCENT_SURFACES[mode].glass));
      if (mode === "light") expect(hardest).toBeGreaterThanOrEqual(measured);
      else expect(hardest).toBeLessThanOrEqual(measured);
    }
  });

  it("the stock seed and the two text colours are still the tokens they stand for", () => {
    expect(STOCK_ACCENT).toBe(colourOf(SCALES, "--violet-500"));
    expect(colourOf(THEME.light, "--color-primary")).toBe(STOCK_ACCENT);
    expect(ON_BRAND_PAPER).toBe(colourOf(SCALES, "--paper-50"));
    expect(ON_BRAND_INK).toBe(colourOf(SCALES, "--ink-600"));
    // Both themes use paper for text on the brand colour today.
    expect(colourOf(THEME.light, "--text-on-brand")).toBe(ON_BRAND_PAPER);
    expect(colourOf(THEME.dark, "--text-on-brand")).toBe(ON_BRAND_PAPER);
  });

  it("the soft fill and the glow are written with the same formulas as the tokens", () => {
    const palette = deriveAccentPalette("#00A651") as AccentPalette;
    const rules = accentCss(palette).split("\n");
    MODES.forEach((mode, i) => {
      const theme = THEME[mode];
      const primary = palette[mode].primary;
      // The tokens name a violet from the scale where the override names the fitted primary.
      const withPrimary = (value: string) => value.replace(/var\(--violet-\d+\)/g, primary);
      const declared = (name: string) => new RegExp(`${name}:([^;}]+)`).exec(rules[i])?.[1];

      expect(token(theme, "--color-primary-soft")).toMatch(/^color-mix\(in oklab, var\(--violet-\d+\) \d+%, transparent\)$/);
      expect(declared("--color-primary-soft")).toBe(withPrimary(token(theme, "--color-primary-soft")));
      expect(declared("--shadow-glow-primary")).toBe(withPrimary(token(theme, "--shadow-glow-primary")));

      const percent = /(\d+)%/.exec(token(theme, "--color-primary-soft"))?.[1];
      expect(SOFT_ALPHA[mode]).toBe(Number(percent) / 100);
    });
  });

  it("every token the stylesheet overrides is one tokens.css declares for both themes", () => {
    const overridden = Array.from(accentCss(deriveAccentPalette("#00A651") as AccentPalette).matchAll(/(--[a-z0-9-]+):/g), (m) => m[1]);
    expect(overridden).toHaveLength(12);
    for (const name of overridden) {
      expect(THEME.light.has(name), `light ${name}`).toBe(true);
      expect(THEME.dark.has(name), `dark ${name}`).toBe(true);
    }
  });

  it("no rule in tokens.css is specific enough to beat the override", () => {
    // The override's selector has three attribute or pseudo-class parts. Count
    // the same parts in every selector that sets a brand token.
    const blocks = Array.from(tokensCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g));
    const setters = blocks.filter(([, , body]) => /--color-primary\s*:|--text-on-brand\s*:|--shadow-glow-primary\s*:/.test(body));
    // The light block and the dark block, at the least.
    expect(setters.length).toBeGreaterThanOrEqual(2);
    for (const [, selectors] of setters) {
      for (const selector of selectors.split(",")) {
        const parts = (selector.match(/\[[^\]]*\]|:[a-z-]+|\.[a-z-]+/g) ?? []).length;
        expect(selector).not.toContain("#");
        expect(parts, selector.trim()).toBeLessThan(3);
      }
    }
  });
});
