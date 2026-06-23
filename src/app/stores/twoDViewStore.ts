// twoDViewStore — active-mode store for the unified 2D View (Blender's
// Image Editor analog). The 2D space hosts two panes as tabs:
//
//   { mode: 'uv' | 'render' }
//
//   - 'uv'     → the UV layout + texture backdrop (UVEditor, #181/UX #10).
//   - 'render' → the Render Result viewer (the still render, and later the
//                fal AI edit — both land here as one image).
//
// Both panes stay mounted; only one is visually active (display:none
// discipline, same as the TimelineDrawer dock) so each pane's canvas/store
// subscriptions survive a tab switch.
//
// One localStorage key. K11 boot lifecycle (init → hydrate → coerce →
// persist). V18 safeGet/safeSet wrappers. Mirrors timelineDockStore — same
// pattern, simpler shape.
//
// V8 file-rooted: src/app/stores/. No DAG mutation — the 2D view owns its
// own visual state; nothing routes through the Op system (V1) because no
// scene data is touched.
//
// REF: docs/UI-SPEC.md (R9 dock tab semantics); vyapti V8 + V18; krama K11.

import { create } from 'zustand';

const STORAGE_KEY = 'basher.twoDView.v1';

export type TwoDViewMode = 'uv' | 'render';

const VALID_MODES: readonly TwoDViewMode[] = ['uv', 'render'];

function isTwoDViewMode(value: unknown): value is TwoDViewMode {
  return typeof value === 'string' && (VALID_MODES as readonly string[]).includes(value);
}

export interface TwoDViewState {
  mode: TwoDViewMode;
}

export interface TwoDViewStore extends TwoDViewState {
  setMode: (mode: TwoDViewMode) => void;
}

const DEFAULT_STATE: TwoDViewState = { mode: 'uv' };

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

// K11 step 4 — narrow legacy / future-renamed mode ids back to the default
// rather than corrupt the store.
function readPersisted(): TwoDViewState {
  const raw = safeGetItem(STORAGE_KEY);
  if (!raw) return DEFAULT_STATE;
  try {
    const parsed = JSON.parse(raw) as Partial<TwoDViewState>;
    if (isTwoDViewMode(parsed.mode)) return { mode: parsed.mode };
    return DEFAULT_STATE;
  } catch {
    return DEFAULT_STATE;
  }
}

function writePersisted(state: TwoDViewState): void {
  safeSetItem(STORAGE_KEY, JSON.stringify(state));
}

export const useTwoDViewStore = create<TwoDViewStore>((set) => ({
  ...readPersisted(),

  setMode(mode) {
    if (!isTwoDViewMode(mode)) return;
    set({ mode });
    writePersisted({ mode });
  },
}));
