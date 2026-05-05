// Selection store. Per V1 the actual DAG never mutates from selection
// changes — selection is a UI projection, not graph state.
//
// P2.1: extended to multi-select while preserving the single-id surface
// for callers that conceptually want one node (Gizmo, Inspector primary
// view). Internally a Set; externally `selectedNodeId` mirrors
// `primaryNodeId` (the most recently focused node) for backward
// compatibility with every P0/P1/P2 caller.

import { create } from 'zustand';
import type { NodeId } from '../../core/dag/types';

export interface SelectionStore {
  /** All currently-selected node ids (multi-select). */
  selectedNodeIds: ReadonlySet<NodeId>;
  /** The most-recently-focused id — what the gizmo binds to and the
   *  Inspector renders. Undefined when nothing is selected. */
  primaryNodeId: NodeId | null;

  /** @deprecated mirrors primaryNodeId. Kept so P0/P1/P2 callers don't
   *  break. New code should read primaryNodeId directly. */
  selectedNodeId: NodeId | null;

  /** Replace selection with `id` (or clear when null). */
  select: (id: NodeId | null) => void;
  /** Toggle `id` in the multi-set; primary becomes the toggled id when
   *  added, the next-most-recent when removed. */
  selectAdditive: (id: NodeId) => void;
  /** Replace selection with the given set in one mutation. */
  selectMany: (ids: readonly NodeId[]) => void;
  /** Empty the selection. */
  clear: () => void;
  /** Add every id in the DAG (caller passes the list). */
  selectAll: (ids: readonly NodeId[]) => void;
  /** Invert selection against the given universe. */
  invert: (allIds: readonly NodeId[]) => void;
}

export const useSelectionStore = create<SelectionStore>((set, get) => ({
  selectedNodeIds: new Set<NodeId>(),
  primaryNodeId: null,
  selectedNodeId: null,

  select(id) {
    if (id === null) {
      set({ selectedNodeIds: new Set(), primaryNodeId: null, selectedNodeId: null });
      return;
    }
    const next = new Set<NodeId>([id]);
    set({ selectedNodeIds: next, primaryNodeId: id, selectedNodeId: id });
  },

  selectAdditive(id) {
    const cur = new Set(get().selectedNodeIds);
    if (cur.has(id)) {
      cur.delete(id);
      const remaining = [...cur];
      const primary = remaining.length > 0 ? remaining[remaining.length - 1] : null;
      set({ selectedNodeIds: cur, primaryNodeId: primary, selectedNodeId: primary });
      return;
    }
    cur.add(id);
    set({ selectedNodeIds: cur, primaryNodeId: id, selectedNodeId: id });
  },

  selectMany(ids) {
    const next = new Set(ids);
    const primary = ids.length > 0 ? ids[ids.length - 1] : null;
    set({ selectedNodeIds: next, primaryNodeId: primary, selectedNodeId: primary });
  },

  clear() {
    set({ selectedNodeIds: new Set(), primaryNodeId: null, selectedNodeId: null });
  },

  selectAll(ids) {
    const next = new Set(ids);
    const primary = ids.length > 0 ? ids[ids.length - 1] : null;
    set({ selectedNodeIds: next, primaryNodeId: primary, selectedNodeId: primary });
  },

  invert(allIds) {
    const cur = get().selectedNodeIds;
    const next = new Set<NodeId>();
    for (const id of allIds) if (!cur.has(id)) next.add(id);
    const arr = [...next];
    const primary = arr.length > 0 ? arr[arr.length - 1] : null;
    set({ selectedNodeIds: next, primaryNodeId: primary, selectedNodeId: primary });
  },
}));
