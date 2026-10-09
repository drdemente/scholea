import { useCallback, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ClipboardList, Download, Info, Sparkles, X } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { robVisual, type RobLevel } from "@/components/appraisal/TrafficLight";
import { useProject } from "@/lib/study/project-store";
import { useSettings } from "@/lib/settings/settings-store";
import { includedStudies, hasRealStudies, type IncludedStudy } from "@/lib/study/included";
import { enrichStudies, type StudyEvidence } from "@/lib/study/appraisal-enrich";
import { platform } from "@/lib/platform";
import { generateText } from "@/lib/ai/client";
import { AI_SYSTEM_PROMPT } from "@/lib/ai/prompts";
import type { Project } from "@/lib/db/schema";
import type { StepData } from "@/lib/study/types";

/** RoB 2 domains (for randomised trials). */
const DOMAINS = [
  { key: "d1", code: "D1", name: "Randomisation process" },
  { key: "d2", code: "D2", name: "Deviations from intended interventions" },
  { key: "d3", code: "D3", name: "Missing outcome data" },
  { key: "d4", code: "D4", name: "Measurement of the outcome" },
  { key: "d5", code: "D5", name: "Selection of the reported result" },
] as const;

const CYCLE: RobLevel[] = ["low", "some-concern", "high"];
type Judgements = Record<string, Record<string, RobLevel>>;
type Rationales = Record<string, string>;

/** Map an object key to a RoB 2 domain (tolerates d1/D1/domain1/"randomisation"…). */
const DOMAIN_MATCH: { key: string; re: RegExp }[] = [
  { key: "d1", re: /(d\s*0*1|domain\s*0*1|random)/i },
  { key: "d2", re: /(d\s*0*2|domain\s*0*2|deviat|intervention|adher)/i },
  { key: "d3", re: /(d\s*0*3|domain\s*0*3|miss|attrit)/i },
  { key: "d4", re: /(d\s*0*4|domain\s*0*4|measur|detect)/i },
  { key: "d5", re: /(d\s*0*5|domain\s*0*5|select|report)/i },
];
function domainForKey(key: string): string | null {
  return DOMAIN_MATCH.find((d) => d.re.test(key))?.key ?? null;
}

/** Normalise any level phrasing to a RobLevel ("Some concerns", "unclear", "high risk", …). */
function normLevel(v: unknown): RobLevel | undefined {
  const t = String(v).toLowerCase();
  if (/high|serious|critical/.test(t)) return "high";
  if (/some|concern|moderat|unclear|medium|uncertain|caution|unknown|not\s*reported|\bnr\b/.test(t)) return "some-concern";
  if (/low|good|adequate|\byes\b/.test(t)) return "low";
  return undefined;
}

/** Extract every COMPLETE top-level {…} object from possibly-fenced, possibly-
 *  truncated text — this salvages judgements even when the model's JSON array is
 *  cut off by the token limit. */
