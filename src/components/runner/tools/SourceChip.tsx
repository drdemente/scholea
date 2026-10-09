import type { WorkRecord } from "@/lib/sources/types";

/** Distinct, theme-aware colour per literature source so every record in a list
 *  shows at a glance where it was pulled from. */
const STYLE: Record<WorkRecord["source"], { label: string; cls: string }> = {
  europepmc: { label: "Europe PMC", cls: "bg-success-soft text-success" },
  crossref: { label: "Crossref", cls: "bg-info-soft text-info" },
  openalex: { label: "OpenAlex", cls: "bg-accent-soft text-accent" },
  pubmed: { label: "PubMed", cls: "bg-warning-soft text-warning" },
  clinicaltrials: { label: "ClinicalTrials.gov", cls: "bg-primary-soft text-primary" },
  embase: { label: "Embase", cls: "bg-danger-soft text-danger" },
  "cochrane-central": { label: "Cochrane CENTRAL", cls: "bg-info-soft text-info" },
  "who-ictrp": { label: "WHO ICTRP", cls: "bg-accent-soft text-accent" },
  conference: { label: "Conference abstract", cls: "bg-warning-soft text-warning" },
  other: { label: "Imported", cls: "bg-sunken text-ink-soft" },
  demo: { label: "Demo", cls: "bg-sunken text-ink-muted" },
};

export function SourceChip({ source }: { source: WorkRecord["source"] }) {
  const s = STYLE[source] ?? STYLE.demo;
  return (
    <span className={`inline-flex shrink-0 items-center rounded-pill px-2 py-0.5 text-[11px] font-semibold ${s.cls}`}>
      {s.label}
    </span>
  );
}
