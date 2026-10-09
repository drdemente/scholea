/**
 * Optional gold-standard stats via Pyodide + SciPy, loaded on demand from a
 * CDN. This is a cross-check layer over the validated JS engine in general.ts;
 * if Pyodide can't load, callers fall back to JS. Never bundled (dynamic
 * `import` is `@vite-ignore`d), so it never bloats the app or breaks the
 * offline core.
 *
 * The address is built from the two constants below and there is no setting
 * for it. To load Pyodide from somewhere else, change them and rebuild
 * (docs/deployment.md, section 1).
 */
const VERSION = "v0.26.4";
const INDEX_URL = `https://cdn.jsdelivr.net/pyodide/${VERSION}/full/`;

interface PyodideLike {
  loadPackage: (pkgs: string[]) => Promise<void>;
  globals: { set: (k: string, v: unknown) => void };
  runPythonAsync: (code: string) => Promise<string>;
}

let instance: Promise<PyodideLike> | null = null;

async function getPyodide(): Promise<PyodideLike> {
  if (!instance) {
    instance = (async () => {
      const mod = (await import(/* @vite-ignore */ `${INDEX_URL}pyodide.mjs`)) as {
        loadPyodide: (o: { indexURL: string }) => Promise<PyodideLike>;
      };
      const py = await mod.loadPyodide({ indexURL: INDEX_URL });
      await py.loadPackage(["numpy", "scipy"]);
      return py;
    })().catch((e) => {
      instance = null; // allow retry after a failure
      throw e;
    });
  }
  return instance;
}

export type PyTest = "welch" | "anova" | "pearson" | "linear";

/** Run one test through SciPy and return {statistic, p, ...} — for cross-checking. */
export async function pyodideTest(test: PyTest, groups: number[][]): Promise<Record<string, number>> {
  const py = await getPyodide();
  py.globals.set("groups", groups);
  const code: Record<PyTest, string> = {
    welch: `
import json, numpy as np, scipy.stats as st
g = [np.array(x, dtype=float) for x in groups.to_py()]
r = st.ttest_ind(g[0], g[1], equal_var=False)
json.dumps({"statistic": float(r.statistic), "p": float(r.pvalue)})`,
    anova: `
import json, numpy as np, scipy.stats as st
g = [np.array(x, dtype=float) for x in groups.to_py()]
r = st.f_oneway(*g)
json.dumps({"statistic": float(r.statistic), "p": float(r.pvalue)})`,
    pearson: `
import json, numpy as np, scipy.stats as st
g = [np.array(x, dtype=float) for x in groups.to_py()]
r = st.pearsonr(g[0], g[1])
json.dumps({"statistic": float(r.statistic), "p": float(r.pvalue)})`,
    linear: `
import json, numpy as np, scipy.stats as st
g = [np.array(x, dtype=float) for x in groups.to_py()]
r = st.linregress(g[0], g[1])
json.dumps({"slope": float(r.slope), "intercept": float(r.intercept), "r2": float(r.rvalue**2), "p": float(r.pvalue)})`,
  };
  return JSON.parse(await py.runPythonAsync(code[test])) as Record<string, number>;
}
