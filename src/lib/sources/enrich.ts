/**
 * Enrichment sources (not full-text search): Unpaywall for legal open-access
 * resolution, DOAJ for journal vetting / predatory-journal heuristics. Both are
 * free, no-key (email param), and CORS-friendly.
 */
import { fetchJson, q } from "./http";

interface UnpaywallResponse {
  is_oa?: boolean;
  best_oa_location?: { url?: string; url_for_pdf?: string };
}

/** Resolve a DOI to a legal open-access URL, if one exists. */
export async function resolveOpenAccess(
  doi: string,
  email: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const clean = doi.replace(/^https?:\/\/doi\.org\//, "");
  const url = `https://api.unpaywall.org/v2/${q(clean)}?email=${q(email)}`;
  try {
    const json = await fetchJson<UnpaywallResponse>(url, "unpaywall", signal);
    if (!json.is_oa) return undefined;
    return json.best_oa_location?.url_for_pdf ?? json.best_oa_location?.url ?? undefined;
  } catch {
    return undefined; // enrichment is best-effort; never block the pipeline
  }
}

interface DoajResponse {
  total?: number;
  results?: { bibjson?: { title?: string } }[];
}

export interface JournalVetting {
  inDoaj: boolean;
  /** The matched DOAJ journal title, if any. */
  matchedTitle?: string;
}

/**
 * Check whether a journal is indexed in DOAJ — a positive signal it's a vetted
 * open-access journal. Absence is NOT proof of predation, only a prompt to look
 * closer, so we phrase it as a heuristic.
 */
export async function lookupJournalDoaj(
  title: string,
  signal?: AbortSignal,
): Promise<JournalVetting> {
  const url = `https://doaj.org/api/search/journals/${q(`bibjson.title:"${title}"`)}?pageSize=1`;
  try {
    const json = await fetchJson<DoajResponse>(url, "doaj", signal);
    const match = json.results?.[0]?.bibjson?.title;
    return { inDoaj: Boolean(match), matchedTitle: match };
  } catch {
    return { inDoaj: false };
  }
}
