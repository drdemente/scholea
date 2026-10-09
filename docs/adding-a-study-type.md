# Adding a study type (content-as-data)

A study type is a **config object**, not code. Authoring one is the main way to
extend Scholea: you never modify the engine. Each config is authored from that
design's own reporting guideline (PRISMA, STROBE, CONSORT, CARE, …).

The smallest existing config, [`case-report.ts`](../src/lib/study/configs/case-report.ts),
is the best template; `systematic-review.ts` is the most complete.

## The shape

```ts
// src/lib/study/types.ts
type StudyTypeConfig = {
  id: StudyTypeId;            // "case-report"
  label: string;             // "Case Report / Series"
  family: StudyFamily;       // review | observational | experimental | report | …
  reportingStandard: string; // "CARE"
  steps: StepConfig[];       // the ordered pathway
};

type StepConfig = {
  id: string;
  title: string;
  short?: string;            // compact label for the mobile stepper
  guide: GuideContent;       // level-gated: basic | medium | advanced
  glossary?: GlossaryEntry[];// just-in-time term definitions
  inputs: FieldSchema[];     // text | textarea | number | select | tags | checkbox
  validations: Check[];      // declarative "is everything alright?" checks
  tool?: ToolId;             // optional rich tool (search, screening, …)
  optionalAiAssist?: AiTask; // optional grounded AI draft (BYO key)
};
```

## Steps

1. **Add the id** to the `StudyTypeId` union in
   [`src/lib/db/schema.ts`](../src/lib/db/schema.ts).

2. **Author the config** in `src/lib/study/configs/<id>.ts`. Use the concise
   builders in [`authoring.ts`](../src/lib/study/authoring.ts) (guide/field/check
   helpers). Write the guidance at three levels (basic → advanced) and add
   automated validation checks that reference your input ids.

3. **Register it** in [`registry.ts`](../src/lib/study/registry.ts): import the
   config and add it to `STUDY_CONFIGS`. Make sure its `family` has a label in
   `FAMILY_LABEL` / `FAMILY_ORDER`.

That's the whole change. The study-type chooser, the pathway map, the step
runner, per-step discussion/review, the contribution ledger, and the paper
compiler all pick it up automatically, with no engine edits.

## Need a rich step? Two options

- **Reuse a tool.** Set `tool` on a step to any registered `ToolId` (e.g.
  `search`, `dedup`, `screening`, `appraisal`, `synthesis`, `prisma`, `consort`,
  `diagnostic`, `coding`, `reliability`, `feasibility`).
- **Add a new tool.** Create a component in
  [`src/components/runner/tools/`](../src/components/runner/tools/), add its id
  to `ToolId` in `types.ts`, and wire it in `tools/index.tsx`. Tools read/write
  the step's data through the project store, so the engine stays methodology-blind.

## Validation

[`registry.test.ts`](../src/lib/study/registry.test.ts) automatically checks
every config: unique ids, at least basic guidance per step, and that each
validation references a real input (or a tool-output field). Run `pnpm test`
after adding a type: a broken config fails the suite.

## Statistics & honesty

If your type needs a calculator, add a validated, reference-tested function under
[`src/lib/stats/`](../src/lib/stats/) and surface its method + citation in the
tool. Never hand-roll unverified statistics, and keep AI output labelled as a
draft to review.
