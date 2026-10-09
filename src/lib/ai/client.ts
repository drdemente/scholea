/**
 * Optional AI guidance layer — provider-agnostic, BYO-key.
 *
 * Requests go through the platform HTTP adapter, so on the desktop app they are
 * made natively and **bypass browser CORS** — this is what makes custom
 * OpenAI-compatible endpoints (self-hosted gateways, OpenRouter, Groq, local
 * servers, …) work reliably. On the web build the browser fetch is used and the
 * endpoint must send permissive CORS headers.
 *
 * Two providers:
 *   • anthropic — Messages API (https://api.anthropic.com/v1/messages).
 *   • openai    — any OpenAI-compatible /chat/completions endpoint via a
 *                 configurable base URL.
 *
 * The user's key is read from the secure store and sent directly to their
 * chosen provider — never to a Scholea server (there isn't one for this).
 */
import { platform } from "@/lib/platform";
import type { LlmProvider } from "@/lib/settings/settings-store";

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Max output tokens (default 1500). Larger for batched/structured tasks. */
  maxTokens?: number;
}

/** Normalise an OpenAI-compatible base URL (trim trailing slash; default OpenAI). */
function openAiBase(baseUrl?: string): string {
  return (baseUrl?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
}

function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

function friendlyError(status: number, body: string): string {
  if (status === 0) return "Couldn't reach the endpoint — check the Base URL, your connection, and (on the web build) that the endpoint allows browser access (CORS).";
  if (status === 401 || status === 403) return "Authentication failed — check your API key in Settings.";
  if (status === 404) return "Endpoint not found (404) — check the Base URL. OpenAI-compatible URLs usually end in /v1.";
  if (status === 429) return "Rate limited by your provider — try again shortly.";
  return `Provider error (HTTP ${status}). ${body.slice(0, 200)}`;
}

/** Wrap network-layer failures (thrown by fetch) in a readable message. */
async function post<T>(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<T> {
  let res;
  try {
    res = await platform.http(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  } catch (e) {
    throw new Error(`Couldn't reach ${url} — ${e instanceof Error ? e.message : "network error"}. On the web build the endpoint must allow browser access (CORS); the desktop app avoids this.`);
  }
  if (!res.ok) throw new Error(friendlyError(res.status, await res.text()));
  return res.json<T>();
}

async function generateAnthropic(system: string, user: string, cfg: LlmConfig, signal?: AbortSignal): Promise<string> {
  const data = await post<{ content?: { type: string; text?: string }[] }>(
    `${openAiBase(cfg.baseUrl)}/messages`,
    anthropicHeaders(cfg.apiKey),
    { model: cfg.model, max_tokens: cfg.maxTokens ?? 1500, system, messages: [{ role: "user", content: user }] },
    signal,
  );
  return (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
}

async function generateOpenAi(system: string, user: string, cfg: LlmConfig, signal?: AbortSignal): Promise<string> {
  const data = await post<{ choices?: { message?: { content?: string } }[] }>(
    `${openAiBase(cfg.baseUrl)}/chat/completions`,
    { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    { model: cfg.model, max_tokens: cfg.maxTokens ?? 1500, messages: [{ role: "system", content: system }, { role: "user", content: user }] },
    signal,
  );
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

export async function generateText(system: string, user: string, cfg: LlmConfig, signal?: AbortSignal): Promise<string> {
  // Not every provider has a pre-filled model, and a request without one only
  // comes back as an error the provider words in its own way.
  if (cfg.provider !== "none" && !cfg.model.trim()) {
    throw new Error("No model is chosen. Pick or type one in Settings, under AI assistance.");
  }
  if (cfg.provider === "anthropic") return generateAnthropic(system, user, cfg, signal);
  if (cfg.provider === "openai") return generateOpenAi(system, user, cfg, signal);
  throw new Error("No AI provider configured. Add a key in Settings.");
}

interface ModelListResponse {
  data?: { id?: string }[];
  models?: { id?: string; name?: string }[];
}

/**
 * List the models the endpoint exposes (GET /models, for OpenAI-compatible
 * endpoints and for Anthropic alike). Used by the Settings "auto-fetch
 * models" option. Also doubles as a connection/auth test.
 */
export async function listModels(cfg: LlmConfig, signal?: AbortSignal): Promise<string[]> {
  const url = cfg.provider === "anthropic"
    ? `${openAiBase(cfg.baseUrl)}/models`
    : `${openAiBase(cfg.baseUrl)}/models`;
  const headers = cfg.provider === "anthropic"
    ? anthropicHeaders(cfg.apiKey)
    : { authorization: `Bearer ${cfg.apiKey}` };

  let res;
  try {
    res = await platform.http(url, { method: "GET", headers, signal });
  } catch (e) {
    throw new Error(`Couldn't reach ${url} — ${e instanceof Error ? e.message : "network error"}. On the web build the endpoint must allow browser access (CORS); the desktop app avoids this.`);
  }
  if (!res.ok) throw new Error(friendlyError(res.status, await res.text()));
  const data = await res.json<ModelListResponse>();
  const ids = (data.data ?? data.models ?? [])
    .map((m) => m.id ?? (m as { name?: string }).name ?? "")
    .filter(Boolean);
  if (ids.length === 0) throw new Error("The endpoint returned no models.");
  return Array.from(new Set(ids)).sort();
}
