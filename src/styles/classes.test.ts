import { describe, expect, it } from "vitest";

// The theme colours in tailwind.config.ts are CSS variables (`var(--bg-elevated)`),
// so the runtime theme switch needs no rebuild. The price: Tailwind cannot put an
// opacity on such a colour. A class like `bg-elevated/60` is not an error. It
// simply compiles to nothing, and the element is left without the style (a
// header with no background, a row separator in the browser's default grey).
//
// The same goes for a utility that takes a colour the theme does not define for
// it, such as `ring-hairline` (hairline is a border colour only).
//
// These screens were cleaned of both, and the shared glass components and form
// primitives have none. This keeps them clean.

const SOURCES = import.meta.glob(
  [
    "../features/auth/**/*.tsx",
    "../features/collab/InvitationList.tsx",
    "../features/collab/ShareDialog.tsx",
    "../features/instance/**/*.tsx",
    "../features/runner/**/*.tsx",
    "../components/glass/**/*.tsx",
    "../components/ui/**/*.tsx",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

/** Every colour name the theme defines as a CSS variable. */
const TOKEN = "(?:canvas|elevated|sunken|ink|primary|accent|success|info|warning|danger|rob|violet|turquoise|sky|sun|coral|mint|hairline|strong)";
const WITH_OPACITY = new RegExp(`(?:[a-z-]+:)*(?:bg|text|border|ring|divide|outline|from|via|to|fill|stroke|shadow|accent|caret|decoration|placeholder)-${TOKEN}(?:-[A-Za-z0-9]+)*/\\d+`, "g");
const NO_SUCH_COLOUR = /(?:[a-z-]+:)*(?:ring|divide|outline)-(?:hairline|strong)\b/g;

describe("classes that compile to nothing", () => {
  it("looks at the screens it is meant to", () => {
    const files = Object.keys(SOURCES).filter((f) => !f.includes(".test."));
    expect(files.length).toBeGreaterThan(15);
    expect(files.some((f) => f.endsWith("/auth/AccountMenu.tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith("/collab/InvitationList.tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith("/glass/Overlay.tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith("/ui/fields.tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith("/runner/StudyRunner.tsx"))).toBe(true);
  });

  it("recognises one when it sees it", () => {
    const sample = 'className="sticky bg-canvas/80 hover:bg-elevated/60 border-hairline/60 text-ink-soft ring-1 ring-hairline bg-primary-soft w-1/2"';
    expect(sample.match(WITH_OPACITY)).toEqual(["bg-canvas/80", "hover:bg-elevated/60", "border-hairline/60"]);
    expect(sample.match(NO_SUCH_COLOUR)).toEqual(["ring-hairline"]);
  });

  it("has none in the account, invitation and sharing screens, the study screen, the glass components and the form primitives", () => {
    const found: string[] = [];
    for (const [file, source] of Object.entries(SOURCES)) {
      if (file.includes(".test.")) continue;
      for (const hit of [...(source.match(WITH_OPACITY) ?? []), ...(source.match(NO_SUCH_COLOUR) ?? [])]) found.push(`${file.replace("../", "")}: ${hit}`);
    }
    expect(found).toEqual([]);
  });
});
