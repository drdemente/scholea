import { describe, expect, it } from "vitest";
import { compileManuscript } from "./compile";
import { toHTML, toLaTeX, toMarkdown } from "./export";
import type { Project } from "@/lib/db/schema";
import type { StudyTypeConfig } from "@/lib/study/types";

const config: StudyTypeConfig = {
  id: "systematic-review",
  label: "Systematic Review",
  family: "review",
  reportingStandard: "PRISMA-2020",
  steps: [
    {
      id: "question",
      title: "Frame the question",
      guide: { basic: [] },
      inputs: [
        { kind: "text", id: "population", label: "Population" },
        { kind: "textarea", id: "question", label: "Question" },
        { kind: "select", id: "measure", label: "Measure", options: [{ value: "SMD", label: "Standardised mean difference" }] },
      ],
      validations: [],
    },
    {
      id: "search",
      title: "Search",
      tool: "search",
      guide: { basic: [] },
      inputs: [],
      validations: [],
    },
    { id: "empty", title: "Empty step", guide: { basic: [] }, inputs: [], validations: [] },
  ],
};

const project: Project = {
  id: "p",
  title: "Mindfulness for exam anxiety",
  studyType: "systematic-review",
  stepData: {
    question: { population: "University students", question: "Does mindfulness reduce exam anxiety?", measure: "SMD" },
    search: { nIdentified: 1200, records: [{ id: "r1", source: "europepmc", title: "A trial", authors: ["Okafor R"], year: 2024 }] },
  },
  stepStatus: {},
  createdAt: 0,
  updatedAt: 0,
};

describe("compileManuscript", () => {
  it("builds sections from captured data and drops empty steps", () => {
    const m = compileManuscript(config, project);
    expect(m.title).toBe("Mindfulness for exam anxiety");
    const headings = m.sections.map((s) => s.heading);
    expect(headings).toContain("Frame the question");
    expect(headings).not.toContain("Empty step"); // no data → omitted
  });

  it("renders inputs and resolves select labels", () => {
    const m = compileManuscript(config, project);
    const q = m.sections.find((s) => s.heading === "Frame the question")!;
    expect(q.paragraphs).toContain("University students");
    expect(q.paragraphs).toContain("Does mindfulness reduce exam anxiety?");
    expect(q.paragraphs.some((p) => p.includes("Standardised mean difference"))).toBe(true);
  });

  it("summarises tool output (search count)", () => {
    const m = compileManuscript(config, project);
    const s = m.sections.find((x) => x.heading === "Search")!;
    expect(s.paragraphs.some((p) => p.includes("1200 records"))).toBe(true);
  });

  it("pulls references from the search records", () => {
    const m = compileManuscript(config, project);
    expect(m.references).toHaveLength(1);
  });

  it("carries author front matter and a factual abstract", () => {
    const m = compileManuscript(config, project, { authors: ["Baig U", "Okafor R"], affiliation: "Uni", correspondence: "a@b.c" });
    expect(m.front.authors).toEqual(["Baig U", "Okafor R"]);
    expect(m.front.affiliation).toBe("Uni");
    expect(m.front.correspondence).toBe("a@b.c");
    expect(m.front.date).toBeTruthy();
    expect(m.abstract.some((p) => p.startsWith("Background:"))).toBe(true);
    expect(m.abstract.some((p) => p.startsWith("Methods:"))).toBe(true);
    expect(m.abstract.some((p) => p.includes("1200 records"))).toBe(true);
  });
});

