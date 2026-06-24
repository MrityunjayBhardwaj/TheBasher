// compositionStore — which Composition node is the "active comp" in Video mode
// (the one the compositor viewer + layer timeline operate on). The Compositor's
// analogue of AE's frontmost comp.
//
// UI projection only (V8): holds a node id, never the comp data itself — the
// Composition node lives in the DAG (V1/V34). Resolving the id → the live node
// is the consumer's job (see `useActiveCompositionId`), so a stale id (node
// deleted, project switched) degrades to "no active comp" rather than dangling.
//
// In-memory (not persisted): a Composition node id is meaningless across a
// project switch / reload, so there is nothing safe to persist. On boot the
// active comp is null; `File ▸ New Composition` sets it, and a consumer may fall
// back to the first Composition node in the DAG when none is explicitly active.
//
// REF: vyapti V8 (file-rooted UI store) + V34 (data lives in the DAG);
//      sibling: twoDViewStore, timelineDockStore. docs/COMPOSITOR-DESIGN.md §4.1.

import { create } from 'zustand';
import type { NodeId } from '../../core/dag/types';

export interface CompositionStore {
  /** The explicitly-selected active Composition node, or null. */
  activeCompositionId: NodeId | null;
  setActiveComposition(id: NodeId | null): void;
}

export const useCompositionStore = create<CompositionStore>((set) => ({
  activeCompositionId: null,
  setActiveComposition(id) {
    set({ activeCompositionId: id });
  },
}));
