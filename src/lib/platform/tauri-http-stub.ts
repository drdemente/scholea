/**
 * Build-time stub for the optional `@tauri-apps/plugin-http` package. The Vite
 * config aliases the plugin to this file ONLY when the real package isn't
 * installed (e.g. a web-only checkout or CI without it), so bundling/tests still
 * resolve. It's never actually called on the web build — the caller in
 * platform/index.ts only takes the Tauri branch inside the desktop app, where
 * the real package is installed and used instead of this stub.
 */
export async function fetch(): Promise<Response> {
  throw new Error("Tauri HTTP plugin is not installed (web build).");
}
