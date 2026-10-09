import type { HttpResponse, PlatformAdapter } from "./types";

/**
 * Web adapter, and the base of the desktop one (see `index.ts`). CORS-friendly
 * APIs (OpenAlex, Crossref, Europe PMC, ClinicalTrials.gov) are called
 * directly. PubMed E-utilities is not CORS-enabled, so on the web it goes
 * through the proxy whose address the person enters in Settings.
 *
 * `secureGet` and `secureSet` are a plain local-only store. Browser storage is
 * not a keystore, and nothing encrypts the value on the way in: the settings
 * store passes each API key as typed. Anyone who can use the same browser
 * profile or desktop user account can read them, and the docs say so.
 */
export const webAdapter: PlatformAdapter = {
  async http(url, init) {
    const res = await fetch(url, init);
    return wrap(res);
  },

  async saveFile(filename, data) {
    const blob = typeof data === "string" ? new Blob([data]) : data;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  async secureGet(key) {
    return localStorage.getItem(`scholea.secure.${key}`);
  },
  async secureSet(key, value) {
    localStorage.setItem(`scholea.secure.${key}`, value);
  },
};

function wrap(res: Response): HttpResponse {
  return {
    ok: res.ok,
    status: res.status,
    json: <T>() => res.json() as Promise<T>,
    text: () => res.text(),
  };
}
