/**
 * Settings store — BYO-key configuration. Non-secret preferences (contact
 * email, enabled sources, LLM provider/model) live in Dexie; API keys go
 * through the platform secure store (never the audit log, never Dexie). Keys are
 * per-user and entered by the user — Scholea never ships a shared key.
 */
import { create } from "zustand";
import { db } from "@/lib/db/schema";
import { platform } from "@/lib/platform";
import type { SearchOptions, SearchSourceId } from "@/lib/sources/types";

export type SecretKey = "ncbiKey" | "openAlexKey" | "llmKey";
export type LlmProvider = "none" | "anthropic" | "openai";

const DEFAULT_SOURCES: SearchSourceId[] = ["europepmc", "crossref", "openalex"];

interface SettingsState {
  loaded: boolean;
  contactEmail: string;
  enabledSources: SearchSourceId[];
  ncbiKey: string;
  openAlexKey: string;
  /** Proxy base URL that fronts PubMed E-utilities on the web build. */
  pubmedProxy: string;

  // Optional AI guidance layer (provider-agnostic; core works without it).
  llmProvider: LlmProvider;
  llmModel: string;
  llmBaseUrl: string;
  llmKey: string;
  /** When true, pick the model from a live-fetched list; manual entry is off. */
  llmAutoModels: boolean;
  /** The last-fetched list of available models (persisted so it survives reopen). */
  llmModels: string[];

  load: () => Promise<void>;
  setContactEmail: (v: string) => Promise<void>;
  setPubmedProxy: (v: string) => Promise<void>;
  toggleSource: (id: SearchSourceId) => Promise<void>;
  setSecret: (which: SecretKey, value: string) => Promise<void>;
  setLlmProvider: (p: LlmProvider) => Promise<void>;
  setLlmModel: (m: string) => Promise<void>;
  setLlmBaseUrl: (u: string) => Promise<void>;
  setLlmAutoModels: (v: boolean) => Promise<void>;
  setLlmModels: (list: string[]) => Promise<void>;
  /** True when an LLM is configured and usable. */
  hasLlm: () => boolean;
  optionsFor: (id: SearchSourceId, extra?: Partial<SearchOptions>) => SearchOptions;
}

const DEFAULT_MODEL: Record<LlmProvider, string> = {
  none: "",
  anthropic: "", // no default: the person fetches the list or types a name
  openai: "gpt-4o-mini",
};

export const useSettings = create<SettingsState>((set, get) => ({
  loaded: false,
  contactEmail: "",
  enabledSources: DEFAULT_SOURCES,
  ncbiKey: "",
  openAlexKey: "",
  pubmedProxy: "",
  llmProvider: "none",
  llmModel: "",
  llmBaseUrl: "",
  llmKey: "",
  llmAutoModels: false,
  llmModels: [],

  async load() {
    const [email, sources, pubmedProxy, provider, model, baseUrl, autoModels, modelList, ncbiKey, openAlexKey, llmKey] = await Promise.all([
      db.settings.get("contactEmail"),
      db.settings.get("enabledSources"),
      db.settings.get("pubmedProxy"),
      db.settings.get("llmProvider"),
      db.settings.get("llmModel"),
      db.settings.get("llmBaseUrl"),
      db.settings.get("llmAutoModels"),
      db.settings.get("llmModels"),
      platform.secureGet("ncbiKey"),
      platform.secureGet("openAlexKey"),
      platform.secureGet("llmKey"),
    ]);
    set({
      loaded: true,
      contactEmail: (email?.value as string) ?? "",
      enabledSources: (sources?.value as SearchSourceId[]) ?? DEFAULT_SOURCES,
      pubmedProxy: (pubmedProxy?.value as string) ?? "",
      llmProvider: (provider?.value as LlmProvider) ?? "none",
      llmModel: (model?.value as string) ?? "",
      llmBaseUrl: (baseUrl?.value as string) ?? "",
      llmAutoModels: (autoModels?.value as boolean) ?? false,
      llmModels: (modelList?.value as string[]) ?? [],
      ncbiKey: ncbiKey ?? "",
      openAlexKey: openAlexKey ?? "",
      llmKey: llmKey ?? "",
    });
  },

  async setContactEmail(v) {
    set({ contactEmail: v });
    await db.settings.put({ key: "contactEmail", value: v });
  },

  async setPubmedProxy(v) {
    set({ pubmedProxy: v });
    await db.settings.put({ key: "pubmedProxy", value: v });
  },

  async toggleSource(id) {
    const cur = get().enabledSources;
    const next = cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id];
    set({ enabledSources: next });
    await db.settings.put({ key: "enabledSources", value: next });
  },

  async setSecret(which, value) {
    set({ [which]: value } as Pick<SettingsState, SecretKey>);
    await platform.secureSet(which, value);
  },

  async setLlmProvider(p) {
    // A model the person typed or picked is kept. The pre-filled one of the
    // provider being left is not: it means nothing to another provider.
    const current = get().llmModel;
    const model = current && current !== DEFAULT_MODEL[get().llmProvider] ? current : DEFAULT_MODEL[p];
    const baseUrl = p === "anthropic" && !get().llmBaseUrl ? "https://api.anthropic.com/v1" : get().llmBaseUrl;
    set({ llmProvider: p, llmModel: model, llmBaseUrl: baseUrl });
    await db.settings.put({ key: "llmProvider", value: p });
    await db.settings.put({ key: "llmModel", value: model });
    await db.settings.put({ key: "llmBaseUrl", value: baseUrl });
  },
  async setLlmModel(m) {
    set({ llmModel: m });
    await db.settings.put({ key: "llmModel", value: m });
  },
  async setLlmBaseUrl(u) {
    set({ llmBaseUrl: u });
    await db.settings.put({ key: "llmBaseUrl", value: u });
  },
  async setLlmAutoModels(v) {
    set({ llmAutoModels: v });
    await db.settings.put({ key: "llmAutoModels", value: v });
  },
  async setLlmModels(list) {
    set({ llmModels: list });
    await db.settings.put({ key: "llmModels", value: list });
  },

  hasLlm() {
    const { llmProvider, llmKey } = get();
    return llmProvider !== "none" && llmKey.trim() !== "";
  },

  optionsFor(id, extra) {
    const { contactEmail, ncbiKey, openAlexKey, pubmedProxy } = get();
    const apiKey = id === "openalex" ? openAlexKey : id === "pubmed" ? ncbiKey : "";
    return {
      email: contactEmail || undefined,
      apiKey: apiKey || undefined,
      proxyBase: id === "pubmed" ? pubmedProxy || undefined : undefined,
      ...extra,
    };
  },
}));
