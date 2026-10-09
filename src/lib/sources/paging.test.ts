import { afterEach, describe, expect, it, vi } from "vitest";
import { clinicalTrialsSource, ctgRunningTotal } from "./clinicaltrials";
import { collectOpenAlex, openAlexPages, openAlexSource, type OpenAlexPage } from "./openalex";
import { SourceError, wantedResults } from "./types";
import type { SearchResult, WorkRecord } from "./types";

/** How many times each record index is fetched by a page-number plan. */
function coverage(plan: OpenAlexPage[]): Map<number, number> {
  const seen = new Map<number, number>();
  for (const { page, perPage } of plan) {
    for (let i = (page - 1) * perPage; i < page * perPage; i++) seen.set(i, (seen.get(i) ?? 0) + 1);
  }
  return seen;
}

/** True when the plan fetches each of the first `want` records exactly once and nothing twice. */
function coversOnce(plan: OpenAlexPage[], want: number): boolean {
  const seen = coverage(plan);
  for (let i = 0; i < want; i++) if (seen.get(i) !== 1) return false;
  return [...seen.values()].every((n) => n === 1);
}

/**
 * A stand-in for the OpenAlex works endpoint holding `available` records. It
 * numbers pages the way the real API does: page N of size S starts at record
 * (N - 1) * S, whatever sizes earlier requests used. `reported` is the count it
 * claims, which can differ from what it holds.
 */
function fakeOpenAlex(available: number, reported = available) {
  const calls: OpenAlexPage[] = [];
  const fetchPage = async (request: OpenAlexPage): Promise<SearchResult> => {
    calls.push(request);
    const start = (request.page - 1) * request.perPage;
    const end = Math.min(available, start + request.perPage);
    const records: WorkRecord[] = [];
    for (let i = start; i < end; i++) records.push({ id: `openalex:W${i}`, source: "openalex", title: `Work ${i}`, authors: [] });
    return { source: "openalex", total: reported, records };
  };
  return { calls, fetchPage };
}

const indexes = (records: WorkRecord[]) => records.map((r) => Number(r.id.replace(/^\w+:(W|NCT)/, "")));
const upTo = (n: number) => Array.from({ length: n }, (_, i) => i);

// 25, 50, 100, 250 and 500 are the choices in the search tool; 1000 is "All".
const TOTALS = [1, 25, 50, 99, 100, 101, 150, 200, 250, 500, 999, 1000];

describe("OpenAlex page plan", () => {
  it("the coverage check itself catches the old plan for 250 (a smaller last page re-reads 101-150 and skips 201-250)", () => {
    const old: OpenAlexPage[] = [
      { page: 1, perPage: 100 },
      { page: 2, perPage: 100 },
      { page: 3, perPage: 50 },
    ];
    const seen = coverage(old);
    expect(coversOnce(old, 250)).toBe(false);
    expect(seen.get(100)).toBe(2);
    expect(seen.get(149)).toBe(2);
    expect(seen.get(200)).toBeUndefined();
    expect(seen.get(249)).toBeUndefined();
  });

  it("for every size from 1 to 1000: one page size, consecutive pages, each record once, fewest requests", () => {
    for (let want = 1; want <= 1000; want++) {
      const plan = openAlexPages(want);
      const perPage = plan[0].perPage;
      const label = `want ${want}`;
      expect(plan.length, label).toBe(Math.ceil(want / 100));
      expect(plan.map((p) => p.page), label).toEqual(upTo(plan.length).map((i) => i + 1));
      expect(plan.every((p) => p.perPage === perPage), label).toBe(true);
      expect(perPage, label).toBe(Math.min(want, 100));
      expect(coversOnce(plan, want), label).toBe(true);
      // A single page asks for exactly what is wanted; several pages overshoot by less than one page.
      expect(plan.length * perPage - want, label).toBeLessThan(plan.length === 1 ? 1 : 100);
    }
  });

  it("plans the sizes the search tool offers", () => {
    expect(openAlexPages(25)).toEqual([{ page: 1, perPage: 25 }]);
    expect(openAlexPages(100)).toEqual([{ page: 1, perPage: 100 }]);
    expect(openAlexPages(250)).toEqual([
      { page: 1, perPage: 100 },
      { page: 2, perPage: 100 },
      { page: 3, perPage: 100 },
    ]);
    expect(openAlexPages(1000)).toHaveLength(10);
  });

  it("plans one record for anything that is not a usable size", () => {
    for (const odd of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(openAlexPages(odd)).toEqual([{ page: 1, perPage: 1 }]);
    }
    expect(openAlexPages(2.7)).toEqual([{ page: 1, perPage: 2 }]);
  });
});

