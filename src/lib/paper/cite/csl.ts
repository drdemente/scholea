/**
 * CSL / citeproc-js upgrade path: thousands of citation styles. Consistent with
 * Scholea's other heavy optional layers, citeproc and the CSL style/locale XML
 * are fetched on demand from CDNs rather than bundled. The built-in focused
 * formatter (citations.ts) stays the default and the offline guarantee.
 * `toCslJson` is pure and unit-tested.
 *
 * The three addresses are constants further down and there is no setting for
 * them. To load citeproc or the styles from somewhere else, change them and
 * rebuild (docs/deployment.md, section 1).
 */
import { parseAuthor } from "@/lib/paper/citations";
import type { WorkRecord } from "@/lib/sources/types";

export interface CslItem {
  id: string;
  type: string;
  title: string;
  author: { family: string; given: string }[];
  issued?: { "date-parts": number[][] };
  "container-title"?: string;
  DOI?: string;
  URL?: string;
}

/** Convert a Scholea record to a CSL-JSON item (the citeproc input format). */
export function toCslJson(r: WorkRecord, index = 1): CslItem {
  const item: CslItem = {
    id: r.id || `item-${index}`,
    type: "article-journal",
    title: r.title,
    author: (r.authors ?? []).map((a) => {
      const { family, initials } = parseAuthor(a);
      return { family, given: initials };
    }),
  };
  if (r.year) item.issued = { "date-parts": [[r.year]] };
  if (r.journal) item["container-title"] = r.journal;
  if (r.doi) item.DOI = r.doi;
  if (r.url) item.URL = r.url;
  return item;
}

/** Popular CSL style ids (resolved against the official CSL styles repo). */
export const CSL_STYLES: { id: string; label: string }[] = [
  { id: "apa", label: "APA 7 (CSL)" },
  { id: "vancouver", label: "Vancouver (CSL)" },
  { id: "harvard-cite-them-right", label: "Harvard (CSL)" },
  { id: "chicago-author-date", label: "Chicago author-date" },
  { id: "ieee", label: "IEEE" },
  { id: "nature", label: "Nature" },
  { id: "modern-language-association", label: "MLA" },
];

const CITEPROC_URL = "https://esm.sh/citeproc@2.4.63";
const STYLE_URL = (id: string) => `https://cdn.jsdelivr.net/gh/citation-style-language/styles@master/${id}.csl`;
const LOCALE_URL = "https://cdn.jsdelivr.net/gh/citation-style-language/locales@master/locales-en-US.xml";

interface CiteprocEngine {
  updateItems: (ids: string[]) => void;
  makeBibliography: () => [unknown, string[]];
}
interface CiteprocModule {
  Engine: new (sys: unknown, style: string) => CiteprocEngine;
}

let localeCache: string | null = null;

/**
 * Format a reference list with citeproc-js + a chosen CSL style. Returns plain
 * text (HTML stripped). Requires network for the first load of each style/locale.
 * Throws on failure so callers can fall back to the built-in formatter.
 */
export async function formatWithCsl(records: WorkRecord[], styleId: string): Promise<string[]> {
  const [mod, styleXml, localeXml] = await Promise.all([
    import(/* @vite-ignore */ CITEPROC_URL) as Promise<CiteprocModule>,
    fetch(STYLE_URL(styleId)).then((r) => {
      if (!r.ok) throw new Error(`style ${styleId} not found`);
      return r.text();
    }),
    localeCache ? Promise.resolve(localeCache) : fetch(LOCALE_URL).then((r) => r.text()),
  ]);
  localeCache = localeXml;

  const items = records.map((r, i) => toCslJson(r, i + 1));
  const byId = new Map(items.map((it) => [it.id, it]));
  const sys = {
    retrieveLocale: () => localeXml,
    retrieveItem: (id: string) => byId.get(id),
  };
  const engine = new mod.Engine(sys, styleXml);
  engine.updateItems(items.map((it) => it.id));
  const [, entries] = engine.makeBibliography();
  return entries.map((html) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
}