describe("compileManuscript — risk of bias & synthesis", () => {
  const richConfig: StudyTypeConfig = {
    id: "systematic-review",
    label: "Systematic Review",
    family: "review",
    reportingStandard: "PRISMA-2020",
    steps: [
      { id: "question", title: "Frame the question", guide: { basic: [] }, inputs: [{ kind: "select", id: "measure", label: "Measure", options: [{ value: "SMD", label: "SMD" }] }], validations: [] },
      { id: "appraisal", title: "Risk-of-bias appraisal", tool: "appraisal", guide: { basic: [] }, inputs: [], validations: [] },
      { id: "synthesis", title: "Synthesis", tool: "synthesis", guide: { basic: [] }, inputs: [], validations: [] },
    ],
  };
  const richProject: Project = {
    id: "p2",
    title: "SGA lipids in youth",
    studyType: "systematic-review",
    stepData: {
      question: { measure: "SMD" },
      appraisal: {
        judgements: {
          a: { d1: "low", d2: "low", d3: "low", d4: "low", d5: "low" },
          b: { d1: "high", d2: "some-concern", d3: "low", d4: "low", d5: "low" },
        },
      },
      synthesis: {
        rows: [
          { id: "a", label: "Trial A", m1: "13", sd1: "4", n1: "30", m2: "17", sd2: "4.5", n2: "30" },
          { id: "b", label: "Trial B", m1: "15", sd1: "5", n1: "40", m2: "18", sd2: "5.2", n2: "40" },
        ],
      },
    },
    stepStatus: {},
    createdAt: 0,
    updatedAt: 0,
  };

  it("compiles a risk-of-bias narrative from the judgements (not skipped)", () => {
    const m = compileManuscript(richConfig, richProject);
    const rob = m.sections.find((s) => s.heading === "Risk-of-bias appraisal");
    expect(rob).toBeDefined();
    expect(rob!.paragraphs.some((p) => p.includes("five RoB 2 domains"))).toBe(true);
    // 2 studies: one low overall, one high overall.
    expect(rob!.paragraphs.some((p) => /1 study was judged at low risk/.test(p) && /1 (was|were) at high risk/.test(p))).toBe(true);
  });

  it("compiles synthesis methods, results, assumptions and statistical citations", () => {
    const m = compileManuscript(richConfig, richProject);
    const syn = m.sections.find((s) => s.heading === "Synthesis")!;
    expect(syn.paragraphs.some((p) => p.includes("random-effects model"))).toBe(true);
    expect(syn.paragraphs.some((p) => p.includes("Pooling 2 studies"))).toBe(true);
    expect(syn.paragraphs.some((p) => p.toLowerCase().includes("assumes independent studies"))).toBe(true);
    expect(m.methodsCitations.some((c) => c.includes("DerSimonian"))).toBe(true);
    expect(m.methodsCitations.some((c) => c.includes("Higgins"))).toBe(true);
  });
});

describe("exporters", () => {
  const m = compileManuscript(config, project);
  it("Markdown includes title, a section heading, and the integrity note", () => {
    const md = toMarkdown(m, ["Okafor, R. (2024)."]);
    expect(md).toContain("# Mindfulness for exam anxiety");
    expect(md).toContain("## Frame the question");
    expect(md).toContain("structured draft");
  });
  it("LaTeX escapes special characters and wraps a document", () => {
    const tex = toLaTeX({ ...m, title: "Cost & effect" }, []);
    expect(tex).toContain("\\documentclass[11pt]{article}");
    expect(tex).toContain("Cost \\& effect");
  });

  it("HTML export is journal-styled with a byline, abstract, and title page", () => {
    const withFront = compileManuscript(config, project, { authors: ["Baig U"], affiliation: "Uni" });
    const html = toHTML(withFront, ["Okafor, R. (2024)."]);
    expect(html).toContain("class=\"titlepage\"");
    expect(html).toContain("Baig U");
    expect(html).toContain("class=\"abstract\"");
    expect(html).toContain("@page");
    expect(html).toContain("<b>Background:</b>");
  });

  it("places each figure inside its step's section and orphans at the end", () => {
    const assets = [
      { stepId: "search", caption: "Flow diagram", svg: "<svg id=\"flow\"></svg>" },
      { stepId: "ghost", caption: "Orphan chart", svg: "<svg id=\"orphan\"></svg>" },
    ];
    const html = toHTML(m, ["Ref"], assets);
    const searchIdx = html.indexOf("Search</h2>");
    const flowIdx = html.indexOf("Flow diagram");
    const refsIdx = html.indexOf("References</h2>");
    // The search figure sits within the Search section, before References.
    expect(searchIdx).toBeGreaterThan(-1);
    expect(searchIdx).toBeLessThan(flowIdx);
    expect(flowIdx).toBeLessThan(refsIdx);
    // Sequential numbering across sections then leftovers.
    expect(html).toContain("<b>Figure 1.</b> Flow diagram");
    expect(html).toContain("<b>Figure 2.</b> Orphan chart");
    // The orphan (no matching section) falls into the trailing figures block.
    expect(html).toContain("Figures &amp; tables");
  });
});
