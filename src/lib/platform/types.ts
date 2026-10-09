/**
 * Platform adapter: keeps feature code identical on the web and desktop builds.
 * A small surface: HTTP (CORS bypass on desktop), local file export, and
 * on-device storage for BYO API keys. Accounts are not part of it. They live in
 * `src/lib/account` and behave the same on both targets.
 */
export type PlatformTarget = "web" | "tauri";

export interface HttpResponse {
  ok: boolean;
  status: number;
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
}

export interface PlatformAdapter {
  /** Fetch. The Tauri adapter uses its HTTP client to bypass browser CORS. */
  http(url: string, init?: RequestInit): Promise<HttpResponse>;

  /** Hand a file to the person. Both builds do it as a download from the webview. */
  saveFile(filename: string, data: Blob | string): Promise<void>;

  /**
   * Key/value storage for BYO API keys. The values stay on this device and are
   * kept apart from project data, so they never sync. They are NOT encrypted:
   * both builds keep them in the webview's local storage as given.
   */
  secureGet(key: string): Promise<string | null>;
  secureSet(key: string, value: string): Promise<void>;
}
