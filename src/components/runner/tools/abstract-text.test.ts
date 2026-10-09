import { describe, expect, it } from "vitest";
import { abstractSegments } from "./AbstractText";

describe("abstractSegments", () => {
  it("turns Europe PMC <h4> headings into heading segments and strips tags", () => {
    const segs = abstractSegments("<h4>Background</h4>We ran a trial.<h4>Methods</h4>Randomised, double-blind.");
    expect(segs).toEqual([
      { kind: "heading", text: "Background" },
      { kind: "para", text: "We ran a trial." },
      { kind: "heading", text: "Methods" },
      { kind: "para", text: "Randomised, double-blind." },
    ]);
  });

  it("treats JATS <jats:title>/<title> as headings", () => {
    const segs = abstractSegments("<jats:sec><jats:title>Results</jats:title><jats:p>Effect was large.</jats:p></jats:sec>");
    expect(segs[0]).toEqual({ kind: "heading", text: "Results" });
    expect(segs[1]).toEqual({ kind: "para", text: "Effect was large." });
  });

  it("bolds a leading structured label in a plain run", () => {
    const segs = abstractSegments("Conclusions: The intervention worked.");
    expect(segs[0]).toEqual({ kind: "para", text: "The intervention worked.", label: "Conclusions" });
  });

  it("decodes entities and collapses whitespace", () => {
    expect(abstractSegments("A &amp; B   &lt;test&gt;")).toEqual([{ kind: "para", text: "A & B <test>" }]);
  });

  it("returns a single plain paragraph for tag-free text", () => {
    expect(abstractSegments("Just a plain abstract.")).toEqual([{ kind: "para", text: "Just a plain abstract." }]);
  });
});
