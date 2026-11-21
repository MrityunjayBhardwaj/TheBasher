// splitViewStore — #1709, the one fixed split: the 2D View with the 3D view beside it.
//
// No free tiling. A space can show ONE second space beside it (2D + 3D now), with a divider, a
// swap and a collapse. This store holds only that layout choice:
//
//   { split: { uv, render }, twoDShare, collapsed, swapped }
//
//   - split      → per 2D mode, whether the 3D view shows beside it. The UV (texture) mode opens
//                  split; Render result opens unsplit (the decided defaults, board 11a).
//   - twoDShare  → the 2D side's share of the split band, between the divider limits. Stored as the
//                  2D side's share (not "the left pane's") so a swap keeps each side's size.
//   - collapsed  → the 3D side folded to its slim strip.
//   - swapped    → the 3D side on the left instead of the right.
//
// One localStorage key. K11 boot lifecycle (init → hydrate → coerce → persist). V18 safeGet/safeSet
// wrappers. Mirrors timelineDockStore. No DAG mutation — layout state only.
//
// REF: src/app/stores/timelineDockStore.ts (the pattern); src/app/layoutIslands.ts (splitPaneBoxes).

import { create } from 'zustand';
import type { TwoDViewMode } from './twoDViewStore';

const STORAGE_KEY = 'basher.splitView.v1';

/** The narrowest share either side may take, so neither side can be dragged to nothing. */
export const MIN_SPLIT_SHARE = 0.2;
export const MAX_SPLIT_SHARE = 0.8;
export const DEFAULT_SPLIT_SHARE = 0.5;

export function clampSplitShare(share: number): number {
  return Math.min(MAX_SPLIT_SHARE, Math.max(MIN_SPLIT_SHARE, share));
}

export type SplitByMode = Record<TwoDViewMode, boolean>;

export interface SplitViewState {
  split: SplitByMode;
  twoDShare: number;
  collapsed: boolean;
  swapped: boolean;
}

export interface SplitViewStore extends SplitViewState {
  setSplit: (mode: TwoDViewMode, on: boolean) => void;
  setTwoDShare: (share: number) => void;
  setCollapsed: (collapsed: boolean) => void;
  toggleSwapped: () => void;
}

export const DEFAULT_SPLIT_STATE: SplitViewState = {
  split: { uv: true, render: false },
  twoDShare: DEFAULT_SPLIT_SHARE,
  collapsed: false,
  swapped: false,
};

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

/** K11 step 4 — keep what is well-formed, fall back to the default field by field. */
export function coerceSplitState(value: unknown): SplitViewState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_SPLIT_STATE;
  const v = value as Record<string, unknown>;
  const s = (v.split && typeof v.split === 'object' ? v.split : {}) as Record<string, unknown>;
  return {
    split: {
      uv: typeof s.uv === 'boolean' ? s.uv : DEFAULT_SPLIT_STATE.split.uv,
      render: typeof s.render === 'boolean' ? s.render : DEFAULT_SPLIT_STATE.split.render,
    },
    twoDShare:
      typeof v.twoDShare === 'number' && Number.isFinite(v.twoDShare)
        ? clampSplitShare(v.twoDShare)
        : DEFAULT_SPLIT_STATE.twoDShare,
    collapsed: typeof v.collapsed === 'boolean' ? v.collapsed : DEFAULT_SPLIT_STATE.collapsed,
    swapped: typeof v.swapped === 'boolean' ? v.swapped : DEFAULT_SPLIT_STATE.swapped,
  };
}

function readPersisted(): SplitViewState {
  const raw = safeGetItem(STORAGE_KEY);
  if (!raw) return DEFAULT_SPLIT_STATE;
  try {
    return coerceSplitState(JSON.parse(raw));
  } catch {
    return DEFAULT_SPLIT_STATE;
  }
}

function pick(s: SplitViewState): SplitViewState {
  return { split: s.split, twoDShare: s.twoDShare, collapsed: s.collapsed, swapped: s.swapped };
}

export const useSplitViewStore = create<SplitViewStore>((set, get) => {
  const update = (patch: Partial<SplitViewState>) => {
    set(patch);
    safeSetItem(STORAGE_KEY, JSON.stringify(pick(get())));
  };
  return {
    ...readPersisted(),
    setSplit(mode, on) {
      if (mode !== 'uv' && mode !== 'render') return;
      update({ split: { ...get().split, [mode]: on } });
    },
    setTwoDShare(share) {
      if (!Number.isFinite(share)) return;
      update({ twoDShare: clampSplitShare(share) });
    },
    setCollapsed(collapsed) {
      update({ collapsed });
    },
    toggleSwapped() {
      update({ swapped: !get().swapped });
    },
  };
});
