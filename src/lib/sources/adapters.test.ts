import { describe, expect, it } from "vitest";
import { epmcQuery, normalizeEuropePmc } from "./europepmc";
import { crossrefFilter, normalizeCrossref } from "./crossref";
import { normalizeOpenAlex, normalizeVolume, openAlexFilter, reconstructAbstract } from "./openalex";
import { normalizePubmed, pubmedDates, pubmedTerm } from "./pubmed";
import { ctgFilter, ctgTerm, normalizeClinicalTrials } from "./clinicaltrials";
import { MAX_RESULTS_CAP, wantedResults } from "./types";

describe("Europe PMC normalize", () => {
  it("maps core fields and splits the author string", () => {
    const r = normalizeEuropePmc({
      hitCount: 42,
      resultList: {
        result: [
          {
            id: "39000001",
            source: "MED",
            title: "Mindfulness and exam anxiety.",
            authorString: "Okafor R, Lindqvist M.",
            pubYear: "2024",
            journalTitle: "J College Mental Health",
            doi: "10.1/abc",
            abstractText: "An RCT.",
            fullTextUrlList: { fullTextUrl: [{ url: "http://oa/html", documentStyle: "html" }] },
          },
        ],
      },
    });
    expect(r.total).toBe(42);
    expect(r.records[0]).toMatchObject({
      id: "europepmc:MED/39000001",
      source: "europepmc",
      title: "Mindfulness and exam anxiety",
      authors: ["Okafor R", "Lindqvist M"],
      year: 2024,
      doi: "10.1/abc",
      oaUrl: "http://oa/html",
    });
  });
});

describe("Crossref normalize", () => {
  it("composes author names and strips JATS from the abstract", () => {
    const r = normalizeCrossref({
      message: {
        "total-results": 7,
        items: [
          {
            DOI: "10.2/xyz",
            title: ["A trial of mindfulness"],
            author: [{ given: "Rae", family: "Okafor" }, { name: "M Lindqvist" }],
            "container-title": ["Anxiety Research"],
            issued: { "date-parts": [[2025, 3]] },
            abstract: "<jats:p>Background.</jats:p>",
          },
        ],
      },
    });
    expect(r.total).toBe(7);
    expect(r.records[0].authors).toEqual(["Rae Okafor", "M Lindqvist"]);
    expect(r.records[0].year).toBe(2025);
    expect(r.records[0].abstract).toBe("Background.");
  });
});

describe("OpenAlex normalize", () => {
  it("reconstructs the inverted-index abstract in order", () => {
    expect(reconstructAbstract({ Mindfulness: [0], reduces: [1], anxiety: [2] })).toBe(
      "Mindfulness reduces anxiety",
    );
  });

  it("maps fields and strips the DOI prefix", () => {
    const r = normalizeOpenAlex({
      meta: { count: 3 },
      results: [
        {
          id: "https://openalex.org/W123",
          doi: "https://doi.org/10.3/qrs",
          title: "Group mindfulness training",
          publication_year: 2024,
          authorships: [{ author: { display_name: "F Bauer" } }],
          primary_location: { source: { display_name: "Higher Ed Wellbeing" } },
          open_access: { oa_url: "http://oa/pdf" },
          abstract_inverted_index: { Trial: [0], results: [1] },
        },
      ],
    });
    expect(r.records[0]).toMatchObject({
      id: "openalex:W123",
      doi: "10.3/qrs",
      journal: "Higher Ed Wellbeing",
      oaUrl: "http://oa/pdf",
      abstract: "Trial results",
    });
  });

  it("normalizes a group_by=publication_year volume response: sorted, filtered, totalled", () => {
    const v = normalizeVolume({
      meta: { count: 142 },
      group_by: [
        { key: "2024", count: 50 },
        { key: "2022", count: 30 },
        { key: "unknown", count: 9 }, // dropped — not a year
        { key: "2023", count: 62 },
      ],
    });
    expect(v.total).toBe(142);
    expect(v.byYear).toEqual([
      { year: 2022, count: 30 },
      { year: 2023, count: 62 },
      { year: 2024, count: 50 },
    ]);
  });

  it("falls back to summing counts when meta.count is absent", () => {
    const v = normalizeVolume({ group_by: [{ key: "2024", count: 4 }, { key: "2023", count: 6 }] });
    expect(v.total).toBe(10);
  });
});

