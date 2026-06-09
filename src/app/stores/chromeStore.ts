// Chrome store — independent collapse states for R4 (ToolRail), R5 (LeftSidebar),
// R7 (Inspector). Replaces the dropped density axis (D-UX-5): instead of three
// density variants forcing panel-visibility combinations, each panel collapses
// individually under user control.
//
// Per spec §3.2: per-panel collapse is the Spline pattern.
//
// presentMode (v0.6 #4): the fullscreen "present"/director-cut layout collapse —
// when true, Layout hides every chrome band. It is the re-home for the deleted
// operational `director` mode. EPHEMERAL: it is NOT persisted (a reload must not
// trap the user in fullscreen with no visible chrome to escape), mirroring the old
// modeStore policy that `director` never persisted. Its toggle/setter call set()
// only — never writePersisted — and readPersisted always boots it false.
//
// V8 file-rooted: this store lives in src/app/stores/ alongside the other UI
// projection stores. No DAG dispatch passes through it — every field here is
// ephemeral UI-projection state, never DAG/IR (V34-clean).
//
// REF: docs/UI-SPEC.md §3.2, §7.1, §7.3.

import { create } from 'zustand';

const STORAGE_KEY = 'basher.chrome.v1';

export interface ChromeState {
  toolRailCollapsed: boolean;
  leftSidebarCollapsed: boolean;
  inspectorCollapsed: boolean;
  // Ephemeral, NON-persisted (see header). The re-home for the deleted `director` mode.
  presentMode: boolean;
}

export interface ChromeStore extends ChromeState {
  setToolRailCollapsed: (collapsed: boolean) => void;
  setLeftSidebarCollapsed: (collapsed: boolean) => void;
  setInspectorCollapsed: (collapsed: boolean) => void;
  toggleToolRail: () => void;
  toggleLeftSidebar: () => void;
  toggleInspector: () => void;
  setPresentMode: (present: boolean) => void;
  togglePresentMode: () => void;
}

// The subset of ChromeState that actually persists. presentMode is deliberately
// excluded — it must never be written to localStorage (a reload boots it false).
type PersistedChromeState = Omit<ChromeState, 'presentMode'>;

// First-visit defaults. Spline redesign Wave B: leftSidebarCollapsed now
// defaults to FALSE — the scene outliner is ALWAYS-ON, matching Spline (the
// W2.6 default-collapsed rationale is reversed: Spline keeps the outliner
// visible at all times; an editor whose first paint hides the scene tree reads
// as a bare viewport, not a 3D editor). The collapse affordance is preserved
// (V35) so a user who wants the extra ~232px can still fold it; chromeStore
// persists their choice, so a returning user sees what they last set.
const DEFAULT_STATE: ChromeState = {
  toolRailCollapsed: false,
  leftSidebarCollapsed: false,
  inspectorCollapsed: false,
  presentMode: false,
};

// Defensive against test envs where `localStorage` exists but its methods
// are stubbed weirdly (happy-dom + vitest module-load ordering can land us
// here before the Storage API is fully attached).
function safeGetItem(key: string): string | null {
  try {
    if (typeof localStorage?.getItem !== 'function') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    if (typeof localStorage?.setItem !== 'function') return;
    localStorage.setItem(key, value);
  } catch {
    /* ignore — storage quota / disabled / SSR */
  }
}

function readPersisted(): ChromeState {
  const raw = safeGetItem(STORAGE_KEY);
  if (!raw) return DEFAULT_STATE;
  try {
    const parsed = JSON.parse(raw) as Partial<ChromeState>;
    return {
      toolRailCollapsed:
        typeof parsed.toolRailCollapsed === 'boolean' ? parsed.toolRailCollapsed : false,
      leftSidebarCollapsed:
        typeof parsed.leftSidebarCollapsed === 'boolean' ? parsed.leftSidebarCollapsed : false,
      inspectorCollapsed:
        typeof parsed.inspectorCollapsed === 'boolean' ? parsed.inspectorCollapsed : false,
      // Always boots false — never read back from storage (non-persisted).
      presentMode: false,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

// Persists ONLY the collapse fields. presentMode is structurally excluded so it
// can never land in localStorage even via a sibling toggle's get() spread.
function writePersisted(state: PersistedChromeState): void {
  safeSetItem(
    STORAGE_KEY,
    JSON.stringify({
      toolRailCollapsed: state.toolRailCollapsed,
      leftSidebarCollapsed: state.leftSidebarCollapsed,
      inspectorCollapsed: state.inspectorCollapsed,
    }),
  );
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
  // presentMode is EPHEMERAL: set() only, never writePersisted — a reload must
  // never trap the user in fullscreen with no chrome to escape.
  setPresentMode(present) {
    set({ presentMode: present });
  },
  togglePresentMode() {
    set({ presentMode: !get().presentMode });
  },
}));
