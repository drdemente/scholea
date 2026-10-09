import { create } from "zustand";

/** Transient UI state shared across the shell (dialogs, palettes, chooser). */
interface UIState {
  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;

  chooserOpen: boolean;
  openChooser: () => void;
  closeChooser: () => void;

  paperOpen: boolean;
  openPaper: () => void;
  closePaper: () => void;

  ethicsOpen: boolean;
  openEthics: () => void;
  closeEthics: () => void;

  activityOpen: boolean;
  openActivity: () => void;
  closeActivity: () => void;

  shareOpen: boolean;
  openShare: () => void;
  closeShare: () => void;

  checklistOpen: boolean;
  openChecklist: () => void;
  closeChecklist: () => void;

  helpOpen: boolean;
  openHelp: () => void;
  closeHelp: () => void;
}

export const useUI = create<UIState>((set) => ({
  settingsOpen: false,
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),

  chooserOpen: false,
  openChooser: () => set({ chooserOpen: true }),
  closeChooser: () => set({ chooserOpen: false }),

  paperOpen: false,
  openPaper: () => set({ paperOpen: true }),
  closePaper: () => set({ paperOpen: false }),

  ethicsOpen: false,
  openEthics: () => set({ ethicsOpen: true }),
  closeEthics: () => set({ ethicsOpen: false }),

  activityOpen: false,
  openActivity: () => set({ activityOpen: true }),
  closeActivity: () => set({ activityOpen: false }),

  shareOpen: false,
  openShare: () => set({ shareOpen: true }),
  closeShare: () => set({ shareOpen: false }),

  checklistOpen: false,
  openChecklist: () => set({ checklistOpen: true }),
  closeChecklist: () => set({ checklistOpen: false }),

  helpOpen: false,
  openHelp: () => set({ helpOpen: true }),
  closeHelp: () => set({ helpOpen: false }),
}));
