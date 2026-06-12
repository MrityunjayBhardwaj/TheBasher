// Drill store — Spline/Blender-style "double-click to drill into a dense
// hierarchy" (UX-backlog #7). Selection is flat (selectionStore), so the drill
// DEPTH lives here, independent of which node is currently selected. This is the
// key to surviving the single-vs-double-click conflict: a browser double-click
// fires two `onClick`s (which select the top-level asset) BEFORE the
// `onDoubleClick` — if depth were derived from the live selection it would reset
// to the top every time. Keeping depth here, advanced ONLY by drillInto/popOut,
// lets repeated double-clicks march deeper.
//
// V1 stays clean: this is a UI projection (like selectionStore), never the DAG.

import { create } from 'zustand';
import type { NodeId } from '../../core/dag/types';

interface DrillState {
  /** The ancestor chain of the last drilled hit, top→leaf:
   *  `[assetId, child_root, …, child_leaf]`. Empty when not drilling. */
  chain: NodeId[];
  /** Current depth into `chain`. 0 = the top-level asset (whole model). */
  index: number;
  /** Signature of the chain currently being drilled — `chain.join('>')`. Detects
   *  "same spot, go deeper" vs "new object, restart at the first child". */
  sig: string | null;

  /** Advance toward the clicked leaf. Same spot → one level deeper (capped at the
   *  leaf, then wraps to the first child); a new spot (or a flat asset) → the
   *  first child. Returns the node id to select. */
  drillInto: (chain: NodeId[]) => NodeId;
  /** Esc — pop up one level. Returns the node id to select, or null at the top
   *  (the caller falls through to clear the selection). */
  popOut: () => NodeId | null;
  reset: () => void;
}

export const useDrillStore = create<DrillState>((set, get) => ({
  chain: [],
  index: 0,
  sig: null,

  drillInto: (chain) => {
    const s = get();
    const sig = chain.join('>');
    const last = chain.length - 1;
    // same chain AND room to go deeper → one level down; else → first child
    // (Math.min handles a flat asset where last === 1, and the leaf-wrap case).
    const index = s.sig === sig && s.index < last ? s.index + 1 : Math.min(1, last);
    set({ chain, sig, index });
    return chain[index];
  },

  popOut: () => {
    const s = get();
    if (s.chain.length === 0 || s.index <= 0) {
      set({ chain: [], index: 0, sig: null });
      return null;
    }
    const index = s.index - 1;
    set({ index });
    return s.chain[index];
  },

  reset: () => set({ chain: [], index: 0, sig: null }),
}));
