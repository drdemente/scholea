/**
 * Optional gold-standard meta-analysis via WebR + metafor, loaded on demand
 * from a CDN. This cross-checks Scholea's validated JS random-effects engine
 * (meta.ts) against the reference implementation researchers cite. Never
 * bundled (`@vite-ignore` dynamic import); if it can't load, callers keep the
 * JS result.
 *
 * The address is the constant below and there is no setting for it. To load
 * WebR from somewhere else, change the constant and rebuild
 * (docs/deployment.md, section 1).
 */
const WEBR_URL = "https://webr.r-wasm.org/latest/webr.mjs";

interface WebRLike {
  init: () => Promise<void>;
  installPackages: (pkgs: string[]) => Promise<void>;
  evalRString: (code: string) => Promise<string>;
}

let instance: Promise<WebRLike> | null = null;

async function getWebR(): Promise<WebRLike> {
  if (!instance) {
    instance = (async () => {
      const mod = (await import(/* @vite-ignore */ WEBR_URL)) as { WebR: new () => WebRLike };
      const webR = new mod.WebR();
      await webR.init();
      await webR.installPackages(["metafor"]);
      return webR;
    })().catch((e) => {
      instance = null;
      throw e;
    });
  }
  return instance;
}

export interface WebRMeta {
  estimate: number;
  ciLow: number;
  ciHigh: number;
  i2: number;
  tau2: number;
}

/**
 * Random-effects (DerSimonian–Laird) pooling via metafor::rma, on the same
 * yi/vi (effect + variance) inputs the JS engine uses — so the numbers are
 * directly comparable.
 */
export async function webrRandomEffects(yi: number[], vi: number[]): Promise<WebRMeta> {
  const webR = await getWebR();
  const yiv = yi.map((x) => Number(x)).join(",");
  const viv = vi.map((x) => Number(x)).join(",");
  const code = `local({
    res <- metafor::rma(yi=c(${yiv}), vi=c(${viv}), method="DL")
    paste(res$b[1], res$ci.lb, res$ci.ub, res$I2, res$tau2, sep=",")
  })`;
  const out = await webR.evalRString(code);
  const [estimate, ciLow, ciHigh, i2, tau2] = out.split(",").map(Number);
  return { estimate, ciLow, ciHigh, i2, tau2 };
}
