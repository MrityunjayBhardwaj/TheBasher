// Chrome store — independent collapse states for R4 (ToolRail), R5 (LeftSidebar),
// R7 (Inspector). Replaces the dropped density axis (D-UX-5): instead of three
// density variants forcing panel-visibility combinations, each panel collapses
// individually under user control.
//
// Per spec §3.2: per-panel collapse is the Spline pattern. Director mode
// (D-UX-9) overrides — when mode === 'director', layout hides R4/R5/R7
// regardless of these flags.
//
// V8 file-rooted: this store lives in src/app/stores/ alongside the other UI
// projection stores. No DAG dispatch passes through it.
//
// REF: docs/UI-SPEC.md §3.2, §7.1, §7.3.

import { create } from 'zustand';

const STORAGE_KEY = 'basher.chrome.v1';

export interface ChromeState {
  toolRailCollapsed: boolean;
  leftSidebarCollapsed: boolean;
  inspectorCollapsed: boolean;
}

export interface ChromeStore extends ChromeState {
  setToolRailCollapsed: (collapsed: boolean) => void;
  setLeftSidebarCollapsed: (collapsed: boolean) => void;
  setInspectorCollapsed: (collapsed: boolean) => void;
  toggleToolRail: () => void;
  toggleLeftSidebar: () => void;
  toggleInspector: () => void;
}

const DEFAULT_STATE: ChromeState = {
  toolRailCollapsed: false,
  leftSidebarCollapsed: false,
  inspectorCollapsed: false,
};

function readPersisted(): ChromeState {
  if (typeof localStorage === 'undefined') return DEFAULT_STATE;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_STATE;
  try {
    const parsed = JSON.parse(raw) as Partial<ChromeState>;
    return {
      toolRailCollapsed: typeof parsed.toolRailCollapsed === 'boolean' ? parsed.toolRailCollapsed : false,
      leftSidebarCollapsed:
        typeof parsed.leftSidebarCollapsed === 'boolean' ? parsed.leftSidebarCollapsed : false,
      inspectorCollapsed:
        typeof parsed.inspectorCollapsed === 'boolean' ? parsed.inspectorCollapsed : false,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function writePersisted(state: ChromeState): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export const useChromeStore = create<ChromeStore>((set, get) => ({
  ...readPersisted(),
  setToolRailCollapsed(collapsed) {
    set({ toolRailCollapsed: collapsed });
    writePersisted({ ...get(), toolRailCollapsed: collapsed });
  },
  setLeftSidebarCollapsed(collapsed) {
    set({ leftSidebarCollapsed: collapsed });
    writePersisted({ ...get(), leftSidebarCollapsed: collapsed });
  },
  setInspectorCollapsed(collapsed) {
    set({ inspectorCollapsed: collapsed });
    writePersisted({ ...get(), inspectorCollapsed: collapsed });
  },
  toggleToolRail() {
    const next = !get().toolRailCollapsed;
    set({ toolRailCollapsed: next });
    writePersisted({ ...get(), toolRailCollapsed: next });
  },
  toggleLeftSidebar() {
    const next = !get().leftSidebarCollapsed;
    set({ leftSidebarCollapsed: next });
    writePersisted({ ...get(), leftSidebarCollapsed: next });
  },
  toggleInspector() {
    const next = !get().inspectorCollapsed;
    set({ inspectorCollapsed: next });
    writePersisted({ ...get(), inspectorCollapsed: next });
  },
}));
