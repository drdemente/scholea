import { useRef, useState } from "react";
import { AlertTriangle, Check, ChevronRight, Database, FileUp, Loader2, Plus, Search, Settings, SlidersHorizontal } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { SourceChip } from "./SourceChip";
import { AbstractText } from "./AbstractText";
import { useProject } from "@/lib/study/project-store";
import { useSettings } from "@/lib/settings/settings-store";
import { useUI } from "@/lib/ui-store";
import { SOURCES, isSourceUsable, searchSources, type SourceOutcome } from "@/lib/sources/registry";
import { MANUAL_SOURCES, MAX_RESULTS_CAP, type ArticleTypeFilter, type ManualSourceId, type WorkRecord } from "@/lib/sources/types";
import { enrichStudy } from "@/lib/study/appraisal-enrich";
import { parseRis } from "@/lib/references/import";
import type { StepData } from "@/lib/study/types";

/** Build a starting query from the captured PICO. */
function defaultQuery(question: StepData): string {
  const parts = [question.intervention, question.population, question.outcome]
    .filter((v): v is string => typeof v === "string" && v.trim() !== "");
  if (parts.length) return parts.join(" ");
  return typeof question.question === "string" ? question.question : "";
}

const LIMIT_CHOICES = [25, 50, 100, 250, 500] as const;
const PREVIEW_MAX = 300;

const isManual = (source: WorkRecord["source"]): boolean => source in MANUAL_SOURCES;

/**
 * Real multi-source literature search with filters. Fetched results are shown
 * as candidates — the reviewer imports them into the review individually or all
 * at once (plus RIS file imports for databases with no public API, e.g. Embase
 * or Cochrane CENTRAL). Only IMPORTED records flow to deduplication/screening
 * and the PRISMA identified count. Every record is tagged with its source.
 */
