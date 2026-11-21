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
  // Ephemeral, NON-persisted. Narrow-layout (<LAYOUT_NARROW_MAX) off-canvas
  // drawer state for the side panels — below the breakpoint the outliner +
  // inspector overlay the viewport as drawers instead of reserving columns
  // (UX-BACKLOG #2 follow-up 2). Default CLOSED so a narrow first paint shows a
  // full-bleed viewport; like presentMode they never touch localStorage, so a
  // reload (or a resize back to desktop) boots them closed. At most one is open
  // at a time (two overlays would collide on a narrow viewport).
  narrowLeftDrawerOpen: boolean;
  narrowRightDrawerOpen: boolean;
  // Dev-only FPS/ms overlay (FpsMeter). Default OFF so the editor canvas stays
  // clean (the meter is a dev-tool tell, not director chrome); a dev who wants
  // it flips View ▸ Show FPS Meter. Persisted so the choice survives a reload.
  // FpsMeter additionally gates on import.meta.env.DEV — in prod it never renders
  // regardless of this flag.
  showFpsMeter: boolean;
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
  toggleNarrowDrawer: (side: 'left' | 'right') => void;
  closeNarrowDrawers: () => void;
  setShowFpsMeter: (show: boolean) => void;
  toggleShowFpsMeter: () => void;
}

// The fields that persist. presentMode and the narrow drawers are deliberately excluded — they
// must never be written to localStorage (a reload boots them closed).
type SavedField =
  | 'toolRailCollapsed'
  | 'leftSidebarCollapsed'
  | 'inspectorCollapsed'
  | 'showFpsMeter';
const SAVED_FIELDS: readonly SavedField[] = [
  'toolRailCollapsed',
  'leftSidebarCollapsed',
  'inspectorCollapsed',
  'showFpsMeter',
];

// First-visit defaults. #1952 — the outliner and the inspector start as RAILS: the decided editor
// design (editor-design-v1, "The viewport is the film. Side panels start as rails") opens on the
// picture, not on chrome around a smaller picture, the same way the chat column already starts as a
// rail (#1704). The rails keep their expand control (V35), and a director's own choice is saved and
// wins on every later start: storage holds only the fields a director (or a fold rule acting for
// them) actually set, so a key that was never set reads as this default, never as a choice.
// (This reverses Spline redesign Wave B, which had made the outliner always-on.)
export const DEFAULT_CHROME_STATE: ChromeState = {
  toolRailCollapsed: false,
  leftSidebarCollapsed: true,
  inspectorCollapsed: true,
  presentMode: false,
  narrowLeftDrawerOpen: false,
  narrowRightDrawerOpen: false,
  showFpsMeter: false,
};
const DEFAULT_STATE = DEFAULT_CHROME_STATE;

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

// The saved record, as an object of whatever booleans it holds; anything unreadable is "nothing saved".
function readRecord(raw: string | null): Partial<Record<SavedField, unknown>> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The chrome state a start boots with, from the saved record (#1952). A field the record holds as a
 * boolean is a choice and wins; a missing or malformed field falls back to the first-start default.
 * The ephemeral fields (present mode, narrow drawers) always boot closed.
 */
export function chromeStateFromSaved(raw: string | null): ChromeState {
  const rec = readRecord(raw);
  const pick = (k: SavedField): boolean => {
    const v = rec[k];
    return typeof v === 'boolean' ? v : DEFAULT_STATE[k];
  };
  return {
    toolRailCollapsed: pick('toolRailCollapsed'),
    leftSidebarCollapsed: pick('leftSidebarCollapsed'),
    inspectorCollapsed: pick('inspectorCollapsed'),
    showFpsMeter: pick('showFpsMeter'),
    // Always boot false — never read back from storage (non-persisted).
    presentMode: false,
    narrowLeftDrawerOpen: false,
    narrowRightDrawerOpen: false,
  };
}

function readPersisted(): ChromeState {
  return chromeStateFromSaved(safeGetItem(STORAGE_KEY));
}

// Saves ONE field that was just set, merged into what is already saved. Writing only the field that
// changed is what keeps "never chosen" readable (#1952): folding the tool rail must not record the
// panels' current default as if the director had picked it. presentMode is structurally excluded
// (it is not a SavedField), so it can never land in localStorage.
function writePersisted(field: SavedField, value: boolean): void {
  const rec = readRecord(safeGetItem(STORAGE_KEY));
  const next: Partial<Record<SavedField, boolean>> = {};
  for (const k of SAVED_FIELDS) {
    const v = rec[k];
    if (typeof v === 'boolean') next[k] = v;
  }
  next[field] = value;
  safeSetItem(STORAGE_KEY, JSON.stringify(next));
}

export const useChromeStore = create<ChromeStore>((set, get) => ({
  ...readPersisted(),
  setToolRailCollapsed(collapsed) {
    set({ toolRailCollapsed: collapsed });
    writePersisted('toolRailCollapsed', collapsed);
  },
  setLeftSidebarCollapsed(collapsed) {
    set({ leftSidebarCollapsed: collapsed });
    writePersisted('leftSidebarCollapsed', collapsed);
  },
  setInspectorCollapsed(collapsed) {
    set({ inspectorCollapsed: collapsed });
    writePersisted('inspectorCollapsed', collapsed);
  },
  toggleToolRail() {
    const next = !get().toolRailCollapsed;
    set({ toolRailCollapsed: next });
    writePersisted('toolRailCollapsed', next);
  },
  toggleLeftSidebar() {
    const next = !get().leftSidebarCollapsed;
    set({ leftSidebarCollapsed: next });
    writePersisted('leftSidebarCollapsed', next);
  },
  toggleInspector() {
    const next = !get().inspectorCollapsed;
    set({ inspectorCollapsed: next });
    writePersisted('inspectorCollapsed', next);
  },
  // presentMode is EPHEMERAL: set() only, never writePersisted — a reload must
  // never trap the user in fullscreen with no chrome to escape.
  setPresentMode(present) {
    set({ presentMode: present });
  },
  togglePresentMode() {
    set({ presentMode: !get().presentMode });
  },
  // Narrow drawers are EPHEMERAL like presentMode (set() only). Opening one
  // closes the other — on a narrow viewport two side overlays would collide.
  toggleNarrowDrawer(side) {
    if (side === 'left') {
      set({ narrowLeftDrawerOpen: !get().narrowLeftDrawerOpen, narrowRightDrawerOpen: false });
    } else {
      set({ narrowRightDrawerOpen: !get().narrowRightDrawerOpen, narrowLeftDrawerOpen: false });
    }
  },
  closeNarrowDrawers() {
    set({ narrowLeftDrawerOpen: false, narrowRightDrawerOpen: false });
  },
  setShowFpsMeter(show) {
    set({ showFpsMeter: show });
    writePersisted('showFpsMeter', show);
  },
  toggleShowFpsMeter() {
    const next = !get().showFpsMeter;
    set({ showFpsMeter: next });
    writePersisted('showFpsMeter', next);
  },
}));
