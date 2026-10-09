// (intentionally empty) — the Tauri HTTP plugin is an optional native dependency
// resolved at build time. Its dynamic import in platform/index.ts is guarded with
// @ts-ignore so typechecking passes whether or not the package is installed, and
// the Vite config aliases it to a stub when it can't be resolved.
export {};
