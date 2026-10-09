/**
 * Scholea — Tailwind v3 config.
 * Every brand/semantic value resolves to a CSS variable (see src/styles/tokens.css)
 * so the runtime theme switch (light/dark) works without rebuilding utilities.
 */
import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

const cssVar = (name: string) => `var(--${name})`;
const scale = (keys: number[], prefix: string) =>
  Object.fromEntries(keys.map((k) => [k, cssVar(`${prefix}-${k}`)]));

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["selector", '[data-mode="dark"]'],
  theme: {
    extend: {
      colors: {
        canvas: cssVar("bg-canvas"),
        elevated: cssVar("bg-elevated"),
        sunken: cssVar("bg-sunken"),

        ink: {
          DEFAULT: cssVar("text-primary"),
          muted: cssVar("text-muted"),
          soft: cssVar("text-secondary"),
          link: cssVar("text-link"),
          onBrand: cssVar("text-on-brand"),
          // Solid scrim ink behind GlassOverlay (its opacity is set inline).
          700: cssVar("ink-700"),
        },
        // Dimmed backdrop for the hand-rolled dialogs. Colours here are bare CSS
        // variables, so Tailwind's "/50" opacity modifier emits nothing for them.
        scrim: "color-mix(in oklab, var(--ink-700) 50%, transparent)",

        primary: {
          DEFAULT: cssVar("color-primary"),
          hover: cssVar("color-primary-hover"),
          press: cssVar("color-primary-press"),
          soft: cssVar("color-primary-soft"),
        },
        accent: {
          DEFAULT: cssVar("color-accent"),
          soft: cssVar("color-accent-soft"),
        },

        success: { DEFAULT: cssVar("color-success"), soft: cssVar("color-success-soft") },
        info: { DEFAULT: cssVar("color-info"), soft: cssVar("color-info-soft") },
        warning: { DEFAULT: cssVar("color-warning"), soft: cssVar("color-warning-soft") },
        danger: { DEFAULT: cssVar("color-danger"), soft: cssVar("color-danger-soft") },

        rob: {
          low: cssVar("rob-low"),
          someConcern: cssVar("rob-some-concern"),
          high: cssVar("rob-high"),
        },

        violet: scale([50, 100, 200, 300, 400, 500, 600, 700, 800, 900], "violet"),
        turquoise: scale([300, 400, 500, 600, 700], "turquoise"),
        sky: scale([300, 400, 500, 600, 700], "sky"),
        sun: scale([300, 400, 500, 600, 700], "sun"),
        coral: scale([300, 400, 500, 600, 700], "coral"),
        mint: scale([300, 400, 500, 600, 700], "mint"),
      },

      borderColor: {
        hairline: cssVar("border-hairline"),
        strong: cssVar("border-strong"),
      },

      borderRadius: {
        input: cssVar("radius-input"),
        card: cssVar("radius-card"),
        modal: cssVar("radius-modal"),
        pill: cssVar("radius-pill"),
      },

      fontFamily: {
        display: ["var(--font-display)"],
        sans: ["var(--font-body)"],
        serif: ["var(--font-serif)"],
        mono: ["var(--font-mono)"],
      },
      fontSize: {
        xs: [cssVar("text-xs"), { lineHeight: cssVar("lh-normal") }],
        sm: [cssVar("text-sm"), { lineHeight: cssVar("lh-normal") }],
        base: [cssVar("text-base"), { lineHeight: cssVar("lh-normal") }],
        md: [cssVar("text-md"), { lineHeight: cssVar("lh-normal") }],
        lg: [cssVar("text-lg"), { lineHeight: cssVar("lh-snug") }],
        xl: [cssVar("text-xl"), { lineHeight: cssVar("lh-snug") }],
        "2xl": [cssVar("text-2xl"), { lineHeight: cssVar("lh-snug") }],
        "3xl": [cssVar("text-3xl"), { lineHeight: cssVar("lh-tight") }],
        "4xl": [cssVar("text-4xl"), { lineHeight: cssVar("lh-tight") }],
        "5xl": [cssVar("text-5xl"), { lineHeight: cssVar("lh-tight") }],
      },

      boxShadow: {
        1: cssVar("shadow-1"),
        2: cssVar("shadow-2"),
        "glow-primary": cssVar("shadow-glow-primary"),
        "glow-success": cssVar("shadow-glow-success"),
      },

      transitionTimingFunction: {
        entrance: cssVar("ease-entrance"),
        exit: cssVar("ease-exit"),
        standard: cssVar("ease-standard"),
      },
      transitionDuration: {
        micro: "var(--dur-micro)",
        short: "var(--dur-short)",
        step: "var(--dur-step)",
        celebrate: "var(--dur-celebrate)",
      },

      zIndex: {
        nav: "40",
        overlay: "90",
        modal: "100",
        toast: "1000",
      },
    },
  },
  plugins: [
    plugin(({ addUtilities, addComponents }) => {
      addComponents({
        ".glass-1": {
          background: cssVar("glass-1-fill"),
          backdropFilter: `blur(${cssVar("glass-1-blur")}) saturate(${cssVar("glass-1-saturate")})`,
          WebkitBackdropFilter: `blur(${cssVar("glass-1-blur")}) saturate(${cssVar("glass-1-saturate")})`,
          border: `1px solid ${cssVar("glass-1-border")}`,
          borderRadius: cssVar("radius-card"),
          boxShadow: cssVar("shadow-1"),
        },
        ".glass-2": {
          background: cssVar("glass-2-fill"),
          backdropFilter: `blur(${cssVar("glass-2-blur")}) saturate(${cssVar("glass-2-saturate")})`,
          WebkitBackdropFilter: `blur(${cssVar("glass-2-blur")}) saturate(${cssVar("glass-2-saturate")})`,
          border: `1px solid ${cssVar("glass-2-border")}`,
          borderRadius: cssVar("radius-modal"),
          boxShadow: cssVar("shadow-2"),
        },
        ".glass-highlight": { position: "relative" },
        ".glass-highlight::before": {
          content: '""',
          position: "absolute",
          insetInline: "0",
          top: "0",
          height: "1px",
          borderRadius: "inherit",
          background: `linear-gradient(90deg, transparent, ${cssVar("glass-1-highlight")} 30%, ${cssVar("glass-1-highlight")} 70%, transparent)`,
          pointerEvents: "none",
        },
        ".focus-ring": {
          outline: "none",
          boxShadow: `0 0 0 2px ${cssVar("focus-ring-inner")}, 0 0 0 calc(2px + ${cssVar("focus-ring-width")}) ${cssVar("focus-ring-outer")}`,
        },
        ".num-tabular": {
          fontVariantNumeric: "tabular-nums",
          fontFeatureSettings: cssVar("features-data"),
        },
      });
      addUtilities({
        ".bg-mesh": {
          backgroundImage: `
            radial-gradient(at 12% 8%, var(--mesh-stop-1) 0px, transparent 50%),
            radial-gradient(at 88% 14%, var(--mesh-stop-2) 0px, transparent 55%),
            radial-gradient(at 24% 92%, var(--mesh-stop-3) 0px, transparent 60%),
            radial-gradient(at 78% 86%, var(--mesh-stop-4) 0px, transparent 50%)`,
          backgroundColor: cssVar("bg-canvas"),
        },
        ".bg-mesh-fade": { opacity: "var(--mesh-opacity)" },
        ".bg-grain": {
          backgroundImage: "url('/grain.svg')",
          backgroundSize: "180px 180px",
          opacity: "var(--grain-opacity)",
          mixBlendMode: "overlay",
          pointerEvents: "none",
        },
      });
    }),
  ],
};

export default config;
