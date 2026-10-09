import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { FileDown, FileText, Printer, ShieldAlert, Sparkles, Users, X } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { Figure, useReportFigures } from "./ReportFigures";
import { useProject } from "@/lib/study/project-store";
import { useIdentity } from "@/lib/collab/identity-store";
import { useSettings } from "@/lib/settings/settings-store";
import { platform } from "@/lib/platform";
import { compileManuscript, INTEGRITY_NOTE } from "@/lib/paper/compile";
import type { StepData } from "@/lib/study/types";
import { toHTML, toLaTeX, toMarkdown, type ReportAsset } from "@/lib/paper/export";
import { CITATION_STYLES, formatReferenceList, type CitationStyle } from "@/lib/paper/citations";
import { CSL_STYLES, formatWithCsl } from "@/lib/paper/cite/csl";

/** Render an abstract line, bolding the structured label (Background/Methods/Results). */
function AbstractLine({ text }: { text: string }) {
  const m = text.match(/^(Background|Methods|Results|Conclusions?):\s*(.*)$/);
  if (!m) return <>{text}</>;
  return (
    <>
      <strong className="text-ink">{m[1]}:</strong> {m[2]}
    </>
  );
}

/** Generate an honest AI-use disclosure grounded in how Scholea was used. */
function disclosure(studyType: string, venue: string): string {
  const v = venue.trim() || "this manuscript";
  return `AI-use disclosure for ${v}: The authors used Scholea, an AI-assisted research tool, to organise a ${studyType.toLowerCase()} and to compile a structured first draft from their own data against the relevant reporting standard. All study design decisions, data, analyses, and interpretations are the authors' own. Every AI-assisted sentence, number, and citation was reviewed and verified by the authors, who take full responsibility for the final content. No text was accepted as submission-ready without human review.`;
}

