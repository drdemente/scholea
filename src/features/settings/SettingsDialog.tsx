import { useEffect, useState } from "react";
import { AlertCircle, Eye, EyeOff, Info, KeyRound, RefreshCw, Sparkles } from "lucide-react";
import { GlassOverlay, GlassButton } from "@/components/glass";
import { AboutWorkspace } from "@/features/instance/InstanceContact";
import { listModels } from "@/lib/ai/client";
import { useSettings, type SecretKey } from "@/lib/settings/settings-store";
import { useIdentity } from "@/lib/collab/identity-store";
import type { CollaboratorRole } from "@/lib/db/schema";
import { SEARCH_SOURCES, isSourceUsable } from "@/lib/sources/registry";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { MANUAL_SOURCES } from "@/lib/sources/types";
import type { SearchSourceId } from "@/lib/sources/types";

const SECRET_FOR: Partial<Record<SearchSourceId, SecretKey>> = {
  openalex: "openAlexKey",
  pubmed: "ncbiKey",
};

/** BYO-key settings. Users enter their own free keys; nothing is shared. */
export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useSettings();
  const identity = useIdentity();
  const [modelFetch, setModelFetch] = useState<{ loading?: boolean; error?: string }>({});

  useEffect(() => {
    if (open && !s.loaded) void s.load();
  }, [open, s]);

  const fetchModels = async () => {
    setModelFetch({ loading: true });
    try {
      const list = await listModels({ provider: s.llmProvider, apiKey: s.llmKey, model: s.llmModel, baseUrl: s.llmBaseUrl });
      await s.setLlmModels(list);
      setModelFetch({});
      // Keep the current model if it's in the list; otherwise pick the first.
      if (list.length && !list.includes(s.llmModel)) void s.setLlmModel(list[0]);
    } catch (e) {
      setModelFetch({ error: e instanceof Error ? e.message : "Couldn't fetch models." });
    }
  };

  return (
    <GlassOverlay open={open} onClose={onClose} labelledBy="settings-title" className="!p-0">
      <div className="max-h-[85vh] overflow-y-auto p-6">
        <h2 id="settings-title" className="text-xl font-bold text-ink">
          Settings
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          Bring your own free API keys. They’re stored locally on this device and never shared.
        </p>

        {/* Contact email */}
        <section className="mt-5">
          <label htmlFor="contact-email" className="text-sm font-medium text-ink">
            Contact email
          </label>
          <p className="text-xs text-ink-muted">
            Optional. Sent with your searches to Crossref, OpenAlex and PubMed. Crossref and OpenAlex give requests
            that carry an email faster, more reliable service (their “polite pool”).
          </p>
          <input
            id="contact-email"
            type="email"
            autoComplete="email"
            value={s.contactEmail}
            onChange={(e) => void s.setContactEmail(e.target.value)}
            placeholder="you@university.edu"
            className="mt-1.5 w-full rounded-input border border-hairline bg-elevated/70 px-3 py-2 text-base text-ink outline-none focus-visible:focus-ring"
          />
        </section>

        {/* Identity on this device (attribution for projects kept here) */}
        <section className="mt-6">
          <h3 className="text-sm font-semibold text-ink">Identity on this device</h3>
          <p className="text-xs text-ink-muted">
            Used for projects kept only on this device: it labels your comments, sign-offs and activity there.
            {/* A build with no account backend has no accounts to speak of. */}
            {isSupabaseConfigured &&
              " Projects in your account use your account name, and your role on each project (set by its owner in Share) decides who can sign off."}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              aria-label="Your name"
              value={identity.name}
              onChange={(e) => identity.setName(e.target.value)}
              placeholder="Your name"
              className="min-w-[12rem] flex-1 rounded-input border border-hairline bg-elevated/70 px-3 py-2 text-base text-ink outline-none focus-visible:focus-ring"
            />
            <select
              aria-label="Your role"
              value={identity.role}
              onChange={(e) => identity.setRole(e.target.value as CollaboratorRole)}
              className="rounded-input border border-hairline bg-elevated/70 px-2.5 py-2 text-base text-ink outline-none focus-visible:focus-ring"
            >
              <option value="researcher">Researcher</option>
              <option value="supervisor">Supervisor</option>
            </select>
          </div>
        </section>

        {/* Sources */}
        <section className="mt-6">
          <h3 className="text-sm font-semibold text-ink">Literature sources</h3>
          <ul className="mt-2 flex flex-col gap-2">
            {SEARCH_SOURCES.map((src) => {
              const usable = isSourceUsable(src, !!s.pubmedProxy);
              const enabled = s.enabledSources.includes(src.id) && usable;
              const secret = SECRET_FOR[src.id];
              return (
                <li key={src.id} className="rounded-input border border-hairline bg-elevated/40 p-3">
                  <label className="flex items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={!usable}
                      onChange={() => void s.toggleSource(src.id)}
                      className="mt-0.5 h-5 w-5 shrink-0 rounded-[6px] accent-[var(--color-primary)] focus-visible:focus-ring disabled:opacity-50"
                    />
                    <span className="min-w-0">
                      <span className="font-medium text-ink">{src.label}</span>
                      <span className="block text-xs text-ink-muted">{src.note}</span>
                      {!usable && (
                        <span className="mt-1 block text-xs font-medium text-warning">
                          Needs the desktop app or a proxy (not available in this web build).
                        </span>
                      )}
                    </span>
                  </label>
                  {secret && (
                    <SecretField
                      label={`${src.label} API key`}
                      value={s[secret]}
                      onChange={(v) => void s.setSecret(secret, v)}
                    />
                  )}
                  {src.id === "pubmed" && (
                    <div className="mt-3 pl-7">
                      <label htmlFor="pubmed-proxy" className="text-xs font-medium text-ink-soft">
                        PubMed proxy URL <span className="font-normal text-ink-muted">(web build only)</span>
                      </label>
                      <p className="text-xs text-ink-muted">
                        PubMed isn’t CORS-enabled. Deploy <code>proxy/pubmed-worker.js</code> and paste its URL to enable PubMed on the web.
                      </p>
                      <input
                        id="pubmed-proxy"
                        type="url"
                        value={s.pubmedProxy}
                        onChange={(e) => void s.setPubmedProxy(e.target.value)}
                        placeholder="https://your-proxy.workers.dev"
                        className="mt-1 w-full rounded-input border border-hairline bg-elevated/70 px-3 py-1.5 text-sm text-ink outline-none focus-visible:focus-ring"
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Manual sources (no public API, so import records instead)
          </h4>
          <ul className="mt-2 flex flex-col gap-1.5">
            {Object.values(MANUAL_SOURCES)
              .filter((m) => m.id !== "other")
              .map((m) => (
                <li key={m.id} className="rounded-input border border-hairline bg-elevated/40 p-3">
                  <span className="font-medium text-ink">{m.label}</span>
                  <span className="block text-xs text-ink-muted">{m.note}</span>
                </li>
              ))}
          </ul>
          <p className="mt-1.5 text-xs text-ink-muted">
            Use <strong>Choose RIS file</strong> in the search step. Imported records are tagged with their source
            and flow into deduplication, screening, and the PRISMA counts like any other record.
          </p>
        </section>

        {/* Optional AI assistance */}
        <section className="mt-6">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
            <Sparkles className="h-4 w-4 text-accent" aria-hidden="true" />
            AI assistance <span className="font-normal text-ink-muted">(optional)</span>
          </h3>
          <p className="mt-1 text-xs text-ink-muted">
            Add your own LLM key to get grounded drafts and explanations at relevant steps. Everything
            else works without this. Drafts are labelled as drafts to review, never as final text.
          </p>

          <label htmlFor="llm-provider" className="mt-3 block text-xs font-medium text-ink-soft">
            Provider
          </label>
          <select
            id="llm-provider"
            value={s.llmProvider}
            onChange={(e) => void s.setLlmProvider(e.target.value as typeof s.llmProvider)}
            className="mt-1 w-full rounded-input border border-hairline bg-elevated/70 px-3 py-2 text-base text-ink outline-none focus-visible:focus-ring"
          >
            <option value="none">Off</option>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI-compatible</option>
          </select>

          {s.llmProvider !== "none" && (
            <>
              <label htmlFor="llm-base" className="mt-3 block text-xs font-medium text-ink-soft">
                Base URL <span className="font-normal text-ink-muted">
                  {s.llmProvider === "anthropic"
                    ? "(defaults to Anthropic, customize for self-hosted gateways)"
                    : "(ends in /v1 for most OpenAI-compatible APIs)"}
                </span>
              </label>
              <input
                id="llm-base"
                value={s.llmBaseUrl}
                onChange={(e) => void s.setLlmBaseUrl(e.target.value)}
                spellCheck={false}
                placeholder={s.llmProvider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"}
                className="mt-1 w-full rounded-input border border-hairline bg-elevated/70 px-3 py-2 font-mono text-sm text-ink outline-none focus-visible:focus-ring"
              />
            </>
          )}

              <div className="-ml-7">
                <SecretField
                  label={s.llmProvider === "anthropic" ? "Anthropic API key" : "API key"}
                  value={s.llmKey}
                  onChange={(v) => void s.setSecret("llmKey", v)}
                />
              </div>

              {/* Model — either auto-fetched from the endpoint or entered manually */}
              <div className="mt-3 flex items-center justify-between gap-2">
                <label htmlFor="llm-model" className="text-xs font-medium text-ink-soft">Model</label>
                <label className="flex items-center gap-1.5 text-xs text-ink-soft">
                  <input
                    type="checkbox"
                    checked={s.llmAutoModels}
                    onChange={(e) => {
                      void s.setLlmAutoModels(e.target.checked);
                      if (e.target.checked && s.llmKey.trim()) void fetchModels();
                    }}
                    className="h-4 w-4 rounded-[4px] accent-[var(--color-primary)] focus-visible:focus-ring"
                  />
                  Auto-fetch models
                </label>
              </div>

              {s.llmAutoModels ? (
                (() => {
                  // Options are the fetched list; always include the active model
                  // so the selection is never blank.
                  const opts = s.llmModel && !s.llmModels.includes(s.llmModel) ? [s.llmModel, ...s.llmModels] : s.llmModels;
                  return (
                    <div className="mt-1 flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <select
                          id="llm-model"
                          value={s.llmModel}
                          disabled={opts.length === 0}
                          onChange={(e) => void s.setLlmModel(e.target.value)}
                          className="w-full rounded-input border border-hairline bg-elevated/70 px-3 py-2 font-mono text-sm text-ink outline-none focus-visible:focus-ring disabled:opacity-60"
                        >
                          {opts.length === 0 ? (
                            <option value="">Fetch models to choose…</option>
                          ) : (
                            opts.map((m) => <option key={m} value={m}>{m}</option>)
                          )}
                        </select>
                        <GlassButton variant="soft" size="sm" onClick={fetchModels} loading={modelFetch.loading} disabled={!s.llmKey.trim()} className="shrink-0">
                          {!modelFetch.loading && <RefreshCw className="h-4 w-4" aria-hidden="true" />}
                          {s.llmModels.length ? "Refresh" : "Fetch"}
                        </GlassButton>
                      </div>
                      {!s.llmKey.trim() && <p className="text-xs text-ink-muted">Add your API key above, then fetch the model list.</p>}
                      {s.llmModels.length > 0 && !modelFetch.error && (
                        <p className="text-xs text-ink-muted">
                          {s.llmModels.length} models available.{" "}
                          {s.llmModel ? (
                            <>AI assistance will use <span className="font-mono text-ink-soft">{s.llmModel}</span>.</>
                          ) : (
                            "Choose the one AI assistance should use."
                          )}
                        </p>
                      )}
                      {modelFetch.error && (
                        <p role="alert" className="flex items-start gap-1.5 text-xs font-medium text-warning">
                          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          {modelFetch.error}
                        </p>
                      )}
                    </div>
                  );
                })()
              ) : (
                <>
                  <input
                    id="llm-model"
                    value={s.llmModel}
                    onChange={(e) => void s.setLlmModel(e.target.value)}
                    spellCheck={false}
                    placeholder={s.llmProvider === "anthropic" ? "Model name" : "gpt-4o-mini"}
                    className="mt-1 w-full rounded-input border border-hairline bg-elevated/70 px-3 py-2 font-mono text-sm text-ink outline-none focus-visible:focus-ring"
                  />
                  {s.llmProvider !== "none" && !s.llmModel.trim() && (
                    <p className="mt-1 text-xs text-ink-muted">
                      No model is chosen yet. Type its name as your provider lists it, or tick Auto-fetch models to
                      pick one from a list.
                    </p>
                  )}
                </>
              )}
        </section>

        {/* The organisation behind the signed-in account, when it gave its details */}
        <AboutWorkspace />

        <p role="note" className="mt-5 flex items-start gap-2 rounded-input bg-info-soft p-3 text-xs text-ink">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Keys are stored on this device only. They are not encrypted: anyone who can use this browser profile, or
            this user account on the computer, can read them.
          </span>
        </p>

        <div className="mt-5 flex justify-end">
          <GlassButton onClick={onClose}>Done</GlassButton>
        </div>
      </div>
    </GlassOverlay>
  );
}

function SecretField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="mt-3 pl-7">
      <label className="flex items-center gap-1.5 text-xs font-medium text-ink-soft">
        <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </label>
      <div className="mt-1 flex items-center gap-2">
        <input
          type={show ? "text" : "password"}
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Paste your free key"
          className="w-full rounded-input border border-hairline bg-elevated/70 px-3 py-1.5 font-mono text-sm text-ink outline-none focus-visible:focus-ring"
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? "Hide key" : "Show key"}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-input border border-hairline text-ink-soft hover:text-ink focus-visible:focus-ring"
        >
          {show ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}
