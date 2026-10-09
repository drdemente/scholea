/**
 * Study-evidence enrichment for the AI risk-of-bias appraisal. Given a record's
 * DOI, fetch the best available detail — a fuller abstract (OpenAlex → Crossref)
 * and, when the paper is open access, a plain-text excerpt of the full text
 * (Europe PMC), so the model judges bias from methods, not just the title.
 *
 * Requests go through the platform HTTP adapter, so on the desktop app they are
 * made natively and bypass browser CORS; on the web build these endpoints
 * (OpenAlex, Crossref, Europe PMC) all send permissive CORS headers. Every fetch
 * is best-effort — a failure never blocks the appraisal.
 */
import { platform } from "@/lib/platform";
import { reconstructAbstract } from "@/lib/sources/openalex";
import type { WorkRecord } from "@/lib/sources/types";

export interface StudyEvidence {
  /** Best abstract available (the record's, or one fetched by DOI). */
  abstract?: string;
  /** A methods-focused plain-text excerpt of the open-access full text. */
  fullText?: string;
  /** Where the extra detail came from, for transparency in the summary. */
  sources: string[];
}

/** A decent abstract is long enough to signal study methods. */
const GOOD_ABSTRACT = 250;

function cleanDoi(doi?: string): string | undefined {
  const d = doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
  return d || undefined;
}

/** Resolve a fetch with a timeout so a slow endpoint can't hang the appraisal. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((res) => setTimeout(() => res(null), ms))]);
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  return withTimeout(
    (async () => {
      try {
        const res = await platform.http(url, { method: "GET", headers: { Accept: "application/json" }, signal });
        return res.ok ? await res.json<T>() : null;
      } catch {
        return null;
      }
    })(),
    8000,
  );
}

async function getText(url: string, signal?: AbortSignal): Promise<string | null> {
  return withTimeout(
    (async () => {
      try {
        const res = await platform.http(url, { method: "GET", signal });
        return res.ok ? await res.text() : null;
      } catch {
        return null;
      }
    })(),
    10000,
  );
}

/** Strip JATS/HTML tags (Crossref abstracts are JATS XML) to plain text. */
export function stripMarkup(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .replace(/^\s*abstract[:.]?\s*/i, "")
    .trim();
}

/**
 * Extract a methods-focused plain-text excerpt from a JATS full-text document.
 * Prefers sections about methods/randomisation/blinding/outcomes/analysis (the
 * text that actually informs risk-of-bias), else falls back to the whole body.
 */
export function extractFullText(xml: string, limit = 3000): string | undefined {
  try {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.querySelector("parsererror")) return undefined;
    const body = doc.querySelector("body");
    if (!body) return undefined;
    const secs = Array.from(body.querySelectorAll("sec"));
    const relevant = secs.filter((s) =>
      /method|randomi|blind|allocation|conceal|outcome|attrition|missing|statistic|analysis|protocol/i.test(
        s.querySelector("title")?.textContent ?? "",
      ),
    );
    const src = relevant.length ? relevant : [body];
    const text = src.map((s) => s.textContent ?? "").join("\n").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, limit) : undefined;
  } catch {
    return undefined;
  }
}

async function openAlexAbstract(doi: string, signal?: AbortSignal): Promise<string | undefined> {
  const json = await getJson<{ abstract_inverted_index?: Record<string, number[]> }>(
    `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`,
    signal,
  );
  return json ? reconstructAbstract(json.abstract_inverted_index) : undefined;
}

async function crossrefAbstract(doi: string, signal?: AbortSignal): Promise<string | undefined> {
  const json = await getJson<{ message?: { abstract?: string } }>(
    `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
    signal,
  );
  const raw = json?.message?.abstract;
  return raw ? stripMarkup(raw) : undefined;
}

interface EpmcCore {
  resultList?: { result?: { id?: string; source?: string; pmcid?: string; isOpenAccess?: string; abstractText?: string }[] };
}

/** Europe PMC by DOI → abstract, plus an OA full-text excerpt when requested. */
async function europePmcDetail(
  doi: string,
  signal?: AbortSignal,
  wantFullText = true,
): Promise<{ abstract?: string; fullText?: string }> {
  const json = await getJson<EpmcCore>(
    `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(`DOI:"${doi}"`)}&format=json&resultType=core&pageSize=1`,
    signal,
  );
  const r = json?.resultList?.result?.[0];
  if (!r) return {};
  const abstract = r.abstractText ? stripMarkup(r.abstractText) : undefined;
  // Full-text XML is keyed by the bare PMCID (`/rest/{pmcid}/fullTextXML`). Only
  // open-access PMC articles expose it; many still 404 (best-effort).
  if (!wantFullText || r.isOpenAccess !== "Y" || !r.pmcid) return { abstract };
  const xml = await getText(
    `https://www.ebi.ac.uk/europepmc/webservices/rest/${r.pmcid}/fullTextXML`,
    signal,
  );
  return { abstract, fullText: xml ? extractFullText(xml) : undefined };
}

export interface EnrichOptions {
  signal?: AbortSignal;
  /** Fetch the open-access full-text excerpt too (default true). */
  fullText?: boolean;
}

/**
 * Best-effort evidence for one study: keep the record's abstract when it's
 * already substantial; otherwise chase a fuller one by DOI, and pull an
 * open-access full-text excerpt when available.
 */
export async function enrichStudy(record: WorkRecord, opts: EnrichOptions = {}): Promise<StudyEvidence> {
  const { signal, fullText: wantFullText = true } = opts;
  const sources: string[] = [];
  let abstract = (record.abstract ?? "").trim() || undefined;
  if (abstract && abstract.length >= GOOD_ABSTRACT) sources.push("abstract");
  const doi = cleanDoi(record.doi);
  if (!doi) return { abstract, sources };

  const consider = (candidate: string | undefined, label: string) => {
    if (candidate && candidate.length > (abstract?.length ?? 0)) {
      abstract = candidate;
      sources.push(label);
    }
  };

  // Europe PMC first: authoritative biomedical abstract + open-access full text.
  const epmc = await europePmcDetail(doi, signal, wantFullText);
  consider(epmc.abstract, "Europe PMC abstract");
  let fullText: string | undefined;
  if (epmc.fullText) {
    fullText = epmc.fullText;
    sources.push("open-access full text");
    if (!abstract) abstract = epmc.fullText.slice(0, 1000);
  }

  // Fall back to publisher/Crossref then OpenAlex only if still thin (Crossref is
  // publisher-sourced; OpenAlex abstracts are last as their quality varies most).
  if (!abstract || abstract.length < GOOD_ABSTRACT) {
    consider(await crossrefAbstract(doi, signal), "Crossref abstract");
  }
  if (!abstract || abstract.length < GOOD_ABSTRACT) {
    consider(await openAlexAbstract(doi, signal), "OpenAlex abstract");
  }

  return { abstract, fullText, sources: Array.from(new Set(sources)) };
}

/**
 * Enrich many studies with a small concurrency cap (polite to the free APIs),
 * reporting progress. Returns a map keyed by record id.
 */
export async function enrichStudies(
  records: WorkRecord[],
  onProgress?: (done: number, total: number) => void,
  opts: EnrichOptions = {},
): Promise<Map<string, StudyEvidence>> {
  const out = new Map<string, StudyEvidence>();
  const queue = [...records];
  let done = 0;
  const worker = async () => {
    for (;;) {
      const r = queue.shift();
      if (!r) return;
      out.set(r.id, await enrichStudy(r, opts));
      onProgress?.(++done, records.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, records.length) }, worker));
  return out;
}
