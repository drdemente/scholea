import { describe, expect, it } from "vitest";
import { parseAiJudgements } from "./AppraisalTool";

/**
 * These lock in the fix for the "0 studies appraised (but tokens consumed)" bug:
 * the LLM reply is often fenced, truncated by the token limit, or uses varied
 * key/value phrasings, and the parser must still recover every complete study.
 */
describe("parseAiJudgements", () => {
  it("parses a clean JSON array", () => {
    const out = parseAiJudgements(
      '[{"id":1,"d1":"low","d2":"some-concern","d3":"high","d4":"low","d5":"low","rationale":"ok"}]',
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(1);
    expect(out[0].levels).toEqual({ d1: "low", d2: "some-concern", d3: "high", d4: "low", d5: "low" });
    expect(out[0].rationale).toBe("ok");
  });

  it("strips markdown code fences", () => {
    const out = parseAiJudgements('```json\n[{"id":1,"d1":"low","d2":"low","d3":"low","d4":"low","d5":"low"}]\n```');
    expect(out).toHaveLength(1);
    expect(out[0].levels.d1).toBe("low");
  });

  it("salvages a TRUNCATED array (the real 0-studies cause)", () => {
    // Two complete objects, then a third cut off mid-way by max_tokens.
    const truncated =
      '[{"id":1,"d1":"low","d2":"low","d3":"low","d4":"low","d5":"low"},' +
      '{"id":2,"d1":"high","d2":"some-concern","d3":"low","d4":"low","d5":"low"},' +
      '{"id":3,"d1":"low","d2":"some-conc';
    const out = parseAiJudgements(truncated);
    expect(out).toHaveLength(2);
    expect(out[1].id).toBe(2);
    expect(out[1].levels.d1).toBe("high");
  });

  it("normalises varied level phrasings", () => {
    const out = parseAiJudgements(
      '[{"id":1,"d1":"Low risk","d2":"Some concerns","d3":"High risk","d4":"unclear","d5":"Not reported"}]',
    );
    expect(out[0].levels).toEqual({
      d1: "low",
      d2: "some-concern",
      d3: "high",
      d4: "some-concern",
      d5: "some-concern",
    });
  });

  it("reads domain names, per-domain {judgement, reason}, and string labels", () => {
    const out = parseAiJudgements(
      JSON.stringify([
        {
          study: "Smith 2020",
          "randomisation process": { judgement: "low", reason: "computer-generated" },
          "missing outcome data": "high",
        },
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("Smith 2020");
    expect(out[0].levels.d1).toBe("low");
    expect(out[0].levels.d3).toBe("high");
    expect(out[0].rationale).toContain("computer-generated");
  });

  it("returns nothing for non-JSON prose", () => {
    expect(parseAiJudgements("I cannot assess these studies without more info.")).toEqual([]);
  });
});
