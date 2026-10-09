import { useEffect, useState } from "react";
import { BookText, FlaskConical, Sparkles } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { useProject } from "@/lib/study/project-store";
import {
  welchTTest,
  pairedTTest,
  mannWhitneyU,
  oneWayAnova,
  pearson,
  linearRegression,
  chiSquare,
  fisherExact,
  twoByTwoEffects,
  descriptives,
  wilsonCI,
  parseNumbers,
  parseTable,
} from "@/lib/stats/general";
import { pyodideTest, type PyTest } from "@/lib/stats/pyodide";
import type { StepData } from "@/lib/study/types";

type TestId =
  | "welch" | "paired" | "mannwhitney" | "anova" | "pearson" | "linear"
  | "chisq" | "fisher" | "effects" | "descriptives" | "proportion";

const TESTS: { id: TestId; label: string }[] = [
  { id: "welch", label: "Two-sample t-test (Welch)" },
  { id: "paired", label: "Paired t-test" },
  { id: "mannwhitney", label: "Mann-Whitney U (non-parametric)" },
  { id: "anova", label: "One-way ANOVA" },
  { id: "pearson", label: "Pearson correlation" },
  { id: "linear", label: "Linear regression" },
  { id: "chisq", label: "Chi-square test (r×c counts)" },
  { id: "fisher", label: "Fisher's exact test (2×2)" },
  { id: "effects", label: "2×2 effects: OR / RR / risk difference" },
  { id: "descriptives", label: "Descriptive statistics" },
  { id: "proportion", label: "Proportion + 95% CI (Wilson)" },
];

/** Which tests the optional SciPy cross-check supports. */
const PY_TESTS = new Set<TestId>(["welch", "anova", "pearson", "linear"]);

const CITATION: Record<TestId, string> = {
  welch: "Welch's unequal-variances t-test (Welch, 1947). Effect size: Cohen's d (pooled SD).",
  paired: "Paired t-test on within-pair differences (Student, 1908). Effect size: Cohen's d_z.",
  mannwhitney:
    "Mann-Whitney U (Mann & Whitney, 1947): normal approximation with tie-corrected variance and continuity correction. For groups smaller than ~8, exact tables are preferable.",
  anova: "One-way analysis of variance (Fisher, 1925). Effect size: η² = SS_between / SS_total.",
  pearson: "Pearson product-moment correlation; two-tailed t-test on n−2 df.",
  linear: "Ordinary least-squares regression; t-test on the slope (n−2 df).",
  chisq:
    "Pearson's χ² test of independence (Pearson, 1900), no Yates correction. Assumes expected counts ≥ 5; use Fisher's exact when a 2×2 falls below that. Effect size: Cramér's V.",
  fisher: "Fisher's exact test, two-sided by summing tables as or less probable than the observed (Fisher, 1935).",
  effects:
    "Odds ratio, risk ratio, and risk difference with 95% CIs (log-normal for OR/RR, Wald for RD). Zero cells get the Haldane-Anscombe 0.5 correction.",
  descriptives: "Sample descriptives; quartiles use linear interpolation (type 7, R's default).",
  proportion: "Wilson score interval for a binomial proportion (Wilson, 1927), which has better coverage than the Wald interval.",
};

/** The conventional first analysis per study design (user can pick any test). */
const SUGGESTED: Record<string, TestId> = {
  "case-control": "effects",
  cohort: "effects",
  "cross-sectional": "chisq",
  survey: "descriptives",
  rct: "welch",
  "quasi-experimental": "welch",
};

const f = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "—");

/**
 * General statistics workspace — every common calculation built in, computed
 * automatically as soon as the inputs are valid (a manual Recompute stays
 * available), on Scholea's validated, reference-tested engine. The default test
 * is suggested from the study design; any calculation can be chosen manually.
 */
