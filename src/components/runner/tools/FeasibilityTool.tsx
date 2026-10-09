import { useState } from "react";
import { Search, TrendingUp, AlertTriangle, BookText } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { BarChart, type Bar } from "@/components/charts/BarChart";
import { useProject } from "@/lib/study/project-store";
import { useSettings } from "@/lib/settings/settings-store";
import { openAlexYearlyVolume, type VolumeResult } from "@/lib/sources/openalex";
import { RateLimitError, SourceError } from "@/lib/sources/types";
import type { StepData } from "@/lib/study/types";

/**
 * Feasibility & saturation scoping. Runs a live OpenAlex publication-volume
 * query (group_by=publication_year — CORS-safe, no key needed) and renders the
 * per-year trend so the researcher can judge whether there's enough evidence to
 * synthesise and whether the field is still active. A scoping signal, not a
 * substitute for the protocolised search.
 */
export function FeasibilityTool({ stepId }: { stepId: string }) {
  const project = useProject((s) => s.project);
  const setField = useProject((s) => s.setField);
  const persist = useProject((s) => s.persist);
  const settings = useSettings();

  const data = (project?.stepData[stepId] as StepData) ?? {};
  const [query, setQuery] = useState<string>((data.scopingQuery as string) ?? "");
  const [vol, setVol] = useState<VolumeResult | null>((data.scopingVolume as VolumeResult) ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    const term = query.trim();
    if (!term) return;
    if (!settings.loaded) await settings.load();
    setLoading(true);
    setError(null);
    try {
      const result = await openAlexYearlyVolume(term, settings.optionsFor("openalex"));
      setVol(result);
      setField(stepId, "scopingQuery", term);
      setField(stepId, "scopingVolume", result);
      setField(stepId, "scopingTotal", result.total);
      await persist();
    } catch (e) {
      if (e instanceof RateLimitError) {
        setError(e.exhausted ? "OpenAlex daily limit reached — add your email or key in Settings, or try tomorrow." : "Rate limited by OpenAlex — try again shortly.");
      } else if (e instanceof SourceError) {
        setError(`OpenAlex request failed: ${e.message}`);
      } else {
        setError(e instanceof Error ? e.message : "Scoping search failed.");
      }
    } finally {
      setLoading(false);
    }
  };

  const bars: Bar[] = (vol?.byYear ?? []).map((y) => ({ label: String(y.year), value: y.count }));
  const recent = vol ? sumRecent(vol, 5) : 0;
  const verdict = vol ? assess(vol) : null;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label htmlFor="scoping-query" className="text-sm font-medium text-ink">
          Scoping query
        </label>
        <p className="text-xs text-ink-muted">
          A broad version of your question (e.g. <em>mindfulness app test anxiety students</em>). Counts come from OpenAlex.
        </p>
        <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
          <input
            id="scoping-query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
            }}
            placeholder="Broad terms for your topic"
            className="w-full rounded-input border border-hairline bg-elevated/70 px-3 py-2 text-base text-ink outline-none focus-visible:focus-ring"
          />
          <GlassButton onClick={run} loading={loading} disabled={!query.trim()} className="shrink-0">
            {!loading && <Search className="h-4 w-4" aria-hidden="true" />}
            Scope the literature
          </GlassButton>
        </div>
      </div>

      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-input bg-danger-soft p-3 text-sm text-ink">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
          {error}
        </p>
      )}

      {vol && bars.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="Total works" value={vol.total.toLocaleString()} />
            <Stat label="Last 5 years" value={recent.toLocaleString()} />
            <Stat label="Years with output" value={String(vol.byYear.length)} />
          </div>
          <BarChart bars={bars} title={`Publications per year — “${query.trim()}”`} />
          {verdict && (
            <p className={`flex items-start gap-2 rounded-input p-3 text-sm text-ink ${verdict.tone}`}>
              <TrendingUp className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {verdict.text}
            </p>
          )}
          <details className="rounded-input bg-elevated/40 p-3 text-sm">
            <summary className="flex cursor-pointer items-center gap-2 font-semibold text-ink">
              <BookText className="h-4 w-4 text-primary" aria-hidden="true" />
              Method &amp; caveats
            </summary>
            <p className="mt-2 text-ink-soft">
              Counts are OpenAlex works matching a free-text search, grouped by publication year (OpenAlex API,
              <code className="px-1">group_by=publication_year</code>). This is a coverage estimate for one source — it
              over-counts (no de-duplication, broad matching) and under-counts (one database). Use it to judge
              <em> whether </em> a review is feasible, not as your final yield. Your protocolised multi-database search is
              what counts.
            </p>
          </details>
        </>
      )}

      {vol && bars.length === 0 && !error && (
        <p className="rounded-input bg-warning-soft p-3 text-sm text-ink">
          OpenAlex returned no dated works for that query. Very sparse evidence may mean a review would be premature —
          or that the query is too narrow.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-input border border-hairline bg-elevated/40 p-3">
      <p className="num-tabular text-lg font-bold text-ink">{value}</p>
      <p className="text-xs text-ink-muted">{label}</p>
    </div>
  );
}

function sumRecent(vol: VolumeResult, years: number): number {
  const latest = Math.max(...vol.byYear.map((y) => y.year));
  return vol.byYear.filter((y) => y.year > latest - years).reduce((s, y) => s + y.count, 0);
}

/** A plain-language scoping verdict — deliberately cautious. */
function assess(vol: VolumeResult): { text: string; tone: string } {
  const total = vol.total;
  const recent = sumRecent(vol, 5);
  const older = total - recent;
  const growing = recent > older;
  if (total < 25) {
    return {
      text: `Sparse: ~${total} works total. There may be too little primary evidence to synthesise — consider a scoping review or a narrower, well-justified gap.`,
      tone: "bg-warning-soft",
    };
  }
  if (total > 3000) {
    return {
      text: `Very large literature (~${total.toLocaleString()} works). A focused review is feasible but screening could be heavy — tighten eligibility, and check whether recent reviews already cover this.`,
      tone: "bg-info-soft",
    };
  }
  return {
    text: `Feasible scope: ~${total.toLocaleString()} works, ${recent.toLocaleString()} in the last 5 years${
      growing ? " (an active, growing field)" : " (output is not accelerating)"
    }. Confirm against PROSPERO and a second database before committing.`,
    tone: "bg-success-soft",
  };
}
