import { describe, expect, it } from "vitest";
import { extractFullText, stripMarkup } from "./appraisal-enrich";

describe("stripMarkup", () => {
  it("strips JATS/HTML tags and a leading 'Abstract' label", () => {
    expect(stripMarkup("<jats:p>Abstract We randomised 60 patients.</jats:p>")).toBe("We randomised 60 patients.");
    expect(stripMarkup("A &amp; B &lt;x&gt;")).toBe("A & B <x>");
  });
});

describe("extractFullText", () => {
  const xml = `<?xml version="1.0"?>
    <article>
      <body>
        <sec><title>Introduction</title><p>Background context for the trial rationale.</p></sec>
        <sec><title>Methods</title><p>Participants were randomised using a computer-generated sequence with allocation concealment.</p></sec>
        <sec><title>Outcome assessment</title><p>Outcomes were assessed blind to allocation.</p></sec>
      </body>
    </article>`;

  it("prefers methods/outcome sections over the introduction", () => {
    const text = extractFullText(xml);
    expect(text).toContain("computer-generated sequence");
    expect(text).toContain("assessed blind");
    expect(text).not.toContain("Background context");
  });

  it("falls back to the whole body when no section titles match", () => {
    const plain = `<article><body><sec><title>Discussion</title><p>General remarks only.</p></sec></body></article>`;
    expect(extractFullText(plain)).toContain("General remarks only");
  });

  it("returns undefined for non-XML or bodyless input", () => {
    expect(extractFullText("not xml at all <<<")).toBeUndefined();
    expect(extractFullText("<article><front/></article>")).toBeUndefined();
  });

  it("truncates to the requested limit", () => {
    const long = `<article><body><sec><title>Methods</title><p>${"x".repeat(5000)}</p></sec></body></article>`;
    expect(extractFullText(long, 500)?.length).toBe(500);
  });
});
