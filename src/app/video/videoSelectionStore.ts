// videoSelectionStore — which Layer is selected in the Video editor space. Lifted
// out of LayerTimeline's local `useState` (spine 1c.3) so the Controls panel
// (§7.1) reads the SAME selection the timeline highlights: one source of truth,
// two surfaces (the AE contract — Effect Controls + the timeline track follow the
// same selected layer).
//
// Why a store, not a prop: the timeline (bottom) and the Controls panel (right
// rail) are SIBLINGS under VideoMode, not parent/child. A shared store is the
// smallest seam that keeps them in lock-step without threading the id through
// CompositionShell. UI projection only (V8): holds a node id, never layer data —
// the Layer node lives in the DAG (V1/V34), so a stale id (layer deleted) degrades
// to "no selection" rather than dangling (the consumer guards).
//
// In-memory (not persisted): a Layer node id is meaningless across a project
// switch / reload, exactly like compositionStore's active-comp id.
//
// REF: docs/COMPOSITOR-DESIGN.md §7.1; vyapti V8 (file-rooted UI store) + V34;
//      sibling: compositionStore. issue #237.

import { create } from 'zustand';
import type { NodeId } from '../../core/dag/types';

export interface VideoSelectionStore {
  /** The selected Layer node in Video mode, or null. */
  selectedLayerId: NodeId | null;
  setSelectedLayer(id: NodeId | null): void;
}

export const useVideoSelectionStore = create<VideoSelectionStore>((set) => ({
  selectedLayerId: null,
  setSelectedLayer(id) {
    set({ selectedLayerId: id });
  },
}));