describe("OpenAlex collection", () => {
  it.each(TOTALS)("returns records 1 to %i in order with no repeats when the source has plenty", async (want) => {
    const api = fakeOpenAlex(10_000);
    const { records, total } = await collectOpenAlex(want, api.fetchPage);
    expect(indexes(records)).toEqual(upTo(want));
    expect(total).toBe(10_000);
    expect(api.calls.length).toBe(Math.ceil(want / 100));
  });

  it("returns exactly records 201-250 at the end of a 250 request", async () => {
    const api = fakeOpenAlex(10_000);
    const { records } = await collectOpenAlex(250, api.fetchPage);
    expect(records).toHaveLength(250);
    expect(indexes(records).slice(200)).toEqual(upTo(250).slice(200));
    expect(new Set(records.map((r) => r.id)).size).toBe(250);
  });

  it("stops when the source runs out, without repeats or an extra request", async () => {
    const api = fakeOpenAlex(180);
    const { records, total } = await collectOpenAlex(250, api.fetchPage);
    expect(indexes(records)).toEqual(upTo(180));
    expect(total).toBe(180);
    expect(api.calls.length).toBe(2);
  });

  it("stops after one request when the source ends exactly on the first page boundary", async () => {
    const api = fakeOpenAlex(100);
    const { records } = await collectOpenAlex(500, api.fetchPage);
    expect(indexes(records)).toEqual(upTo(100));
    expect(api.calls).toEqual([{ page: 1, perPage: 100 }]);
  });

  it("stops after two requests when the source ends exactly on the second page boundary", async () => {
    const api = fakeOpenAlex(200);
    const { records } = await collectOpenAlex(500, api.fetchPage);
    expect(indexes(records)).toEqual(upTo(200));
    expect(api.calls.length).toBe(2);
  });

  it("stops at the first short page when the reported total overstates the source", async () => {
    const api = fakeOpenAlex(150, 10_000);
    const { records, total } = await collectOpenAlex(1000, api.fetchPage);
    expect(indexes(records)).toEqual(upTo(150));
    expect(total).toBe(10_000);
    expect(api.calls.length).toBe(2);
  });

  it("never reports a total lower than the records it returns", async () => {
    const api = fakeOpenAlex(10_000, 50);
    const { records, total } = await collectOpenAlex(250, api.fetchPage);
    expect(records).toHaveLength(100);
    expect(total).toBe(100);
  });

  it("makes one request and returns nothing when there are no results", async () => {
    const api = fakeOpenAlex(0);
    const { records, total } = await collectOpenAlex(250, api.fetchPage);
    expect(records).toEqual([]);
    expect(total).toBe(0);
    expect(api.calls.length).toBe(1);
  });

  it("trims to the requested number when the last page overshoots", async () => {
    const api = fakeOpenAlex(10_000);
    const { records } = await collectOpenAlex(101, api.fetchPage);
    expect(records).toHaveLength(101);
    expect(indexes(records)).toEqual(upTo(101));
  });

  it("passes a failed request through to the caller", async () => {
    const boom = new Error("HTTP 503");
    await expect(collectOpenAlex(250, async () => Promise.reject(boom))).rejects.toBe(boom);
  });
});

describe("ClinicalTrials.gov running total", () => {
  // The registry sends totalCount with the first page only (checked against the live API).
  it("keeps the first page's total across later pages that carry none", () => {
    let total = 0;
    let fetched = 0;
    for (const page of [{ totalCount: 5000, size: 100 }, { size: 100 }, { size: 50 }]) {
      fetched += page.size;
      total = ctgRunningTotal(total, page, fetched);
    }
    expect(total).toBe(5000);
  });

  it("takes the registry's latest word, higher or lower", () => {
    expect(ctgRunningTotal(5000, { totalCount: 5003 }, 200)).toBe(5003);
    expect(ctgRunningTotal(5000, { totalCount: 4990 }, 200)).toBe(4990);
    expect(ctgRunningTotal(5000, { totalCount: 0 }, 0)).toBe(0);
  });

  it("never reports fewer than were fetched", () => {
    expect(ctgRunningTotal(0, {}, 100)).toBe(100);
    expect(ctgRunningTotal(80, { totalCount: 80 }, 100)).toBe(100);
  });

  it("reports zero for an empty first page", () => {
    expect(ctgRunningTotal(0, { totalCount: 0 }, 0)).toBe(0);
    expect(ctgRunningTotal(0, {}, 0)).toBe(0);
  });
});

describe("requested result count", () => {
  it("falls back to the default when the limit is not a number, instead of fetching nothing", () => {
    expect(wantedResults({ maxResults: Number.NaN })).toBe(25);
    expect(wantedResults({ pageSize: Number.NaN }, 50)).toBe(50);
    expect(wantedResults({ maxResults: Number.POSITIVE_INFINITY })).toBe(1000);
    expect(wantedResults({ maxResults: -3 })).toBe(1);
  });
});

/*
 * The two adapters end to end, with the network replaced by a stand-in that
 * answers the REAL request URLs. These pin the wiring: the helpers above can be
 * right while search() asks for the wrong pages.
 */
