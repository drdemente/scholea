import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Level } from "@/lib/study/types";

export type Mode = "light" | "dark";
/** Progressive-disclosure level — canonical type lives in study/types. */
export type { Level };

type ThemeState = {
  mode: Mode;
  level: Level;
  setMode: (mode: Mode) => void;
  toggleMode: () => void;
  setLevel: (level: Level) => void;
};

/** Reflect theme onto <html> so the CSS variable themes switch instantly. */
function applyToDocument(mode: Mode) {
  document.documentElement.setAttribute("data-mode", mode);
}

export const useTheme = create<ThemeState>()(
  persist(
    (set, get) => ({
      mode: "light",
      level: "basic",
      setMode: (mode) => {
        applyToDocument(mode);
        set({ mode });
      },
      toggleMode: () => {
        const mode = get().mode === "light" ? "dark" : "light";
        applyToDocument(mode);
        set({ mode });
      },
      setLevel: (level) => set({ level }),
    }),
    {
      name: "scholea.theme",
      // Keep the pre-paint inline script (index.html) in sync — only persist
      // what it reads.
      partialize: (s) => ({ mode: s.mode, level: s.level }),
      onRehydrateStorage: () => (state) => {
        if (state) applyToDocument(state.mode);
      },
    },
  ),
);