export function GeneralStatsTool({ stepId }: { stepId: string }) {
  const project = useProject((s) => s.project);
  const config = useProject((s) => s.config);
  const setField = useProject((s) => s.setField);
  const persist = useProject((s) => s.persist);
  const d = (project?.stepData[stepId] as StepData) ?? {};

  const suggested = (config && SUGGESTED[config.id]) || "welch";
  const test = ((d.gsTest as TestId) ?? suggested) as TestId;
  const [result, setResult] = useState<Record<string, number | boolean> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [py, setPy] = useState<{ loading: boolean; result?: Record<string, number>; error?: string } | null>(null);

  const val = (k: string) => (d[k] as string | undefined) ?? "";
  const set = (k: string, v: string) => setField(stepId, k, v);

  /** Parse the current inputs into the group arrays the classic tests need. */
  const groups = (): number[][] => {
    if (test === "welch" || test === "mannwhitney" || test === "paired") return [parseNumbers(val("gsA")), parseNumbers(val("gsB"))];
    if (test === "anova")
      return val("gsGroups")
        .split(/\n/)
        .map(parseNumbers)
        .filter((g) => g.length > 0);
    return [parseNumbers(val("gsX")), parseNumbers(val("gsY"))];
  };

  const cell = (k: string) => {
    const n = Number(val(k));
    if (val(k).trim() === "" || !Number.isFinite(n) || n < 0) throw new Error("Fill all four counts of the 2×2 table.");
    return n;
  };

  const compute = (): Record<string, number | boolean> => {
    if (test === "welch" || test === "mannwhitney" || test === "paired") {
      const [a, b] = groups();
      if (a.length < 2 || b.length < 2) throw new Error("Enter at least 2 values in each group.");
      if (test === "paired" && a.length !== b.length) throw new Error("Paired data: both lists need the same length.");
      const r = test === "welch" ? welchTTest(a, b) : test === "paired" ? pairedTTest(a, b) : mannWhitneyU(a, b);
      return r as unknown as Record<string, number | boolean>;
    }
    if (test === "anova") {
      const g = groups();
      if (g.length < 2) throw new Error("Enter at least 2 groups (one per line).");
      return oneWayAnova(g) as unknown as Record<string, number | boolean>;
    }
    if (test === "pearson" || test === "linear") {
      const [x, y] = groups();
      if (x.length !== y.length || x.length < 3) throw new Error("X and Y must be paired and have ≥ 3 points.");
      return (test === "pearson" ? pearson(x, y) : linearRegression(x, y)) as unknown as Record<string, number | boolean>;
    }
    if (test === "chisq") {
      return chiSquare(parseTable(val("gsTable"))) as unknown as Record<string, number | boolean>;
    }
    if (test === "fisher" || test === "effects") {
      const [a, b, c, dd] = [cell("gsA11"), cell("gsA12"), cell("gsA21"), cell("gsA22")];
      return (test === "fisher" ? fisherExact(a, b, c, dd) : twoByTwoEffects(a, b, c, dd)) as unknown as Record<string, number | boolean>;
    }
    if (test === "descriptives") {
      const xs = parseNumbers(val("gsVals"));
      if (xs.length < 2) throw new Error("Enter at least 2 values.");
      return descriptives(xs) as unknown as Record<string, number | boolean>;
    }
    // proportion
    const k = Number(val("gsK"));
    const n = Number(val("gsN"));
    if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0 || k < 0 || k > n) {
      throw new Error("Enter events (k) and total (n) with 0 ≤ k ≤ n.");
    }
    return wilsonCI(k, n) as unknown as Record<string, number | boolean>;
  };

  const run = (manual = false) => {
    setPy(null);
    try {
      setResult(compute());
      setError(null);
    } catch (e) {
      setResult(null);
      setError(manual ? (e instanceof Error ? e.message : "Could not compute.") : null);
    }
  };

  // Auto-compute whenever the inputs (or the chosen test) change and are valid.
  const inputKey = [test, val("gsA"), val("gsB"), val("gsGroups"), val("gsX"), val("gsY"), val("gsTable"), val("gsA11"), val("gsA12"), val("gsA21"), val("gsA22"), val("gsVals"), val("gsK"), val("gsN")].join("\u0000");
  useEffect(() => {
    run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey]);

  const crossCheck = async () => {
    setPy({ loading: true });
    try {
      const r = await pyodideTest(test as PyTest, groups());
      setPy({ loading: false, result: r });
    } catch {
      setPy({ loading: false, error: "The SciPy cross-check could not be loaded. It is fetched from the internet when you ask for it. The result shown here does not depend on it." });
    }
  };

  const ta = (k: string, label: string, rows = 2) => (
    <div>
      <label className="text-xs font-medium text-ink-soft">{label}</label>
      <textarea
        rows={rows}
        value={val(k)}
        aria-label={label}
        onChange={(e) => set(k, e.target.value)}
        onBlur={() => void persist()}
        placeholder="numbers, separated by spaces or commas"
        className="mt-1 w-full rounded-input border border-hairline bg-elevated/70 px-3 py-2 font-mono text-sm text-ink outline-none focus-visible:focus-ring"
      />
    </div>
  );

  const numCell = (k: string, label: string) => (
    <div className="flex flex-col gap-0.5">
      <label className="text-[11px] text-ink-muted">{label}</label>
      <input
        inputMode="numeric"
        value={val(k)}
        aria-label={label}
        onChange={(e) => set(k, e.target.value.replace(/[^0-9]/g, ""))}
        onBlur={() => void persist()}
        className="num-tabular w-24 rounded-input border border-hairline bg-elevated/70 px-2 py-1.5 text-sm text-ink outline-none focus-visible:focus-ring"
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="gs-test" className="text-sm font-medium text-ink">Calculation</label>
          {test === suggested && config && (
            <span className="inline-flex items-center gap-1 rounded-pill bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">
              <Sparkles className="h-3 w-3" aria-hidden="true" /> Suggested for {config.label}
            </span>
          )}
        </div>
        <select
          id="gs-test"
          value={test}
          onChange={(e) => {
            setField(stepId, "gsTest", e.target.value);
            setResult(null);
            setError(null);
            setPy(null);
            void persist();
          }}
          className="mt-1 w-full rounded-input border border-hairline bg-elevated/70 px-3 py-2 text-base text-ink outline-none focus-visible:focus-ring"
        >
          {TESTS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </div>

      {(test === "welch" || test === "mannwhitney") && (
        <div className="grid gap-3 sm:grid-cols-2">{ta("gsA", "Group A")}{ta("gsB", "Group B")}</div>
      )}
      {test === "paired" && (
        <div className="grid gap-3 sm:grid-cols-2">{ta("gsA", "Before (per participant)")}{ta("gsB", "After (same order)")}</div>
      )}
      {test === "anova" && ta("gsGroups", "Groups (one per line)", 4)}
      {(test === "pearson" || test === "linear") && (
        <div className="grid gap-3 sm:grid-cols-2">{ta("gsX", "X")}{ta("gsY", "Y (paired with X)")}</div>
      )}
      {test === "chisq" && ta("gsTable", "Contingency table: counts, one row per line", 3)}
      {(test === "fisher" || test === "effects") && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-ink-soft">2×2 counts (rows: exposed / unexposed · columns: outcome yes / no)</p>
          <div className="grid w-fit grid-cols-2 gap-2">
            {numCell("gsA11", "Exposed, outcome+")}
            {numCell("gsA12", "Exposed, outcome−")}
            {numCell("gsA21", "Unexposed, outcome+")}
            {numCell("gsA22", "Unexposed, outcome−")}
          </div>
        </div>
      )}
      {test === "descriptives" && ta("gsVals", "Values", 3)}
      {test === "proportion" && (
        <div className="flex flex-wrap gap-3">{numCell("gsK", "Events (k)")}{numCell("gsN", "Total (n)")}</div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <GlassButton size="sm" variant="soft" onClick={() => run(true)}>
          Recompute
        </GlassButton>
        {result && PY_TESTS.has(test) && (
          <GlassButton size="sm" variant="ghost" onClick={crossCheck} loading={py?.loading}>
            <FlaskConical className="h-4 w-4" aria-hidden="true" /> Cross-check with SciPy
          </GlassButton>
        )}
        <span className="text-xs text-ink-muted">Results update automatically as you type.</span>
      </div>

      {error && <p role="alert" className="rounded-input bg-danger-soft p-3 text-sm font-medium text-danger">{error}</p>}

      {result && (
        <div className="rounded-input border border-hairline bg-elevated/40 p-3 text-sm" aria-live="polite">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
            {test === "welch" && (<>
              <Stat k="t" v={f(result.t as number)} /><Stat k="df" v={f(result.df as number, 2)} /><Stat k="p" v={f(result.p as number, 4)} />
              <Stat k="mean diff" v={f(result.meanDiff as number)} /><Stat k="Cohen's d" v={f(result.cohenD as number)} />
            </>)}
            {test === "paired" && (<>
              <Stat k="t" v={f(result.t as number)} /><Stat k="df" v={f(result.df as number, 0)} /><Stat k="p" v={f(result.p as number, 4)} />
              <Stat k="mean diff" v={f(result.meanDiff as number)} /><Stat k="dz" v={f(result.dz as number)} />
            </>)}
            {test === "mannwhitney" && (<>
              <Stat k="U" v={f(result.U as number, 1)} /><Stat k="z" v={f(result.z as number)} /><Stat k="p" v={f(result.p as number, 4)} />
              <Stat k="rank-biserial r" v={f(result.rankBiserial as number)} />
            </>)}
            {test === "anova" && (<>
              <Stat k="F" v={f(result.F as number)} /><Stat k="df" v={`${result.df1}, ${result.df2}`} /><Stat k="p" v={f(result.p as number, 4)} />
              <Stat k="η²" v={f(result.etaSq as number)} />
            </>)}
            {test === "pearson" && (<>
              <Stat k="r" v={f(result.r as number)} /><Stat k="df" v={f(result.df as number, 0)} /><Stat k="p" v={f(result.p as number, 4)} />
            </>)}
            {test === "linear" && (<>
              <Stat k="slope" v={f(result.slope as number)} /><Stat k="intercept" v={f(result.intercept as number)} /><Stat k="R²" v={f(result.r2 as number)} />
              <Stat k="p (slope)" v={f(result.p as number, 4)} />
            </>)}
            {test === "chisq" && (<>
              <Stat k="χ²" v={f(result.chi2 as number)} /><Stat k="df" v={f(result.df as number, 0)} /><Stat k="p" v={f(result.p as number, 4)} />
              <Stat k="Cramér's V" v={f(result.cramersV as number)} /><Stat k="min expected" v={f(result.minExpected as number, 1)} />
            </>)}
            {test === "fisher" && (<>
              <Stat k="p (two-sided)" v={f(result.p as number, 4)} /><Stat k="odds ratio" v={f(result.oddsRatio as number)} /><Stat k="n" v={f(result.n as number, 0)} />
            </>)}
            {test === "effects" && (<>
              <Stat k="OR (95% CI)" v={`${f(result.oddsRatio as number, 2)} (${f(result.orCiLow as number, 2)}–${f(result.orCiHigh as number, 2)})`} />
              <Stat k="RR (95% CI)" v={`${f(result.riskRatio as number, 2)} (${f(result.rrCiLow as number, 2)}–${f(result.rrCiHigh as number, 2)})`} />
              <Stat k="RD (95% CI)" v={`${f(result.riskDiff as number, 3)} (${f(result.rdCiLow as number, 3)}–${f(result.rdCiHigh as number, 3)})`} />
            </>)}
            {test === "descriptives" && (<>
              <Stat k="n" v={f(result.n as number, 0)} /><Stat k="mean" v={f(result.mean as number)} /><Stat k="SD" v={f(result.sd as number)} />
              <Stat k="median" v={f(result.median as number)} /><Stat k="IQR" v={`${f(result.q1 as number, 2)}–${f(result.q3 as number, 2)}`} />
              <Stat k="range" v={`${f(result.min as number, 2)}–${f(result.max as number, 2)}`} />
            </>)}
            {test === "proportion" && (<>
              <Stat k="proportion" v={f(result.p as number, 4)} /><Stat k="95% CI" v={`${f(result.ciLow as number, 4)}–${f(result.ciHigh as number, 4)}`} />
              <Stat k="k / n" v={`${result.k} / ${result.n}`} />
            </>)}
          </dl>
          {test === "chisq" && (result.minExpected as number) < 5 && (
            <p className="mt-2 rounded-input bg-warning-soft px-2.5 py-1.5 text-xs text-ink">
              An expected cell count is below 5, so the χ² approximation is shaky here. For a 2×2, prefer Fisher's exact test.
            </p>
          )}
          {test === "effects" && result.corrected === true && (
            <p className="mt-2 rounded-input bg-warning-soft px-2.5 py-1.5 text-xs text-ink">
              A zero cell was corrected (Haldane-Anscombe +0.5). Interpret the estimates cautiously.
            </p>
          )}
          {py?.result && (
            <p className="mt-2 rounded-input bg-success-soft px-2.5 py-1.5 text-xs text-ink">
              SciPy agrees: {test === "linear" ? `slope ${f(py.result.slope)}, ` : `statistic ${f(py.result.statistic)}, `}p = {f(py.result.p, 4)}
            </p>
          )}
          {py?.error && <p className="mt-2 text-xs text-ink-muted">{py.error}</p>}
        </div>
      )}

      <details className="rounded-input bg-elevated/40 p-3 text-sm">
        <summary className="flex cursor-pointer items-center gap-2 font-semibold text-ink">
          <BookText className="h-4 w-4 text-primary" aria-hidden="true" /> Method &amp; citation
        </summary>
        <p className="mt-2 text-ink-soft">{CITATION[test]}</p>
        <p className="mt-1 text-xs text-ink-muted">
          Computed by Scholea's validated JS engine (reference-tested). SciPy cross-check is optional and requires a browser.
        </p>
      </details>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{k}</dt>
      <dd className="num-tabular font-semibold text-ink">{v}</dd>
    </div>
  );
}