describe("search filter builders", () => {
  it("wantedResults falls back and honours the safety cap", () => {
    expect(wantedResults({})).toBe(25);
    expect(wantedResults({ pageSize: 50 })).toBe(50);
    expect(wantedResults({ maxResults: 250, pageSize: 50 })).toBe(250);
    expect(wantedResults({ maxResults: 99999 })).toBe(MAX_RESULTS_CAP);
  });

  it("Europe PMC folds year range, OA, and type into its query syntax", () => {
    expect(epmcQuery("mindfulness anxiety", {})).toBe("mindfulness anxiety");
    expect(
      epmcQuery("mindfulness anxiety", { yearFrom: 2015, yearTo: 2024, openAccessOnly: true, articleType: "rct" }),
    ).toBe(
      '(mindfulness anxiety) AND (PUB_YEAR:[2015 TO 2024]) AND (OPEN_ACCESS:y) AND (PUB_TYPE:"randomized controlled trial")',
    );
    expect(epmcQuery("x", { articleType: "review" })).toContain('PUB_TYPE:"review"');
  });

  it("Crossref filter covers dates only", () => {
    expect(crossrefFilter({})).toBe("");
    expect(crossrefFilter({ yearFrom: 2018 })).toBe("&filter=from-pub-date:2018-01-01");
    expect(crossrefFilter({ yearFrom: 2018, yearTo: 2022 })).toBe(
      "&filter=from-pub-date:2018-01-01,until-pub-date:2022-12-31",
    );
  });

  it("OpenAlex filter maps dates, OA, and review type", () => {
    expect(openAlexFilter({})).toBe("");
    expect(openAlexFilter({ yearFrom: 2020, yearTo: 2024, openAccessOnly: true, articleType: "review" })).toBe(
      "&filter=from_publication_date:2020-01-01,to_publication_date:2024-12-31,is_oa:true,type:review",
    );
    // RCT has no OpenAlex facet — nothing is silently applied.
    expect(openAlexFilter({ articleType: "rct" })).toBe("");
  });

  it("PubMed term + date builders use [pt]/[sb] tags and datetype=pdat", () => {
    expect(pubmedTerm("mindfulness", {})).toBe("mindfulness");
    expect(pubmedTerm("mindfulness", { articleType: "rct", openAccessOnly: true })).toBe(
      "(mindfulness) AND randomized controlled trial[pt] AND free full text[sb]",
    );
    expect(pubmedDates({})).toBe("");
    expect(pubmedDates({ yearFrom: 2015, yearTo: 2024 })).toBe("&datetype=pdat&mindate=2015&maxdate=2024");
  });
});

describe("ClinicalTrials.gov", () => {
  it("filter maps year range to StartDate and rct to INTERVENTIONAL; notes the rest", () => {
    expect(ctgFilter({})).toEqual({ advanced: undefined, note: undefined });
    expect(ctgFilter({ yearFrom: 2015, yearTo: 2024, articleType: "rct" }).advanced).toBe(
      "AREA[StartDate]RANGE[2015-01-01,2024-12-31] AND AREA[StudyType]INTERVENTIONAL",
    );
    expect(ctgFilter({ yearFrom: 2015 }).advanced).toBe("AREA[StartDate]RANGE[2015-01-01,MAX]");
    expect(ctgFilter({ articleType: "review" }).note).toMatch(/review/i);
    expect(ctgFilter({ openAccessOnly: true }).note).toMatch(/freely accessible/i);
  });

  it("ctgTerm strips Essie-breaking chars, drops noise words, and caps length", () => {
    // Brackets/quotes removed (they 400 the registry parser).
    expect(ctgTerm('therapy [adults] "resistant')).toBe("therapy adults resistant");
    // Long PICO phrase → salient keywords only (avoids "Too complicated query").
    const long = "second-generation antipsychotics for adolescents with bipolar disorder versus placebo change in triglycerides over 12 weeks in randomized controlled trials";
    const out = ctgTerm(long);
    expect(out.split(" ").length).toBeLessThanOrEqual(10);
    expect(out).toContain("antipsychotics");
    expect(out).not.toMatch(/\bfor\b|\bwith\b|\bversus\b/);
    // Never ends on a dangling boolean operator.
    expect(ctgTerm("clozapine schizophrenia AND")).toBe("clozapine schizophrenia");
  });

  it("normalize maps registry studies to records (NCT id, sponsor, start year)", () => {
    const r = normalizeClinicalTrials({
      totalCount: 7,
      studies: [
        {
          protocolSection: {
            identificationModule: {
              nctId: "NCT01234567",
              briefTitle: "Brief title",
              officialTitle: "Official long title of the trial",
            },
            statusModule: { startDateStruct: { date: "2019-05" } },
            descriptionModule: { briefSummary: "A summary." },
            sponsorCollaboratorsModule: { leadSponsor: { name: "University Hospital" } },
          },
        },
      ],
    });
    expect(r.total).toBe(7);
    expect(r.records[0]).toMatchObject({
      id: "clinicaltrials:NCT01234567",
      source: "clinicaltrials",
      title: "Official long title of the trial",
      authors: ["University Hospital"],
      year: 2019,
      journal: "ClinicalTrials.gov",
      abstract: "A summary.",
      url: "https://clinicaltrials.gov/study/NCT01234567",
    });
  });
});

describe("PubMed normalize", () => {
  it("reads esummary docs in uid order and extracts DOI + year", () => {
    const r = normalizePubmed({
      result: {
        uids: ["40000001"],
        "40000001": {
          uid: "40000001",
          title: "MBCT for exam anxiety.",
          authors: [{ name: "Hassan I" }, { name: "Lund E" }],
          pubdate: "2025 Jan",
          source: "Behav Res Ther",
          articleids: [{ idtype: "doi", value: "10.4/mbct" }],
        },
      },
    });
    expect(r.records[0]).toMatchObject({
      id: "pubmed:40000001",
      authors: ["Hassan I", "Lund E"],
      year: 2025,
      journal: "Behav Res Ther",
      doi: "10.4/mbct",
    });
  });
});
