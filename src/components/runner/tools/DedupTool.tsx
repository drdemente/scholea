import { useState } from "react";
import { ChevronRight, Copy, Download, Layers, Loader2, Trash2 } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { SourceChip } from "./SourceChip";
import { AbstractText } from "./AbstractText";
import { useProject } from "@/lib/study/project-store";
import { platform } from "@/lib/platform";
import { dedupeRecords } from "@/lib/sources/dedup";
import { enrichStudy } from "@/lib/study/appraisal-enrich";
import { toBibTeX, toRIS } from "@/lib/references/export";
import type { StepData } from "@/lib/study/types";
import type { WorkRecord } from "@/lib/sources/types";

/**
 * Deduplicate the imported records from the search step (DOI, else normalised
 * title+year). First lists the imported studies so the reviewer can read each
 * abstract and remove any that shouldn't be screened; then writes the unique set
 * + duplicate count, and offers BibTeX/RIS export (the no-account fallback, §5).
 */
export function DedupTool({ stepId }: { stepId: string }) {
  const project = useProject((s) => s.project);
  const setField = useProject((s) => s.setField);
  const persist = useProject((s) => s.persist);

  const searchData = (project?.stepData["search"] as StepData) ?? {};
  const raw = (searchData.records as WorkRecord[]) ?? [];
  const data = (project?.stepData[stepId] as StepData) ?? {};
  const unique = (data.records as WorkRecord[]) ?? [];
  const hasRun = data.nDuplicates != null;

  const run = async () => {
    const result = dedupeRecords(raw);
    setField(stepId, "records", result.unique);
    setField(stepId, "nDuplicates", result.duplicatesRemoved);
    setField(stepId, "nAfterDedup", result.unique.length);
    await persist();
  };

  /** Drop a study from the imported set before screening; invalidate stale
   *  dedup output so the counts are recomputed on the filtered set. */
  const removeRecord = (id: string) => {
    const next = raw.filter((r) => r.id !== id);
    setField("search", "records", next);
    setField("search", "nIdentified", next.length);
    if (hasRun) {
      setField(stepId, "records", []);
      setField(stepId, "nDuplicates", undefined);
      setField(stepId, "nAfterDedup", undefined);
    }
    void persist();
  };

  const exportAs = (kind: "bib" | "ris") => {
    const out = kind === "bib" ? toBibTeX(unique) : toRIS(unique);
    void platform.saveFile(`scholea-references.${kind === "bib" ? "bib" : "ris"}`, out);
  };

  if (raw.length === 0) {
    return (
      <p className="rounded-input bg-info-soft p-3 text-sm text-ink">
        Import records in the previous step first — there are no records to deduplicate yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Imported studies — read abstracts and remove any before screening */}
      <ImportedStudies records={raw} onRemove={removeRecord} />

      <div className="flex flex-col gap-3 border-t border-hairline pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <GlassButton onClick={run}>
            <Layers className="h-4 w-4" aria-hidden="true" />
            Deduplicate {raw.length} records
          </GlassButton>
          {unique.length > 0 && (
            <>
              <GlassButton variant="soft" size="sm" onClick={() => exportAs("bib")}>
                <Download className="h-4 w-4" aria-hidden="true" /> BibTeX
              </GlassButton>
              <GlassButton variant="soft" size="sm" onClick={() => exportAs("ris")}>
                <Copy className="h-4 w-4" aria-hidden="true" /> RIS
              </GlassButton>
            </>
          )}
        </div>

        {hasRun && (
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat label="Identified" value={raw.length} />
            <Stat label="Duplicates" value={(data.nDuplicates as number) ?? 0} tone="warning" />
            <Stat label="Unique" value={unique.length} tone="success" />
          </div>
        )}
      </div>
    </div>
  );
}

/** Imported studies with expandable abstracts (same behaviour as the search
 *  step) plus a per-study remove control to filter before screening. */
function ImportedStudies({ records, onRemove }: { records: WorkRecord[]; onRemove: (id: string) => void }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [absCache, setAbsCache] = useState<Record<string, { loading?: boolean; text?: string; none?: boolean }>>({});
  const [showAll, setShowAll] = useState(false);

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

  const visible = showAll ? records.slice(0, 300) : records.slice(0, 6);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-ink">
        {records.length} imported {records.length === 1 ? "study" : "studies"}
        <span className="font-normal text-ink-soft"> — click a title to read its abstract; remove any that shouldn’t be screened.</span>
      </p>
      <ul className={`flex flex-col divide-y divide-[var(--divider)] rounded-input border border-hairline ${showAll ? "max-h-96 overflow-y-auto" : ""}`}>
        {visible.map((r) => {
          const isOpen = expanded.has(r.id);
          const cached = absCache[r.id];
          const abstract = (r.abstract ?? "").trim() || cached?.text;
          return (
            <li key={r.id} className="flex flex-col gap-2 p-3">
              <div className="flex items-start gap-3">
                <button
                  type="button"
                  onClick={() => toggleAbstract(r)}
                  aria-expanded={isOpen}
                  className="group min-w-0 flex-1 rounded-input text-left focus-visible:focus-ring"
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
                <GlassButton
                  variant="ghost"
                  size="sm"
                  onClick={() => onRemove(r.id)}
                  aria-label={`Remove “${r.title}” from the review`}
                  title="Remove from the review"
                  className="shrink-0 !px-2"
                >
                  <Trash2 className="h-4 w-4 text-ink-muted" aria-hidden="true" />
                </GlassButton>
              </div>
              {isOpen && (
                <div className="ml-[1.125rem] rounded-input bg-elevated/40 p-3">
                  {abstract ? (
                    <AbstractText text={abstract} />
                  ) : cached?.loading ? (
                    <p className="flex items-center gap-2 text-xs text-ink-muted">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Fetching abstract…
                    </p>
                  ) : (
                    <p className="text-xs text-ink-muted">
                      No abstract available for this record{r.doi ? "" : " (no DOI to look it up)"}.
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {records.length > 6 && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="self-start text-xs font-medium text-primary hover:underline focus-visible:focus-ring"
        >
          {showAll ? "Show fewer" : `Show all ${records.length} studies`}
        </button>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "warning" | "success" }) {
  const cls = tone === "warning" ? "text-warning" : tone === "success" ? "text-success" : "text-ink";
  return (
    <div className="rounded-input bg-elevated/40 p-3">
      <p className={`num-tabular text-2xl font-bold ${cls}`}>{value}</p>
      <p className="text-xs text-ink-muted">{label}</p>
    </div>
  );
}
