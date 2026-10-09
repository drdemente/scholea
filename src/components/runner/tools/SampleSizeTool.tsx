import { BookText, Calculator } from "lucide-react";
import { useProject } from "@/lib/study/project-store";
import {
  adjustN,
  ssOneProportion,
  ssOneMean,
  ssTwoProportions,
  ssTwoMeans,
  ssCaseControl,
  ssCohortRR,
  ssDiagnostic,
} from "@/lib/stats/sample-size";
import type { StepData } from "@/lib/study/types";

type Scenario =
  | "one-proportion" | "one-mean" | "two-proportions" | "two-means"
  | "case-control" | "cohort-rr" | "diagnostic";

const SCENARIOS: { id: Scenario; label: string }[] = [
  { id: "one-proportion", label: "Estimate a proportion / prevalence" },
  { id: "one-mean", label: "Estimate a mean" },
  { id: "two-proportions", label: "Compare two proportions" },
  { id: "two-means", label: "Compare two means" },
  { id: "case-control", label: "Case-control (odds ratio)" },
  { id: "cohort-rr", label: "Cohort (relative risk)" },
  { id: "diagnostic", label: "Diagnostic accuracy (sensitivity / specificity)" },
];

/** The conventional starting scenario for each study design. */
const DEFAULT_SCENARIO: Record<string, Scenario> = {
  "cross-sectional": "one-proportion",
  survey: "one-proportion",
  "diagnostic-accuracy": "diagnostic",
  rct: "two-means",
  "quasi-experimental": "two-means",
  cohort: "cohort-rr",
  "case-control": "case-control",
  animal: "two-means",
};

const isTwoGroup = (s: Scenario) =>
  s === "two-proportions" || s === "two-means" || s === "case-control" || s === "cohort-rr";

const CITATION: Record<Scenario, string> = {
  "one-proportion": "n = Z²·P(1−P)/d² (Lwanga & Lemeshow, WHO 1991). d is the absolute precision (half-width of the CI).",
  "one-mean": "n = Z²·σ²/d² (WHO 1991). σ is the anticipated standard deviation; d the absolute precision.",
  "two-proportions": "Two-proportion test with allocation ratio (Fleiss). n per group for the difference P₁−P₂ at the chosen α and power.",
  "two-means": "Two-means test: n₁ = (Z_{1−α/2}+Z_{1−β})²·(σ₁²+σ₂²/r)/(μ₁−μ₂)²; r is the allocation ratio.",
  "case-control": "Exposed proportion in cases derived from the control exposure and OR, then the two-proportion formula (WHO 1991).",
  "cohort-rr": "Exposed incidence derived from the unexposed incidence and RR, then the two-proportion formula (WHO 1991).",
  "diagnostic": "n_withCondition = Z²·Sn(1−Sn)/d², total = n/prevalence (Buderer, 1996).",
};

/**
 * WHO sample-size calculator. Picks the design's usual scenario by default; the
 * researcher can switch to any of the seven. Every input persists to the step,
 * results update live, and the method + citation is always shown. Design effect,
 * non-response, and (for descriptive samples) the finite-population correction
 * are applied on top of the core formula.
 */