describe("adapters against a stand-in API", () => {
  afterEach(() => vi.unstubAllGlobals());

  const ok = (body: unknown) => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => body });
  const failed = (status: number) => ({ status, ok: false, headers: { get: () => null }, text: async () => "{}", json: async () => ({}) });

  /** OpenAlex: page-number paging read from the URL the adapter really sends. */
  function openAlexApi(available: number, opts: { failOnRequest?: number } = {}) {
    const seen: { url: URL; signal: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { signal?: unknown }) => {
      const u = new URL(url);
      seen.push({ url: u, signal: init?.signal });
      if (opts.failOnRequest === seen.length) return failed(503);
      const perPage = Number(u.searchParams.get("per_page"));
      const page = Number(u.searchParams.get("page"));
      const start = (page - 1) * perPage;
      const results = [];
      for (let i = start; i < Math.min(available, start + perPage); i++) results.push({ id: `https://openalex.org/W${i}` });
      return ok({ meta: { count: available }, results });
    });
    return seen;
  }

  it("OpenAlex: 250 results are works 1-250 once each, from three pages of 100", async () => {
    const seen = openAlexApi(10_000);
    const out = await openAlexSource.search("shift work", { maxResults: 250 });
    expect(indexes(out.records)).toEqual(upTo(250));
    expect(out.total).toBe(10_000);
    expect(seen.map((s) => [s.url.searchParams.get("page"), s.url.searchParams.get("per_page")])).toEqual([
      ["1", "100"],
      ["2", "100"],
      ["3", "100"],
    ]);
  });

  it("OpenAlex: every page request carries the query, the filters, the key and the abort signal", async () => {
    const seen = openAlexApi(10_000);
    const controller = new AbortController();
    await openAlexSource.search("shift work", {
      maxResults: 250,
      yearFrom: 2020,
      openAccessOnly: true,
      apiKey: "test-key",
      signal: controller.signal,
    });
    expect(seen).toHaveLength(3);
    for (const s of seen) {
      expect(s.url.origin + s.url.pathname).toBe("https://api.openalex.org/works");
      expect(s.url.searchParams.get("search")).toBe("shift work");
      expect(s.url.searchParams.get("filter")).toBe("from_publication_date:2020-01-01,is_oa:true");
      expect(s.url.searchParams.get("api_key")).toBe("test-key");
      expect(s.signal).toBe(controller.signal);
    }
  });

  it("OpenAlex: a source with 180 results gives all 180 once, in two requests", async () => {
    const seen = openAlexApi(180);
    const out = await openAlexSource.search("rare topic", { maxResults: 250 });
    expect(indexes(out.records)).toEqual(upTo(180));
    expect(out.total).toBe(180);
    expect(seen).toHaveLength(2);
  });

  it("OpenAlex: a failure on a later page still becomes the guidance about a key", async () => {
    openAlexApi(10_000, { failOnRequest: 2 });
    const attempt = openAlexSource.search("shift work", { maxResults: 250 });
    await expect(attempt).rejects.toBeInstanceOf(SourceError);
    await expect(attempt).rejects.toThrow(/OpenAlex is limiting anonymous requests/);
  });

  /** ClinicalTrials.gov: token paging, with totalCount on the first page only or never. */
  function ctgApi(available: number, sendTotal: "first" | "never") {
    const sizes: number[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url);
      const size = Number(u.searchParams.get("pageSize"));
      const token = u.searchParams.get("pageToken");
      sizes.push(size);
      const start = token ? Number(token) : 0;
      const end = Math.min(available, start + size);
      const studies = [];
      for (let i = start; i < end; i++) studies.push({ protocolSection: { identificationModule: { nctId: `NCT${i}` } } });
      return ok({
        studies,
        ...(end < available ? { nextPageToken: String(end) } : {}),
        ...(sendTotal === "first" && !token ? { totalCount: available } : {}),
      });
    });
    return sizes;
  }

  it("ClinicalTrials.gov: reports the registry's total after three pages, not the size of the last page", async () => {
    const sizes = ctgApi(5000, "first");
    const out = await clinicalTrialsSource.search("aspirin", { maxResults: 250 });
    expect(indexes(out.records)).toEqual(upTo(250));
    expect(out.total).toBe(5000);
    expect(sizes).toEqual([100, 100, 50]);
  });

  it("ClinicalTrials.gov: falls back to the number fetched when no total is ever sent", async () => {
    ctgApi(5000, "never");
    const out = await clinicalTrialsSource.search("aspirin", { maxResults: 250 });
    expect(out.records).toHaveLength(250);
    expect(out.total).toBe(250);
  });

  it("ClinicalTrials.gov: a registry with 180 matches reports 180 of 180", async () => {
    ctgApi(180, "first");
    const out = await clinicalTrialsSource.search("aspirin", { maxResults: 250 });
    expect(indexes(out.records)).toEqual(upTo(180));
    expect(out.total).toBe(180);
  });
});
