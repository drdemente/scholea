import type { HttpResponse, PlatformAdapter, PlatformTarget } from "./types";
import { webAdapter } from "./web";

export type { PlatformAdapter, PlatformTarget, HttpResponse } from "./types";

/** Detect the runtime target. */
export function detectTarget(): PlatformTarget {
  // Tauri v2 injects __TAURI_INTERNALS__ onto the window.
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) return "tauri";
  return "web";
}

export const target = detectTarget();

/**
 * On the desktop app, route HTTP through the Tauri HTTP plugin so requests are
 * made from the native side and **bypass browser CORS**. This is what lets
 * user-configured AI endpoints (OpenAI-compatible) and non-CORS sources (PubMed)
 * actually work in the installed app. On the web build we fall back to the
 * browser fetch, where CORS still applies. The plugin is loaded lazily so the
 * web bundle never pulls it in.
 */
async function http(url: string, init?: RequestInit): Promise<HttpResponse> {
  if (target === "tauri") {
    try {
      // Optional native dependency (see vite.config alias + package.json
      // optionalDependencies). @ts-ignore keeps typecheck green whether or not
      // the real package is installed.
      // @ts-ignore
      const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
      const res = await tauriFetch(url, init);
      return {
        ok: res.ok,
        status: res.status,
        json: <T>() => res.json() as Promise<T>,
        text: () => res.text(),
      };
    } catch {
      // Plugin unavailable → fall back to the browser fetch below.
    }
  }
  return webAdapter.http(url, init);
}

/**
 * The active platform adapter. File save and key storage come from the web
 * adapter, which also works on desktop; HTTP is routed natively on Tauri for
 * CORS-free requests. Which build this is, is `target` above.
 */
export const platform: PlatformAdapter = { ...webAdapter, http };
