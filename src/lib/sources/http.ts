/**
 * Thin fetch helpers for CORS-friendly sources. Maps HTTP 429 to RateLimitError
 * (so the limiter can back off) and other failures to SourceError.
 */
import { RateLimitError, SourceError } from "./types";

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  return Number.isFinite(secs) ? secs * 1000 : undefined;
}

export async function fetchJson<T>(
  url: string,
  source: string,
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal, headers: { Accept: "application/json", ...headers } });
  } catch (err) {
    throw new SourceError(source, err instanceof Error ? err.message : "network error");
  }

  if (res.status === 429) {
    // OpenAlex signals daily-credit exhaustion via a zeroed remaining header.
    const remaining = res.headers.get("x-ratelimit-remaining");
    const exhausted = remaining === "0";
    throw new RateLimitError(source, retryAfterMs(res), exhausted);
  }
  if (!res.ok) {
    // Surface the API's own error message (e.g. OpenAlex's "use an API key")
    // instead of a bare "HTTP 400".
    let detail = "";
    try {
      const parsed = JSON.parse(await res.text()) as { message?: string; error?: string };
      detail = String(parsed.message ?? parsed.error ?? "").trim();
    } catch {
      /* non-JSON body — keep the status only */
    }
    throw new SourceError(source, `HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return (await res.json()) as T;
}

/** URL-encode a query value. */
export const q = (s: string) => encodeURIComponent(s);