function extractObjects(text: string): Record<string, unknown>[] {
  const s = text.replace(/```(?:json|javascript)?/gi, "");
  const objs: Record<string, unknown>[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          try { const o = JSON.parse(s.slice(start, i + 1)); if (o && typeof o === "object" && !Array.isArray(o)) objs.push(o as Record<string, unknown>); } catch { /* skip partial */ }
          start = -1;
        }
      }
    }
  }
  return objs;
}

export interface ParsedJudgement { id: string | number | undefined; levels: Record<string, RobLevel>; rationale?: string }

/**
 * Robustly parse per-study RoB judgements from an LLM response — tolerant of
 * markdown fences, object/array wrappers, TRUNCATED output, key/label variants,
 * value phrasings, and per-domain {judgement, reason} shapes.
 */
export function parseAiJudgements(text: string): ParsedJudgement[] {
  const out: ParsedJudgement[] = [];
  for (const o of extractObjects(text)) {
    const levels: Record<string, RobLevel> = {};
    const reasons: string[] = [];
    let rationale: string | undefined;
    let id: string | number | undefined;
    for (const [k, v] of Object.entries(o)) {
      const kl = k.toLowerCase();
      if (/^(id|no|num|number|index|study|label|name|ref)$/.test(kl) && (typeof v === "string" || typeof v === "number")) {
        if (id == null) id = v;
        continue;
      }
      if (/(rationale|reason|justification|explanation|note|comment|summary)/.test(kl) && typeof v === "string") {
        if (!rationale) rationale = v;
        continue;
      }
      const domain = domainForKey(kl);
      if (!domain) continue;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const vo = v as Record<string, unknown>;
        const lvl = normLevel(vo.judgement ?? vo.judgment ?? vo.level ?? vo.risk ?? vo.rating ?? vo.value);
        if (lvl) levels[domain] = lvl;
        const r = typeof vo.reason === "string" ? vo.reason : typeof vo.rationale === "string" ? vo.rationale : undefined;
        if (r) reasons.push(`${domain.toUpperCase()}: ${r}`);
      } else {
        const lvl = normLevel(v);
        if (lvl) levels[domain] = lvl;
      }
    }
    if (Object.keys(levels).length > 0) {
      out.push({ id, levels, rationale: rationale ?? (reasons.length ? reasons.join(" ") : undefined) });
    }
  }
  return out;
}

/** Build a compact "review context" from earlier steps so the AI judges bias in
 *  the context of the whole project (PICO, eligibility, extraction), not just a
 *  bare abstract. */
function reviewContext(project: Project): string {
  const sd = (id: string): StepData => (project.stepData[id] as StepData) ?? {};
  const q = sd("question");
  const proto = sd("protocol");
  const extr = sd("extraction");
  const parts: string[] = [];
  if (typeof q.question === "string" && q.question.trim()) parts.push(`Review question: ${q.question.trim()}`);
  const pico = [
    typeof q.population === "string" && q.population && `Population: ${q.population}`,
    typeof q.intervention === "string" && q.intervention && `Intervention: ${q.intervention}`,
    typeof q.comparator === "string" && q.comparator && `Comparator: ${q.comparator}`,
    typeof q.outcome === "string" && q.outcome && `Primary outcome: ${q.outcome}`,
  ].filter(Boolean);
  if (pico.length) parts.push(pico.join("; "));
  if (typeof proto.eligibility === "string" && proto.eligibility.trim()) parts.push(`Eligibility: ${proto.eligibility.trim().slice(0, 500)}`);
  if (typeof extr.form === "string" && extr.form.trim()) parts.push(`Data extracted per study: ${extr.form.trim().slice(0, 400)}`);
  if (typeof extr.outcomeType === "string" && extr.outcomeType) parts.push(`Outcome type: ${extr.outcomeType}`);
  return parts.join("\n");
}

/** RoB 2 overall = worst domain; undefined until all domains are judged. */
function overall(row: Record<string, RobLevel> | undefined): RobLevel | undefined {
  if (!row) return undefined;
  if (DOMAINS.some((d) => !row[d.key])) return undefined;
  if (DOMAINS.some((d) => row[d.key] === "high")) return "high";
  if (DOMAINS.some((d) => row[d.key] === "some-concern")) return "some-concern";
  return "low";
}

/**
 * Risk-of-bias appraisal matrix. Click a cell to cycle low → some concerns →
 * high; the overall judgement and the count of fully-appraised studies are
 * computed and persisted (the count drives this step's validation).
 */
export function AppraisalTool({ stepId }: { stepId: string }) {
  const project = useProject((s) => s.project);
  const setField = useProject((s) => s.setField);
  const persist = useProject((s) => s.persist);
  const settings = useSettings();
  const [ai, setAi] = useState<{ loading: boolean; note?: string; error?: string; done?: number; enriched?: number; unmatched?: string[] } | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);

  const data = (project?.stepData[stepId] as StepData) ?? {};
  const judgements = (data.judgements as Judgements) ?? {};
  const rationales = (data.robRationale as Rationales) ?? {};
  const evidence = (data.evidence as Record<string, StudyEvidence>) ?? {};

  // The real included studies (full-text → screening fallback; demo only when empty).
  const studies = useMemo(() => (project ? includedStudies(project) : []), [project]);
  const isDemo = project ? !hasRealStudies(project) : true;

  const recount = useCallback(
    (next: Judgements) => studies.filter((s) => overall(next[s.id]) !== undefined).length,
    [studies],
  );

  const cycle = useCallback(
    (studyId: string, domainKey: string) => {
      // Read the latest from the store (not the render-time closure) so rapid
      // clicks on different cells don't overwrite one another.
      const live = ((useProject.getState().project?.stepData[stepId] as StepData)?.judgements as Judgements) ?? {};
      const cur = live[studyId]?.[domainKey];
      const nextLevel = cur ? CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length] : CYCLE[0];
      const next: Judgements = {
        ...live,
        [studyId]: { ...live[studyId], [domainKey]: nextLevel },
      };
      setField(stepId, "judgements", next);
      setField(stepId, "nAppraised", recount(next));
      void persist();
    },
    [setField, persist, stepId, recount],
  );

  /**
   * AI-assisted risk-of-bias assessment. Feeds the AI the whole review context
   * (PICO, eligibility, extraction) plus each study's title/abstract, judges all
   * five RoB 2 domains for every included study, fills each D1–D5 cell (defaulting
   * any domain the model leaves unset to "some concern"), and stores a per-study
   * rationale for the summary. Manual judgements are never overwritten.
   */
  const suggest = async () => {
    if (!project) return;
    // Said here, before the studies are fetched: generateText refuses a request
    // with no model, and it is only reached after that fetch.
    if (!settings.llmModel.trim()) {
      setAi({ loading: false, error: "No model is chosen. Pick or type one in Settings, under AI assistance." });
      return;
    }
    setAi({ loading: true, note: "Fetching study details via DOI (abstract + open-access full text)…" });
    try {
      const context = reviewContext(project);
      let filled = 0;
      const unmatched: string[] = [];
      let lastOut = "";

      // Enrich each study by DOI: pull a fuller abstract and an open-access
      // full-text excerpt so the model judges bias from the methods, not the
      // title. Cached in stepData so re-runs don't re-fetch.
      const cached = ((useProject.getState().project?.stepData[stepId] as StepData)?.evidence as Record<string, StudyEvidence>) ?? {};
      const toFetch = studies.filter((s) => !cached[s.id]);
      const evidence: Record<string, StudyEvidence> = { ...cached };
      if (toFetch.length > 0) {
        const fetched = await enrichStudies(
          toFetch.map((s) => s.record),
          (done, total) => setAi({ loading: true, note: `Fetching study details via DOI… ${done}/${total}` }),
        );
        for (const [id, ev] of fetched) evidence[id] = ev;
        setField(stepId, "evidence", evidence);
        await persist();
      }
      const enrichedCount = studies.filter((s) => (evidence[s.id]?.sources.length ?? 0) > 0).length;
      setAi({ loading: true, note: "Assessing risk of bias…" });

      // Smaller batches than a title-only run: full-text excerpts are large, so
      // fewer studies per request keeps each JSON response within the budget.
      const BATCH = 6;
      const batches: IncludedStudy[][] = [];
      for (let i = 0; i < studies.length; i += BATCH) batches.push(studies.slice(i, i + BATCH));

      /** Match a parsed judgement to a study by number, label, or position. */
      const findMatch = (ref: string | number | undefined, batch: IncludedStudy[], idx: number): IncludedStudy | null => {
        const asNum = typeof ref === "number" ? ref : /^\s*\d+\s*$/.test(String(ref ?? "")) ? Number(ref) : NaN;
        if (Number.isInteger(asNum) && asNum >= 1 && asNum <= batch.length) return batch[asNum - 1];
        const r = String(ref ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
        if (r) {
          const m = batch.find((s) => {
            const lab = s.label.toLowerCase().replace(/[^a-z0-9]/g, "");
            return lab && (lab === r || lab.includes(r) || r.includes(lab));
          });
          if (m) return m;
        }
        // Positional fallback (model returned objects in order, no usable id).
        return ref == null && idx < batch.length ? batch[idx] : null;
      };

      for (const batch of batches) {
        const listing = batch
          .map((s, idx) => {
            const ev = evidence[s.id];
            const abs = (ev?.abstract ?? s.record.abstract ?? "").slice(0, 1500);
            const meta = [s.record.authors[0], s.record.year, s.record.doi && `doi:${s.record.doi}`].filter(Boolean).join(", ");
            const ft = ev?.fullText ? `\nfull-text excerpt (methods): ${ev.fullText.slice(0, 1800)}` : "";
            return `${idx + 1}. ${s.label}${meta ? ` (${meta})` : ""}\ntitle: ${s.record.title}\nabstract: ${abs || "(no abstract available)"}${ft}`;
          })
          .join("\n---\n");
        const user =
          "You are assessing risk of bias with RoB 2 (for randomised trials) for the INCLUDED studies of a systematic review. " +
          "Judge each study in the context of the whole review below. Base your judgement on the evidence provided for each study — its title, abstract, and (when available) an excerpt of the open-access full text retrieved via its DOI — not the title alone. Where a full-text excerpt is given, weigh it above the abstract.\n\n" +
          (context ? `REVIEW CONTEXT:\n${context}\n\n` : "") +
          "Domains: d1 randomisation process; d2 deviations from intended interventions; d3 missing outcome data; d4 measurement of the outcome; d5 selection of the reported result.\n" +
          'For EVERY study, judge ALL FIVE domains with one of "low", "some-concern", or "high". Where the available text gives no clear signal for a domain, use "some-concern".\n' +
          "Reference each study by its NUMBER (1, 2, 3, …) as the 'id'.\n" +
          'Return STRICT JSON ONLY — a JSON array, one compact object per study, no prose, no markdown: [{"id":1,"d1":"low","d2":"some-concern","d3":"high","d4":"some-concern","d5":"low","rationale":"1-2 short sentences citing the specific methods detail behind the key domain(s)"}].\n\n' +
          "STUDIES:\n" + listing;
        const out = await generateText(AI_SYSTEM_PROMPT, user, {
          provider: settings.llmProvider,
          apiKey: settings.llmKey,
          model: settings.llmModel,
          baseUrl: settings.llmBaseUrl,
          maxTokens: 4096,
        });
        lastOut = out;
        const parsed = parseAiJudgements(out);
        const live = ((useProject.getState().project?.stepData[stepId] as StepData)?.judgements as Judgements) ?? {};
        const liveRat = ((useProject.getState().project?.stepData[stepId] as StepData)?.robRationale as Rationales) ?? {};
        const next: Judgements = { ...live };
        const nextRat: Rationales = { ...liveRat };
        parsed.forEach((j, idx) => {
          const matchedStudy = findMatch(j.id, batch, idx);
          if (!matchedStudy) {
            unmatched.push(String(j.id ?? "?"));
            return;
          }
          const row = { ...next[matchedStudy.id] };
          // Fill every domain: AI value if given, else "some-concern"; never
          // overwrite a judgement the reviewer set manually.
          for (const d of DOMAINS) {
            if (!row[d.key]) row[d.key] = j.levels[d.key] ?? "some-concern";
          }
          next[matchedStudy.id] = row;
          if (j.rationale) nextRat[matchedStudy.id] = j.rationale;
          filled++;
        });
        setField(stepId, "judgements", next);
        setField(stepId, "robRationale", nextRat);
        setField(stepId, "nAppraised", recount(next));
        await persist();
      }
      if (filled === 0) {
        setAi({
          loading: false,
          error: `The AI responded but no judgements could be read from it. This usually means the model didn't return JSON. First 200 characters of its reply: “${lastOut.slice(0, 200).replace(/\s+/g, " ").trim()}”`,
        });
        return;
      }
      setAi({ loading: false, done: filled, enriched: enrichedCount, ...(unmatched.length > 0 ? { unmatched } : {}) });
      setSummaryOpen(true);
    } catch (e) {
      setAi({ loading: false, error: e instanceof Error ? e.message : "AI suggestion failed." });
    }
  };

  const hasAiSummary = Object.keys(rationales).length > 0;

  return (
    <div className="flex flex-col gap-3">
      {isDemo && (
        <p className="flex items-start gap-2 rounded-input bg-info-soft p-2.5 text-xs text-ink">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" aria-hidden="true" />
          Showing sample studies. Run the search and screening steps and your real included studies will appear here.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="num-tabular text-sm text-ink-soft">
          {studies.length} {studies.length === 1 ? "study" : "studies"} to appraise
        </span>
        {hasAiSummary && (
          <GlassButton variant="soft" size="sm" onClick={() => setSummaryOpen(true)} className={settings.hasLlm() ? "" : "ml-auto"}>
            <ClipboardList className="h-4 w-4" aria-hidden="true" /> View assessment summary
          </GlassButton>
        )}
        {settings.hasLlm() && (
          <GlassButton variant="soft" size="sm" onClick={suggest} loading={ai?.loading} className={hasAiSummary ? "" : "ml-auto"}>
            {!ai?.loading && <Sparkles className="h-4 w-4" aria-hidden="true" />}
            AI-assess all studies
          </GlassButton>
        )}
      </div>
      {ai?.loading && ai.note && (
        <p className="rounded-input bg-info-soft p-2.5 text-xs text-ink">{ai.note}</p>
      )}
      {ai?.done != null && (
        <p className="rounded-input bg-accent-soft/50 p-2.5 text-xs text-ink">
          AI assessed <strong>{ai.done}</strong> {ai.done === 1 ? "study" : "studies"} across all five RoB 2 domains
          {ai.enriched != null && ai.enriched > 0 && (
            <>, using the abstract and open-access full text fetched via DOI for <strong>{ai.enriched}</strong></>
          )}.{" "}
          {ai.unmatched && ai.unmatched.length > 0 && (
            <><strong>{ai.unmatched.length}</strong> could not be matched ({ai.unmatched.join(", ")}).{" "}</>
          )}
          These are a starting point: <strong>verify every judgement against the full text</strong>.{" "}
          <button onClick={() => setSummaryOpen(true)} className="font-medium text-primary underline underline-offset-2">
            View assessment summary
          </button>
        </p>
      )}
      {ai?.error && <p role="alert" className="rounded-input bg-danger-soft p-2.5 text-xs font-medium text-danger">{ai.error}</p>}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Risk-of-bias judgements by study and RoB 2 domain</caption>
          <thead>
            <tr className="text-ink-muted">
              <th scope="col" className="px-2 py-2 text-left font-medium">Study</th>
              {DOMAINS.map((d) => (
                <th key={d.key} scope="col" className="px-2 py-2 text-center font-medium" title={d.name}>
                  {d.code}
                </th>
              ))}
              <th scope="col" className="px-2 py-2 text-center font-medium">Overall</th>
            </tr>
          </thead>
          <tbody>
            {studies.map((s) => {
              const row = judgements[s.id];
              const ov = overall(row);
              return (
                <tr key={s.id} className="border-t border-hairline">
                  <th scope="row" className="px-2 py-2 text-left font-medium text-ink" title={s.record.title}>
                    {s.label}
                  </th>
                  {DOMAINS.map((d) => (
                    <td key={d.key} className="px-2 py-2 text-center">
                      <Cell
                        level={row?.[d.key]}
                        label={`${s.label}, ${d.name}`}
                        onClick={() => cycle(s.id, d.key)}
                      />
                    </td>
                  ))}
                  <td className="px-2 py-2 text-center">
                    {ov ? <Dot level={ov} title={`Overall: ${robVisual[ov].label}`} /> : <span className="text-ink-muted">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Legend />

      {summaryOpen && (
        <RobSummaryDialog
          studies={studies.filter((s) => rationales[s.id] || judgements[s.id])}
          judgements={judgements}
          rationales={rationales}
          evidence={evidence}
          projectTitle={project?.title ?? "Review"}
          onClose={() => setSummaryOpen(false)}
        />
      )}
    </div>
  );
}

/** Modal summary of the AI risk-of-bias assessment: one row per study with its
 *  per-domain judgements, overall rating, and the AI's reasoning. */
function RobSummaryDialog({
  studies,
  judgements,
  rationales,
  evidence,
  projectTitle,
  onClose,
}: {
  studies: IncludedStudy[];
  judgements: Judgements;
  rationales: Rationales;
  evidence: Record<string, StudyEvidence>;
  projectTitle: string;
  onClose: () => void;
}) {
  /** Short "based on" label for a study, e.g. "abstract + full text". */
  const basisOf = (id: string): string => {
    const src = evidence[id]?.sources ?? [];
    if (src.some((s) => /full text/i.test(s))) return "abstract + open-access full text";
    if (src.length) return "abstract";
    return "title/abstract";
  };
  // Build a Word-openable document (Word reads styled HTML saved as .doc) so the
  // reviewer keeps a record of the AI assessment and its reasoning.
  const downloadWord = async () => {
    const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const bg: Record<RobLevel, string> = { low: "#e6f4ea", "some-concern": "#fef7e0", high: "#fce8e6" };
    const head = `<tr><th>Study</th>${DOMAINS.map((d) => `<th>${d.code}</th>`).join("")}<th>Overall</th><th style="text-align:left">AI reasoning</th></tr>`;
    const rows = studies
      .map((s) => {
        const row = judgements[s.id];
        const ov = overall(row);
        const cells = DOMAINS.map((d) => {
          const lv = row?.[d.key];
          return `<td style="text-align:center;background:${lv ? bg[lv] : "#ffffff"}">${lv ? esc(robVisual[lv].label) : "—"}</td>`;
        }).join("");
        const reason = `${esc(rationales[s.id] ?? "—")}<br><span style="color:#888;font-size:8pt">Based on: ${esc(basisOf(s.id))}</span>`;
        return `<tr><td>${esc(s.label)}</td>${cells}<td style="text-align:center;background:${ov ? bg[ov] : "#ffffff"}">${ov ? esc(robVisual[ov].label) : "—"}</td><td>${reason}</td></tr>`;
      })
      .join("");
    const key = DOMAINS.map((d) => `<li><strong>${d.code}</strong>: ${esc(d.name)}</li>`).join("");
    const html =
      `<!DOCTYPE html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">` +
      `<head><meta charset="utf-8"><title>Risk-of-bias assessment</title></head>` +
      `<body style="font-family:Calibri,Arial,sans-serif;color:#1a1a1a">` +
      `<h1 style="font-size:18pt;margin:0 0 4px">Risk-of-bias assessment (RoB 2)</h1>` +
      `<p style="font-size:10pt;color:#666;margin:0 0 12px">${esc(projectTitle)} · Generated ${esc(new Date().toLocaleString())}</p>` +
      `<p style="background:#fff4e5;padding:8px;font-size:10pt">AI-suggested from each study's title, abstract, and (where available) the open-access full text retrieved via its DOI, in the review context. This is a <strong>draft to verify against the full text</strong>, not a final judgement.</p>` +
      `<table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-size:10pt;width:100%">` +
      `<thead>${head}</thead><tbody>${rows}</tbody></table>` +
      `<h2 style="font-size:12pt;margin-top:16px">Domain key</h2><ul style="font-size:10pt">${key}</ul>` +
      `</body></html>`;
    const slug = projectTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "review";
    await platform.saveFile(`${slug}-risk-of-bias.doc`, new Blob([html], { type: "application/msword" }));
  };

  return (
    <motion.div
      className="fixed inset-0 z-modal overflow-y-auto p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <button aria-label="Close" className="fixed inset-0 -z-10 bg-scrim" onClick={onClose} />
      <div className="mx-auto my-6 w-full max-w-4xl glass-2 glass-highlight rounded-modal p-5 sm:p-6">
        <div className="mb-3 flex items-center gap-2">
          <ClipboardList className="h-5 w-5 text-primary" aria-hidden="true" />
          <h2 className="mr-auto text-lg font-bold text-ink">AI risk-of-bias assessment</h2>
          <GlassButton variant="soft" size="sm" onClick={downloadWord}>
            <Download className="h-4 w-4" aria-hidden="true" /> Download (Word)
          </GlassButton>
          <GlassButton variant="ghost" size="sm" aria-label="Close" onClick={onClose} className="!px-2">
            <X className="h-5 w-5" aria-hidden="true" />
          </GlassButton>
        </div>
        <p className="mb-3 rounded-input bg-warning-soft p-2.5 text-xs text-ink">
          AI-suggested from each study's title, abstract, and (where available) the open-access full text retrieved via its
          DOI, in your review context. This is a <strong>draft to verify against the full text</strong>, not a final judgement.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-ink-muted">
                <th className="px-2 py-1.5 text-left font-medium">Study</th>
                {DOMAINS.map((d) => (
                  <th key={d.key} className="px-1.5 py-1.5 text-center font-medium" title={d.name}>{d.code}</th>
                ))}
                <th className="px-2 py-1.5 text-center font-medium">Overall</th>
                <th className="px-2 py-1.5 text-left font-medium">AI reasoning</th>
              </tr>
            </thead>
            <tbody>
              {studies.map((s) => {
                const row = judgements[s.id];
                const ov = overall(row);
                return (
                  <tr key={s.id} className="border-t border-hairline align-top">
                    <th scope="row" className="px-2 py-2 text-left font-medium text-ink" title={s.record.title}>{s.label}</th>
                    {DOMAINS.map((d) => (
                      <td key={d.key} className="px-1.5 py-2 text-center">
                        {row?.[d.key] ? <Dot level={row[d.key]} title={`${d.name}: ${robVisual[row[d.key]].label}`} /> : <span className="text-ink-muted">—</span>}
                      </td>
                    ))}
                    <td className="px-2 py-2 text-center">
                      {ov ? (
                        <span className="inline-flex items-center gap-1">
                          <Dot level={ov} /> <span className="text-xs text-ink-soft">{robVisual[ov].label}</span>
                        </span>
                      ) : <span className="text-ink-muted">—</span>}
                    </td>
                    <td className="px-2 py-2 text-ink-soft">
                      {rationales[s.id] ?? <span className="text-ink-muted">—</span>}
                      <span className="mt-0.5 block text-[11px] text-ink-muted">Based on: {basisOf(s.id)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
          <span>Legend:</span>
          {(["low", "some-concern", "high"] as RobLevel[]).map((l) => {
            const { icon: Icon, label, cls } = robVisual[l];
            return (
              <span key={l} className="inline-flex items-center gap-1">
                <Icon className={`h-3.5 w-3.5 ${cls}`} fill="currentColor" strokeWidth={1.5} aria-hidden="true" /> {label}
              </span>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}

function Cell({ level, label, onClick }: { level?: RobLevel; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={level ? `${label}: ${robVisual[level].label}. Click to change.` : `${label}: not yet judged. Click to set.`}
      className="grid h-8 w-8 place-items-center rounded-pill transition-colors hover:bg-primary-soft focus-visible:focus-ring"
    >
      {level ? <Dot level={level} /> : <span className="h-4 w-4 rounded-pill border border-dashed border-strong" aria-hidden="true" />}
    </button>
  );
}

function Dot({ level, title }: { level: RobLevel; title?: string }) {
  const { icon: Icon, cls } = robVisual[level];
  return (
    <span title={title} className="inline-flex">
      <Icon className={`mx-auto h-4 w-4 ${cls}`} fill="currentColor" strokeWidth={1.5} aria-hidden="true" />
    </span>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
      <span>Click a cell to cycle:</span>
      {(["low", "some-concern", "high"] as RobLevel[]).map((l) => {
        const { icon: Icon, label, cls } = robVisual[l];
        return (
          <span key={l} className="inline-flex items-center gap-1">
            <Icon className={`h-3.5 w-3.5 ${cls}`} fill="currentColor" strokeWidth={1.5} aria-hidden="true" />
            {label}
          </span>
        );
      })}
    </div>
  );
}
