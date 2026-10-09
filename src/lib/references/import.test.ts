import { describe, expect, it } from "vitest";
import { parseRis } from "./import";

const RIS = `TY  - JOUR
TI  - Aripiprazole in pediatric bipolar disorder: a randomized trial
AU  - Findling, R. L.
AU  - Youngstrom, E. A.
PY  - 2009
JO  - Journal of Clinical Psychiatry
DO  - 10.4088/JCP.09m05009yel
AB  - A double-blind placebo-controlled study of
  aripiprazole in youths.
ER  -

TY  - CONF
T1  - Metabolic outcomes of SGAs in adolescents.
A1  - Correll, C. U.
Y1  - 2018/10//
T2  - AACAP Annual Meeting
ER  -
`;

describe("parseRis", () => {
  it("parses multiple entries with tag synonyms (TI/T1, AU/A1, PY/Y1, JO/T2)", () => {
    const out = parseRis(RIS, "embase");
    expect(out).toHaveLength(2);
    expect(out[0].title).toMatch(/^Aripiprazole/);
    expect(out[0].authors).toEqual(["Findling, R. L.", "Youngstrom, E. A."]);
    expect(out[0].year).toBe(2009);
    expect(out[0].journal).toBe("Journal of Clinical Psychiatry");
    expect(out[0].doi).toBe("10.4088/JCP.09m05009yel");
    expect(out[0].id).toBe("embase:10.4088/JCP.09m05009yel");
    expect(out[0].source).toBe("embase");
    expect(out[1].title).toBe("Metabolic outcomes of SGAs in adolescents");
    expect(out[1].year).toBe(2018);
    expect(out[1].journal).toBe("AACAP Annual Meeting");
  });

  it("joins un-tagged continuation lines into the previous value", () => {
    const out = parseRis(RIS, "conference");
    expect(out[0].abstract).toBe("A double-blind placebo-controlled study of aripiprazole in youths.");
  });

  it("is stable across re-imports (content-derived ids) and drops title-less entries", () => {
    const a = parseRis(RIS, "cochrane-central");
    const b = parseRis(RIS, "cochrane-central");
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
    expect(parseRis("TY  - JOUR\nAU  - Nobody\nER  -", "other")).toEqual([]);
  });

  it("handles CRLF endings and a missing final ER", () => {
    const out = parseRis("TY  - JOUR\r\nTI  - Windows export\r\nPY  - 2021\r\n", "who-ictrp");
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Windows export");
    expect(out[0].year).toBe(2021);
    expect(out[0].source).toBe("who-ictrp");
  });
});