export function PaperDialog({ onClose }: { onClose: () => void }) {
  const project = useProject((s) => s.project);
  const config = useProject((s) => s.config);
  const setField = useProject((s) => s.setField);
  const persist = useProject((s) => s.persist);
  const identityName = useIdentity((s) => s.name);
  const contactEmail = useSettings((s) => s.contactEmail);
  const [style, setStyle] = useState<CitationStyle>("apa");
  const [cslStyle, setCslStyle] = useState<string>(""); // "" = built-in formatter
  const [csl, setCsl] = useState<{ loading: boolean; refs?: string[]; error?: string } | null>(null);
  const [venue, setVenue] = useState("");
  const [copied, setCopied] = useState(false);

  // Front matter — persisted per-project under the reserved "__paper" key, with
  // sensible defaults from the local identity and contact email.
  const savedFront = (project?.stepData["__paper"] as StepData) ?? {};
  const [authors, setAuthors] = useState<string>((savedFront.authors as string) ?? identityName ?? "");
  const [affiliation, setAffiliation] = useState<string>((savedFront.affiliation as string) ?? "");
  const [correspondence, setCorrespondence] = useState<string>((savedFront.correspondence as string) ?? contactEmail ?? "");
  const saveFront = () => {
    setField("__paper", "authors", authors);
    setField("__paper", "affiliation", affiliation);
    setField("__paper", "correspondence", correspondence);
    void persist();
  };

  const manuscript = useMemo(
    () =>
      project && config
        ? compileManuscript(config, project, {
            authors: authors.split(/[;,]/).map((a) => a.trim()).filter(Boolean),
            affiliation,
            correspondence,
          })
        : null,
    [project, config, authors, affiliation, correspondence],
  );
  const builtinRefs = useMemo(
    () => (manuscript ? formatReferenceList(manuscript.references, style) : []),
    [manuscript, style],
  );

  // Figures, tagged with the step they belong to so each sits with its section.
  const figures = useReportFigures(project, config);

  // Optional citeproc/CSL formatting (fetched on demand; falls back to built-in).
  const refsKey = manuscript?.references.map((r) => r.id).join(",");
  useEffect(() => {
    if (!cslStyle || !manuscript) {
      setCsl(null);
      return;
    }
    let cancelled = false;
    setCsl({ loading: true });
    void formatWithCsl(manuscript.references, cslStyle)
      .then((refs) => !cancelled && setCsl({ loading: false, refs }))
      .catch(() => !cancelled && setCsl({ loading: false, error: "That CSL style could not be loaded. CSL styles are fetched from the internet when you choose one. Using the built-in formatter." }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cslStyle, refsKey]);

  if (!manuscript || !config || !project) return null;

  const refs = csl?.refs ?? builtinRefs;

  const slug = manuscript.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "manuscript";
  const discText = disclosure(config.label, venue);

  // Group figures by their source step, and number them in document order:
  // sections in order, then any figure whose step has no section (leftovers).
  const figsByStep = new Map<string, typeof figures>();
  for (const f of figures) {
    const arr = figsByStep.get(f.stepId) ?? [];
    arr.push(f);
    figsByStep.set(f.stepId, arr);
  }
  const sectionStepIds = new Set(manuscript.sections.map((s) => s.stepId));
  const leftoverFigures = figures.filter((f) => !sectionStepIds.has(f.stepId));
  const figNumber = new Map<string, number>();
  let counter = 0;
  for (const sec of manuscript.sections) {
    for (const f of figsByStep.get(sec.stepId) ?? []) figNumber.set(f.id, ++counter);
  }
  for (const f of leftoverFigures) figNumber.set(f.id, ++counter);

  /** Serialise the rendered figures/tables — with their step — so exports can
   *  place each one inside the right section too. */
  const collectAssets = (): ReportAsset[] => {
    const root = document.getElementById("paper-print");
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>("figure[data-fig]")).map((fig) => {
      const svg = fig.querySelector("svg");
      const table = !svg ? fig.querySelector("table") : null;
      const caption = fig.querySelector("figcaption")?.textContent?.replace(/^Figure\s*\d+\.\s*/, "").trim() ?? "";
      return {
        stepId: fig.getAttribute("data-step") ?? "",
        caption,
        svg: svg ? svg.outerHTML : undefined,
        tableHtml: table ? table.outerHTML : undefined,
      };
    });
  };

  const exportMd = () => platform.saveFile(`${slug}.md`, toMarkdown(manuscript, refs, collectAssets()));
  const exportTex = () => platform.saveFile(`${slug}.tex`, toLaTeX(manuscript, refs, collectAssets()));
  const exportDoc = () => platform.saveFile(`${slug}.doc`, toHTML(manuscript, refs, collectAssets())); // Word opens HTML

  return (
    <motion.div
      className="fixed inset-0 z-modal overflow-y-auto p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <button aria-label="Close" className="fixed inset-0 -z-10 bg-scrim print:hidden" onClick={onClose} />
      <div className="mx-auto my-6 w-full max-w-3xl">
        <div className="glass-2 glass-highlight rounded-modal p-5 sm:p-6">
          {/* Controls */}
          <div className="mb-4 flex flex-wrap items-center gap-2 print:hidden">
            <h2 className="mr-auto text-lg font-bold text-ink">Compile &amp; export</h2>
            <label className="flex items-center gap-1.5 text-sm text-ink-soft">
              Citations
              <select
                value={cslStyle ? "" : style}
                disabled={!!cslStyle}
                onChange={(e) => setStyle(e.target.value as CitationStyle)}
                className="rounded-input border border-hairline bg-elevated/70 px-2 py-1 text-sm text-ink outline-none focus-visible:focus-ring disabled:opacity-50"
              >
                {CITATION_STYLES.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-sm text-ink-soft" title="More citation styles through citeproc-js (CSL), fetched from the internet when you choose one">
              CSL
              <select
                value={cslStyle}
                onChange={(e) => setCslStyle(e.target.value)}
                className="rounded-input border border-hairline bg-elevated/70 px-2 py-1 text-sm text-ink outline-none focus-visible:focus-ring"
              >
                <option value="">Built-in</option>
                {CSL_STYLES.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            </label>
            <GlassButton variant="ghost" size="sm" aria-label="Close" onClick={onClose} className="!px-2">
              <X className="h-5 w-5" aria-hidden="true" />
            </GlassButton>
          </div>

          {/* Front matter — authors, affiliation, corresponding author */}
          <div className="mb-4 flex flex-col gap-2 rounded-input border border-hairline bg-elevated/40 p-3 print:hidden">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-soft">
              <Users className="h-3.5 w-3.5" aria-hidden="true" /> Authors &amp; affiliation
            </span>
            <input
              value={authors}
              onChange={(e) => setAuthors(e.target.value)}
              onBlur={saveFront}
              placeholder="Author names, comma-separated (e.g. Baig U, Okafor R)"
              className="w-full rounded-input border border-hairline bg-elevated/70 px-3 py-1.5 text-sm text-ink outline-none focus-visible:focus-ring"
            />
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={affiliation}
                onChange={(e) => setAffiliation(e.target.value)}
                onBlur={saveFront}
                placeholder="Affiliation / institution"
                className="w-full flex-1 rounded-input border border-hairline bg-elevated/70 px-3 py-1.5 text-sm text-ink outline-none focus-visible:focus-ring"
              />
              <input
                value={correspondence}
                onChange={(e) => setCorrespondence(e.target.value)}
                onBlur={saveFront}
                placeholder="Corresponding email"
                className="w-full flex-1 rounded-input border border-hairline bg-elevated/70 px-3 py-1.5 text-sm text-ink outline-none focus-visible:focus-ring"
              />
            </div>
          </div>

          <div className="mb-4 flex flex-wrap gap-2 print:hidden">
            <GlassButton variant="soft" size="sm" onClick={exportMd}><FileText className="h-4 w-4" aria-hidden="true" /> Markdown</GlassButton>
            <GlassButton variant="soft" size="sm" onClick={exportDoc}><FileDown className="h-4 w-4" aria-hidden="true" /> Word</GlassButton>
            <GlassButton variant="soft" size="sm" onClick={exportTex}><FileText className="h-4 w-4" aria-hidden="true" /> LaTeX</GlassButton>
            <GlassButton variant="soft" size="sm" onClick={() => window.print()}><Printer className="h-4 w-4" aria-hidden="true" /> Print / PDF</GlassButton>
          </div>

          {/* Integrity banner */}
          <p className="mb-4 flex items-start gap-2 rounded-input bg-warning-soft p-3 text-sm text-ink print:hidden">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            {INTEGRITY_NOTE}
          </p>

          {/* Manuscript preview (also the print target) — journal-styled */}
          <article id="paper-print" className="paper-doc font-serif leading-relaxed text-ink">
            <header className="paper-titlepage border-b-2 border-strong pb-4 text-center">
              <h1 className="font-display text-2xl font-bold leading-tight">{manuscript.title}</h1>
              <p className="mt-1 text-sm italic text-ink-soft">
                {manuscript.studyTypeLabel}: structured draft ({manuscript.reportingStandard})
              </p>
              {manuscript.front.authors.length > 0 && (
                <p className="mt-3 text-base font-semibold text-ink">{manuscript.front.authors.join(", ")}</p>
              )}
              {manuscript.front.affiliation && (
                <p className="mt-0.5 text-sm italic text-ink-soft">{manuscript.front.affiliation}</p>
              )}
              {manuscript.front.correspondence && (
                <p className="mt-0.5 text-xs text-ink-muted">Correspondence: {manuscript.front.correspondence}</p>
              )}
              <p className="mt-0.5 text-xs text-ink-muted">{manuscript.front.date}</p>
            </header>

            <p className="paper-note mt-4 border-l-[3px] border-primary pl-3 text-xs italic text-ink-muted">
              {INTEGRITY_NOTE}
            </p>

            {manuscript.abstract.length > 0 && (
              <section className="paper-abstract mt-5 rounded-input border-l-[3px] border-strong bg-elevated/40 p-4">
                <h2 className="text-sm font-bold uppercase tracking-wide text-ink">Abstract</h2>
                {manuscript.abstract.map((p, j) => (
                  <p key={j} className="mt-1.5 text-sm">
                    <AbstractLine text={p} />
                  </p>
                ))}
              </section>
            )}

            {manuscript.sections.length === 0 && manuscript.abstract.length === 0 && (
              <p className="mt-4 text-ink-muted">
                Fill in the pathway steps and your draft will assemble here automatically.
              </p>
            )}

            {manuscript.sections.map((sec, i) => (
              <section key={i} className="mt-5">
                <h2 className="font-display text-lg font-semibold text-ink border-b border-hairline pb-1">{sec.heading}</h2>
                {sec.paragraphs.map((p, j) => (
                  <p key={j} className="mt-2 text-justify">{p}</p>
                ))}
                {/* Figures/tables pulled from THIS step sit with its text. */}
                {(figsByStep.get(sec.stepId) ?? []).map((f) => (
                  <Figure key={f.id} id={f.id} stepId={f.stepId} n={figNumber.get(f.id) ?? 0} caption={f.caption}>
                    {f.node}
                  </Figure>
                ))}
              </section>
            ))}

            {/* Any figure whose step produced no text section (rare) goes last. */}
            {leftoverFigures.length > 0 && (
              <section className="mt-5">
                <h2 className="font-display text-lg font-semibold text-ink border-b border-hairline pb-1">Figures &amp; tables</h2>
                {leftoverFigures.map((f) => (
                  <Figure key={f.id} id={f.id} stepId={f.stepId} n={figNumber.get(f.id) ?? 0} caption={f.caption}>
                    {f.node}
                  </Figure>
                ))}
              </section>
            )}

            {refs.length > 0 && (
              <section className="mt-5">
                <h2 className="font-display text-lg font-semibold text-ink border-b border-hairline pb-1">References</h2>
                {csl?.loading && <p className="mt-1 text-xs text-ink-muted print:hidden">Formatting with CSL…</p>}
                {csl?.error && <p className="mt-1 text-xs text-warning print:hidden">{csl.error}</p>}
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
                  {refs.map((r, i) => <li key={i}>{r}</li>)}
                </ol>
              </section>
            )}

            {manuscript.methodsCitations.length > 0 && (
              <section className="mt-5">
                <h2 className="font-display text-lg font-semibold text-ink border-b border-hairline pb-1">Statistical methods references</h2>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
                  {manuscript.methodsCitations.map((r, i) => <li key={i}>{r}</li>)}
                </ol>
              </section>
            )}
          </article>

          {/* AI-use disclosure */}
          <details className="mt-5 rounded-input bg-elevated/40 p-3 text-sm print:hidden">
            <summary className="flex cursor-pointer items-center gap-2 font-semibold text-ink">
              <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" /> AI-use disclosure statement
            </summary>
            <div className="mt-2 flex flex-col gap-2">
              <input
                value={venue}
                onChange={(e) => setVenue(e.target.value)}
                placeholder="Journal / venue name (optional)"
                className="w-full rounded-input border border-hairline bg-elevated/70 px-3 py-1.5 text-sm text-ink outline-none focus-visible:focus-ring"
              />
              <p className="rounded-input bg-canvas/60 p-2 text-ink-soft">{discText}</p>
              <GlassButton
                variant="soft"
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(discText);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? "Copied" : "Copy disclosure"}
              </GlassButton>
            </div>
          </details>
        </div>
      </div>
    </motion.div>
  );
}