export function SearchTool({ stepId }: { stepId: string }) {
  const project = useProject((s) => s.project);
  const setField = useProject((s) => s.setField);
  const persist = useProject((s) => s.persist);
  const settings = useSettings();
  const openSettings = useUI((s) => s.openSettings);
  const fileRef = useRef<HTMLInputElement>(null);

  const data = (project?.stepData[stepId] as StepData) ?? {};
  const questionData = (project?.stepData["question"] as StepData) ?? {};
  const imported = (data.records as WorkRecord[]) ?? [];
  // Back-compat: projects saved before the import flow have records but no
  // fetched list — treat what's there as both fetched and imported.
  const fetched = (data.fetched as WorkRecord[]) ?? imported;
  const savedPerSource = (data.perSource as SourceOutcome[]) ?? [];
  const importedIds = new Set(imported.map((r) => r.id));

  const [query, setQuery] = useState<string>((data.query as string) || defaultQuery(questionData));
  const [yearFrom, setYearFrom] = useState<string>((data.yearFrom as string) ?? "");
  const [yearTo, setYearTo] = useState<string>((data.yearTo as string) ?? "");
  const [limit, setLimit] = useState<string>((data.perSourceLimit as string) ?? "25");
  const [oaOnly, setOaOnly] = useState<boolean>((data.oaOnly as boolean) ?? false);
  const [articleType, setArticleType] = useState<ArticleTypeFilter>((data.articleType as ArticleTypeFilter) ?? "any");
  const [showAll, setShowAll] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importSource, setImportSource] = useState<ManualSourceId>("embase");
  const [importNote, setImportNote] = useState<string | null>(null);
  // Which result rows are expanded to show their abstract, and lazily-fetched
  // abstracts for records that arrived without one.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [absCache, setAbsCache] = useState<Record<string, { loading?: boolean; text?: string; none?: boolean }>>({});

  const sources = settings.enabledSources.filter((id) => isSourceUsable(SOURCES[id], !!settings.pubmedProxy));
  const maxResults = limit === "all" ? MAX_RESULTS_CAP : Number(limit);

  /** Toggle a result's abstract; fetch it via DOI on first open if missing. */
  const toggleAbstract = (r: WorkRecord) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(r.id) ? next.delete(r.id) : next.add(r.id);
      return next;
    });
    const hasAbstract = (r.abstract ?? "").trim().length > 0;
    if (!hasAbstract && !absCache[r.id] && !expanded.has(r.id)) {
      setAbsCache((prev) => ({ ...prev, [r.id]: { loading: true } }));
      void enrichStudy(r, { fullText: false })
        .then((ev) => setAbsCache((prev) => ({ ...prev, [r.id]: ev.abstract ? { text: ev.abstract } : { none: true } })))
        .catch(() => setAbsCache((prev) => ({ ...prev, [r.id]: { none: true } })));
    }
  };

  /** Read the latest saved lists from the store (not the render-time closure)
   *  so rapid clicks on different rows don't overwrite one another. Also
   *  materialises `fetched` for pre-import-flow projects, where only `records`
   *  exists — otherwise un-importing would drop rows from the visible list. */
  const liveLists = (): { imported: WorkRecord[]; fetched: WorkRecord[] } => {
    const live = (useProject.getState().project?.stepData[stepId] as StepData) ?? {};
    const liveImported = (live.records as WorkRecord[]) ?? [];
    const liveFetched = (live.fetched as WorkRecord[]) ?? liveImported;
    if (!live.fetched && liveFetched.length > 0) setField(stepId, "fetched", liveFetched);
    return { imported: liveImported, fetched: liveFetched };
  };

  /** Persist the imported set (the `records` every later step reads). */
  const saveImported = async (next: WorkRecord[]) => {
    setField(stepId, "records", next);
    setField(stepId, "nIdentified", next.length);
    await persist();
  };

  const toggleImport = (r: WorkRecord) => {
    const { imported: cur } = liveLists();
    const has = cur.some((x) => x.id === r.id);
    void saveImported(has ? cur.filter((x) => x.id !== r.id) : [...cur, r]);
  };

  const importAll = () => {
    const { imported: cur, fetched: all } = liveLists();
    const ids = new Set(cur.map((x) => x.id));
    void saveImported([...cur, ...all.filter((r) => !ids.has(r.id))]);
  };

  const run = async () => {
    if (!query.trim() || sources.length === 0) return;
    setRunning(true);
    setError(null);
    try {
      const yf = yearFrom.trim() ? Number(yearFrom) : undefined;
      const yt = yearTo.trim() ? Number(yearTo) : undefined;
      const outcome = await searchSources(query, sources, (id) =>
        settings.optionsFor(id, {
          maxResults,
          yearFrom: Number.isFinite(yf) ? yf : undefined,
          yearTo: Number.isFinite(yt) ? yt : undefined,
          openAccessOnly: oaOnly || undefined,
          articleType: articleType !== "any" ? articleType : undefined,
        }),
      );
      // New search results replace the previous fetch, but file-imported
      // records (manual sources) stay listed — a search can't re-fetch them.
      const keptManual = fetched.filter((r) => isManual(r.source));
      setField(stepId, "fetched", [...outcome.records, ...keptManual]);
      setField(stepId, "query", query);
      setField(stepId, "databases", [
        ...sources.map((id) => SOURCES[id].label),
        ...new Set(keptManual.map((r) => MANUAL_SOURCES[r.source as ManualSourceId].label)),
      ]);
      setField(stepId, "perSource", outcome.perSource);
      setField(stepId, "yearFrom", yearFrom);
      setField(stepId, "yearTo", yearTo);
      setField(stepId, "perSourceLimit", limit);
      setField(stepId, "oaOnly", oaOnly);
      setField(stepId, "articleType", articleType);
      await persist();
      if (outcome.records.length === 0) {
        setError("No records found. Try broadening your query or relaxing the filters.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed.");
    } finally {
      setRunning(false);
    }
  };

  /** RIS file import for sources without a public API (Embase, CENTRAL, …).
   *  Parsed records are attributed to the chosen source and imported directly —
   *  the reviewer picked them deliberately in the external database. */
  const importFile = async (file: File) => {
    setImportNote(null);
    try {
      const parsed = parseRis(await file.text(), importSource);
      if (parsed.length === 0) {
        setImportNote(`No records could be read from “${file.name}” — is it an RIS export?`);
        return;
      }
      const { imported: cur, fetched: all } = liveLists();
      const curIds = new Set(cur.map((r) => r.id));
      const fresh = parsed.filter((r) => !curIds.has(r.id));
      const fetchedIds = new Set(all.map((r) => r.id));
      setField(stepId, "fetched", [...all, ...parsed.filter((r) => !fetchedIds.has(r.id))]);
      setField(stepId, "records", [...cur, ...fresh]);
      setField(stepId, "nIdentified", cur.length + fresh.length);
      const label = MANUAL_SOURCES[importSource].label;
      const dbs = (data.databases as string[]) ?? [];
      if (!dbs.includes(label)) setField(stepId, "databases", [...dbs, label]);
      await persist();
      setImportNote(
        `Imported ${fresh.length} record${fresh.length === 1 ? "" : "s"} from ${label}` +
          (fresh.length < parsed.length ? ` (${parsed.length - fresh.length} already imported)` : "") + ".",
      );
    } catch (e) {
      setImportNote(e instanceof Error ? e.message : "Import failed.");
    }
  };

  const selectCls =
    "rounded-input border border-hairline bg-elevated/70 px-2 py-1.5 text-sm text-ink outline-none focus-visible:focus-ring";
  const visible = showAll ? fetched.slice(0, PREVIEW_MAX) : fetched.slice(0, 6);
  const allImported = fetched.length > 0 && fetched.every((r) => importedIds.has(r.id));

  return (
    <div className="flex flex-col gap-3">
      <label htmlFor="search-query" className="text-sm font-medium text-ink">
        Search query
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id="search-query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder="mindfulness exam anxiety students"
          className="w-full rounded-input border border-hairline bg-elevated/70 px-3 py-2 font-mono text-sm text-ink outline-none focus-visible:focus-ring"
        />
        <GlassButton onClick={run} loading={running} disabled={!query.trim() || sources.length === 0}>
          {!running && <Search className="h-4 w-4" aria-hidden="true" />}
          Search
        </GlassButton>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2 rounded-input border border-hairline bg-elevated/40 p-3">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-soft">
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" /> Filters
        </span>
        <label className="flex items-center gap-1.5 text-xs text-ink-soft">
          Years
          <input
            aria-label="From year"
            value={yearFrom}
            onChange={(e) => setYearFrom(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
            placeholder="from"
            inputMode="numeric"
            className={`${selectCls} num-tabular w-[4.5rem]`}
          />
          –
          <input
            aria-label="To year"
            value={yearTo}
            onChange={(e) => setYearTo(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
            placeholder="to"
            inputMode="numeric"
            className={`${selectCls} num-tabular w-[4.5rem]`}
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-ink-soft">
          Per source
          <select aria-label="Results per source" value={limit} onChange={(e) => setLimit(e.target.value)} className={selectCls}>
            {LIMIT_CHOICES.map((n) => (
              <option key={n} value={String(n)}>{n}</option>
            ))}
            <option value="all">All (≤{MAX_RESULTS_CAP})</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-ink-soft">
          Type
          <select aria-label="Article type" value={articleType} onChange={(e) => setArticleType(e.target.value as ArticleTypeFilter)} className={selectCls}>
            <option value="any">Any</option>
            <option value="rct">RCTs</option>
            <option value="review">Reviews</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-ink-soft">
          <input
            type="checkbox"
            checked={oaOnly}
            onChange={(e) => setOaOnly(e.target.checked)}
            className="h-4 w-4 rounded-[4px] accent-[var(--color-primary)] focus-visible:focus-ring"
          />
          Open access only
        </label>
      </div>

      {/* Which sources will run */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <Database className="h-3.5 w-3.5" aria-hidden="true" />
        {sources.length > 0 ? (
          <span>Searching: {sources.map((id) => SOURCES[id].label).join(", ")}</span>
        ) : (
          <span className="text-warning">No usable sources enabled.</span>
        )}
        <button onClick={openSettings} className="inline-flex items-center gap-1 text-primary hover:underline focus-visible:focus-ring">
          <Settings className="h-3.5 w-3.5" aria-hidden="true" />
          Configure
        </button>
      </div>

      {running && (
        <p className="flex items-center gap-2 text-sm text-ink-soft">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Querying sources… larger pulls page through
          results and can take a minute.
        </p>
      )}

      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-input bg-warning-soft p-3 text-sm text-ink">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          {error}
        </p>
      )}

      {/* Per-source breakdown */}
      {savedPerSource.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-input bg-elevated/40 p-3">
          <p className="num-tabular text-sm font-semibold text-ink">
            {fetched.length} fetched · {imported.length} imported into the review
          </p>
          <ul className="flex flex-col gap-1 text-sm">
            {savedPerSource.map((o) => (
              <li key={o.id} className="flex flex-col gap-0.5">
                <span className="flex items-center justify-between gap-2">
                  <SourceChip source={o.id} />
                  {o.error ? (
                    <span className="text-xs font-medium text-warning">{o.error}</span>
                  ) : (
                    <span className="num-tabular text-ink-muted">
                      {o.count} fetched{o.total > o.count ? ` of ${o.total.toLocaleString()}` : ""}
                    </span>
                  )}
                </span>
                {o.note && <span className="text-xs text-ink-muted">{o.note}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Results — import individually or all at once */}
      {fetched.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="num-tabular text-sm text-ink-soft">
              <strong className="text-ink">{imported.length}</strong> of {fetched.length} imported — click a title to read
              its abstract; only imported records flow into deduplication and screening.
            </span>
            <GlassButton variant="soft" size="sm" onClick={importAll} disabled={allImported} className="ml-auto">
              <Plus className="h-4 w-4" aria-hidden="true" />
              {allImported ? "All imported" : `Import all ${fetched.length}`}
            </GlassButton>
          </div>
          <ul className={`flex flex-col divide-y divide-[var(--divider)] rounded-input border border-hairline ${showAll ? "max-h-96 overflow-y-auto" : ""}`}>
            {visible.map((r) => {
              const isIn = importedIds.has(r.id);
              const isOpen = expanded.has(r.id);
              const cached = absCache[r.id];
              const abstract = (r.abstract ?? "").trim() || cached?.text;
              return (
                <li key={r.id} className="flex flex-col gap-2 p-3">
                  <div className="flex items-start gap-3">
                    <GlassButton
                      variant={isIn ? "soft" : "ghost"}
                      size="sm"
                      onClick={() => toggleImport(r)}
                      aria-label={isIn ? `Remove “${r.title}” from the review` : `Import “${r.title}” into the review`}
                      className="shrink-0 !px-2"
                      title={isIn ? "Imported — click to remove" : "Import this study"}
                    >
                      {isIn ? <Check className="h-4 w-4 text-success" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
                    </GlassButton>
                    <button
                      type="button"
                      onClick={() => toggleAbstract(r)}
                      aria-expanded={isOpen}
                      className="group min-w-0 flex-1 text-left focus-visible:focus-ring rounded-input"
                      title={isOpen ? "Hide abstract" : "Show abstract"}
                    >
                      <p className="flex items-start gap-1 text-sm font-medium text-ink group-hover:text-primary">
                        <ChevronRight
                          className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-muted transition-transform ${isOpen ? "rotate-90" : ""}`}
                          aria-hidden="true"
                        />
                        <span>{r.title}</span>
                      </p>
                      <p className="num-tabular mt-0.5 pl-[1.125rem] text-xs text-ink-muted">
                        {[r.authors[0], r.year, r.journal].filter(Boolean).join(" · ")}
                      </p>
                    </button>
                    <SourceChip source={r.source} />
                  </div>
                  {isOpen && (
                    <div className="ml-9 rounded-input bg-elevated/40 p-3">
                      {abstract ? (
                        <AbstractText text={abstract} />
                      ) : cached?.loading ? (
                        <p className="flex items-center gap-2 text-xs text-ink-muted">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Fetching abstract…
                        </p>
                      ) : (
                        <p className="text-xs text-ink-muted">
                          No abstract available for this record{r.doi ? "" : " (no DOI to look it up)"}.
                          {(r.oaUrl || r.url) && (
                            <>
                              {" "}
                              <a href={r.oaUrl ?? r.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                                Open the source ↗
                              </a>
                            </>
                          )}
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
            {showAll && fetched.length > PREVIEW_MAX && (
              <li className="p-2 text-center text-xs text-ink-muted">
                Showing the first {PREVIEW_MAX} of {fetched.length}.
              </li>
            )}
          </ul>
          {fetched.length > 6 && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="self-start text-xs font-medium text-primary hover:underline focus-visible:focus-ring"
            >
              {showAll ? "Show fewer" : `Show all ${fetched.length} records`}
            </button>
          )}
        </>
      )}

      {/* Import from databases without a public API */}
      <div className="flex flex-col gap-2 rounded-input border border-hairline bg-elevated/40 p-3">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-soft">
          <FileUp className="h-3.5 w-3.5" aria-hidden="true" /> Import from a database export (RIS)
        </span>
        <p className="text-xs text-ink-muted">
          Embase, Cochrane CENTRAL, WHO ICTRP, and conference abstracts have no public search API — search them
          externally, export the results as RIS, and import the file here. Records are tagged with their source and
          count toward the PRISMA identified total.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Source of the imported file"
            value={importSource}
            onChange={(e) => setImportSource(e.target.value as ManualSourceId)}
            className={selectCls}
          >
            {Object.values(MANUAL_SOURCES).map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
          <input
            ref={fileRef}
            type="file"
            accept=".ris,.txt"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importFile(f);
              e.target.value = "";
            }}
          />
          <GlassButton variant="soft" size="sm" onClick={() => fileRef.current?.click()}>
            <FileUp className="h-4 w-4" aria-hidden="true" /> Choose RIS file
          </GlassButton>
        </div>
        {importNote && (
          <p role="status" className="text-xs font-medium text-ink-soft">{importNote}</p>
        )}
      </div>
    </div>
  );
}
