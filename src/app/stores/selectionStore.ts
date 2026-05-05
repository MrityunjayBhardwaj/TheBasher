// Selection store. Per V1 the actual DAG never mutates from selection
// changes — selection is a UI projection, not graph state.

import { create } from 'zustand';
import type { NodeId } from '../../core/dag/types';

export interface SelectionStore {
  selectedNodeId: NodeId | null;
  select: (id: NodeId | null) => void;
}

export const useSelectionStore = create<SelectionStore>((set) => ({
  selectedNodeId: null,
  select: (id) => set({ selectedNodeId: id }),
}));
