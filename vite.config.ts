import { defineConfig, configDefaults } from "vitest/config";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { secretKeyRefusal, secretKeySettings } from "./src/lib/supabase/secret-key";

// Tauri expects a fixed port and no clearing of the screen.
const host = process.env.TAURI_DEV_HOST;

// The Tauri HTTP plugin is an optional dependency used only by the desktop
// build (native, CORS-free requests). When it isn't installed (web-only
// checkout / CI without it), alias it to a local stub so bundling/tests still
// resolve. The desktop build (with the package installed) uses the real one.
const require = createRequire(import.meta.url);
const tauriHttpAlias: Record<string, string> = (() => {
  try {
    require.resolve("@tauri-apps/plugin-http");
    return {} as Record<string, string>;
  } catch {
    return { "@tauri-apps/plugin-http": fileURLToPath(new URL("./src/lib/platform/tauri-http-stub.ts", import.meta.url)) };
  }
})();

/**
 * A build writes the value of every VITE_* setting the code reads into its
 * JavaScript. The app refuses to use a Supabase secret key, but that does not
 * take the key's text out of the files. So a build that is given one, from the
 * environment or from an .env file, stops here before it writes anything.
 * The dev server and the tests are not builds and are left alone.
 */
function refuseSecretKeys(): Plugin {
  return {
    name: "scholea:refuse-secret-keys",
    apply: "build",
    configResolved(config) {
      const names = secretKeySettings(config.env);
      if (names.length > 0) throw new Error(secretKeyRefusal(names));
    },
  };
}

/**
 * The unit tests have no backend, on every machine. A checkout that is used
 * for real work has an .env.local, and it may name a real project: Vitest's own
 * mode, `test`, would read it. So that mode reads no env file, and the three
 * settings are blanked in case the shell exports them. A run that names a mode
 * (`vitest run --mode <name>`) asks for that mode's settings and gets them.
 */
const NO_BACKEND = { VITE_SUPABASE_URL: "", VITE_SUPABASE_PUBLISHABLE_KEY: "", VITE_SUPABASE_ANON_KEY: "" };

export default defineConfig(({ mode }) => ({
  plugins: [refuseSecretKeys(), react()],
  envDir: mode === "test" ? false : undefined,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      ...tauriHttpAlias,
    },
  },
  // --- Desktop (Tauri) friendly dev server -------------------------------
  clearScreen: false,
  server: {
    port: 5193,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 5194 } : undefined,
    watch: {
      // Tauri's Rust sources shouldn't trigger a frontend reload.
      ignored: ["**/src-tauri/**"],
    },
  },
  // WebR / Pyodide ship large WASM; don't inline and keep workers as ESM.
  worker: { format: "es" },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    // This suite is the tests under src/ and nothing else in the checkout.
    include: ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    // supabase/ holds Deno tests that need the local Supabase stack; they run
    // with `pnpm test:supabase`, not with this suite.
    exclude: [...configDefaults.exclude, "supabase/**"],
    env: mode === "test" ? NO_BACKEND : undefined,
  },
}));