export function SampleSizeTool({ stepId }: { stepId: string }) {
  const project = useProject((s) => s.project);
  const config = useProject((s) => s.config);
  const setField = useProject((s) => s.setField);
  const persist = useProject((s) => s.persist);
  const d = (project?.stepData[stepId] as StepData) ?? {};

  const fallback = (config && DEFAULT_SCENARIO[config.id]) || "one-proportion";
  const scenario = ((d.ssScenario as Scenario) ?? fallback) as Scenario;

  const val = (k: string, dflt = "") => (d[k] != null ? String(d[k]) : dflt);
  const set = (k: string, v: string) => {
    setField(stepId, k, v);
    void persist();
  };
  const nreq = (k: string, dflt = "") => Number(val(k, dflt));

  const conf = () => Math.min(0.999, Math.max(0.5, nreq("ssConf", "95") / 100));
  const pow = () => Math.min(0.999, Math.max(0.5, nreq("ssPower", "80") / 100));
  const adj = () => ({
    designEffect: val("ssDeff") ? nreq("ssDeff") : 1,
    nonResponse: val("ssNr") ? nreq("ssNr") / 100 : 0,
    population: val("ssPop") ? nreq("ssPop") : undefined,
  });

  // --- Compute (returns a small structured result or an error string) --------
  let result: { total?: number; g1?: number; g2?: number; extra?: string } | null = null;
  let error: string | null = null;
  try {
    if (scenario === "one-proportion") {
      const p = nreq("ssP", "0.5"), prec = nreq("ssD", "0.05");
      if (!(p > 0 && p < 1) || !(prec > 0)) throw 0;
      result = { total: adjustN(ssOneProportion(p, prec, conf()), adj()) };
    } else if (scenario === "one-mean") {
      const sd = nreq("ssSd", ""), prec = nreq("ssD", "");
      if (!(sd > 0) || !(prec > 0)) throw 0;
      result = { total: adjustN(ssOneMean(sd, prec, conf()), adj()) };
    } else if (scenario === "diagnostic") {
      const sn = nreq("ssSn", "0.9"), prec = nreq("ssD", "0.05"), prev = nreq("ssPrev", "");
      if (!(sn > 0 && sn < 1) || !(prec > 0) || !(prev > 0 && prev <= 1)) throw 0;
      const r = ssDiagnostic(sn, prec, prev, conf());
      result = { total: adjustN(r.total, adj()), extra: `${Math.ceil(r.withCondition)} with the condition` };
    } else {
      const ratio = val("ssRatio") ? nreq("ssRatio") : 1;
      let g: { n1: number; n2: number };
      if (scenario === "two-proportions") {
        const p1 = nreq("ssP1", "0.5"), p2 = nreq("ssP2", "0.3");
        if (![p1, p2].every((x) => x > 0 && x < 1) || p1 === p2) throw 0;
        g = ssTwoProportions(p1, p2, conf(), pow(), ratio);
      } else if (scenario === "two-means") {
        const sd1 = nreq("ssSd1", ""), sd2 = nreq("ssSd2", val("ssSd1")), diff = nreq("ssDiff", "");
        if (!(sd1 > 0) || !(sd2 > 0) || !(Math.abs(diff) > 0)) throw 0;
        g = ssTwoMeans(sd1, sd2, diff, conf(), pow(), ratio);
      } else if (scenario === "case-control") {
        const p0 = nreq("ssP0", "0.3"), or = nreq("ssOr", "2");
        if (!(p0 > 0 && p0 < 1) || !(or > 0) || or === 1) throw 0;
        g = ssCaseControl(p0, or, conf(), pow(), ratio);
      } else {
        const p0 = nreq("ssP0", "0.1"), rr = nreq("ssRr", "2");
        if (!(p0 > 0 && p0 < 1) || !(rr > 0) || rr === 1) throw 0;
        g = ssCohortRR(p0, rr, conf(), pow(), ratio);
      }
      const n1 = adjustN(g.n1, adj(), true);
      const n2 = adjustN(g.n2, adj(), true);
      result = { g1: n1, g2: n2, total: n1 + n2 };
    }
  } catch {
    error = "Fill in the fields above (proportions between 0 and 1, positive precision / SD / effect).";
  }

  const twoGroup = isTwoGroup(scenario);
  const g1Label = scenario === "case-control" ? "cases" : scenario === "cohort-rr" ? "exposed" : "group 1";
  const g2Label = scenario === "case-control" ? "controls" : scenario === "cohort-rr" ? "unexposed" : "group 2";

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label htmlFor="ss-scenario" className="text-sm font-medium text-ink">What are you calculating?</label>
        <select
          id="ss-scenario"
          value={scenario}
          onChange={(e) => set("ssScenario", e.target.value)}
          className="mt-1 w-full rounded-input border border-hairline bg-elevated/70 px-3 py-2 text-base text-ink outline-none focus-visible:focus-ring"
        >
          {SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </div>

      {/* Scenario-specific inputs */}
      <div className="grid gap-3 sm:grid-cols-2">
        {scenario === "one-proportion" && (<>
          <Num k="ssP" label="Expected proportion P (0–1)" dflt="0.5" v={val} set={set} />
          <Num k="ssD" label="Absolute precision d (± , 0–1)" dflt="0.05" v={val} set={set} />
        </>)}
        {scenario === "one-mean" && (<>
          <Num k="ssSd" label="Anticipated SD (σ)" v={val} set={set} />
          <Num k="ssD" label="Absolute precision d (± units)" v={val} set={set} />
        </>)}
        {scenario === "diagnostic" && (<>
          <Num k="ssSn" label="Expected sensitivity/specificity (0–1)" dflt="0.9" v={val} set={set} />
          <Num k="ssD" label="Absolute precision d (± , 0–1)" dflt="0.05" v={val} set={set} />
          <Num k="ssPrev" label="Disease prevalence (0–1)" v={val} set={set} />
        </>)}
        {scenario === "two-proportions" && (<>
          <Num k="ssP1" label="Proportion in group 1 (0–1)" dflt="0.5" v={val} set={set} />
          <Num k="ssP2" label="Proportion in group 2 (0–1)" dflt="0.3" v={val} set={set} />
        </>)}
        {scenario === "two-means" && (<>
          <Num k="ssSd1" label="SD group 1 (σ₁)" v={val} set={set} />
          <Num k="ssSd2" label="SD group 2 (σ₂, blank = same)" v={val} set={set} />
          <Num k="ssDiff" label="Difference to detect (μ₁−μ₂)" v={val} set={set} />
        </>)}
        {scenario === "case-control" && (<>
          <Num k="ssP0" label="Exposure prevalence in controls (0–1)" dflt="0.3" v={val} set={set} />
          <Num k="ssOr" label="Odds ratio to detect" dflt="2" v={val} set={set} />
        </>)}
        {scenario === "cohort-rr" && (<>
          <Num k="ssP0" label="Incidence in unexposed (0–1)" dflt="0.1" v={val} set={set} />
          <Num k="ssRr" label="Relative risk to detect" dflt="2" v={val} set={set} />
        </>)}
      </div>

      {/* Confidence / power / ratio */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Num k="ssConf" label="Confidence level (%)" dflt="95" v={val} set={set} />
        {twoGroup && <Num k="ssPower" label="Power (%)" dflt="80" v={val} set={set} />}
        {twoGroup && <Num k="ssRatio" label={`Allocation ratio (${g2Label} : ${g1Label})`} dflt="1" v={val} set={set} />}
      </div>

      {/* Adjustments */}
      <details className="rounded-input bg-elevated/40 p-3 text-sm">
        <summary className="cursor-pointer font-semibold text-ink">Adjustments (optional)</summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          <Num k="ssDeff" label="Design effect (cluster)" dflt="1" v={val} set={set} />
          <Num k="ssNr" label="Expected non-response (%)" dflt="0" v={val} set={set} />
          {!twoGroup && <Num k="ssPop" label="Finite population size (optional)" v={val} set={set} />}
        </div>
      </details>

      {/* Result */}
      {error ? (
        <p className="rounded-input bg-info-soft p-3 text-sm text-ink">
          <Calculator className="mr-1.5 inline h-4 w-4" aria-hidden="true" />
          {error}
        </p>
      ) : result ? (
        <div className="rounded-input border border-primary/40 bg-primary-soft/30 p-4">
          {twoGroup ? (
            <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
              <Big label={`Per group (${g1Label})`} value={result.g1!} />
              <Big label={`Per group (${g2Label})`} value={result.g2!} />
              <Big label="Total" value={result.total!} accent />
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
              <Big label="Required sample size" value={result.total!} accent />
              {result.extra && <p className="text-sm text-ink-soft">({result.extra})</p>}
            </div>
          )}
          <p className="mt-2 text-xs text-ink-muted">
            Rounded up. Includes any design effect, non-response inflation{!twoGroup ? ", and finite-population correction" : ""} you set.
          </p>
        </div>
      ) : null}

      <details className="rounded-input bg-elevated/40 p-3 text-sm">
        <summary className="flex cursor-pointer items-center gap-2 font-semibold text-ink">
          <BookText className="h-4 w-4 text-primary" aria-hidden="true" /> Method &amp; citation
        </summary>
        <p className="mt-2 text-ink-soft">{CITATION[scenario]}</p>
        <p className="mt-1 text-xs text-ink-muted">
          Z values from the inverse-normal (probit); validated against WHO/Lemeshow reference values. This is a planning
          estimate — check the assumptions with your supervisor/statistician.
        </p>
      </details>
    </div>
  );
}

function Num({ k, label, dflt = "", v, set }: { k: string; label: string; dflt?: string; v: (k: string, d?: string) => string; set: (k: string, val: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-ink-soft">
      {label}
      <input
        inputMode="decimal"
        value={v(k, dflt)}
        onChange={(e) => set(k, e.target.value)}
        className="num-tabular rounded-input border border-hairline bg-elevated/70 px-2.5 py-1.5 text-sm text-ink outline-none focus-visible:focus-ring"
      />
    </label>
  );
}

function Big({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div>
      <p className={`num-tabular text-2xl font-bold ${accent ? "text-primary" : "text-ink"}`}>
        {Number.isFinite(value) ? value.toLocaleString() : "—"}
      </p>
      <p className="text-xs text-ink-muted">{label}</p>
    </div>
  );
}
