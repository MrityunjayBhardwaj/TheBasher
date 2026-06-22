// #224 — rename. The single "which node is being renamed inline, and where"
// state. ONE concern spanning three surfaces (outliner row, inspector header,
// the F2 shortcut) so they never disagree: F2 from anywhere starts the rename
// on the active node, and at most one inline editor is ever open.
//
// `scope` disambiguates WHICH surface renders the editable input — without it
// both the outliner row AND the inspector header would mount an autofocusing
// <input> for the same node and fight over focus. F2 targets the outliner
// (Blender's idiom: F2 renames the active object); a double-click renames in
// the surface that was clicked.
//
// This is pure UI projection (V1) — it never touches the DAG. The commit goes
// through the `setMeta` op like any other mutation.

import { create } from 'zustand';
import type { NodeId } from '../../core/dag/types';

export type RenameScope = 'outliner' | 'inspector';

export interface RenameStore {
  /** The node + surface currently editing its name inline, or null. */
  renaming: { nodeId: NodeId; scope: RenameScope } | null;
  /** Open the inline editor for `nodeId` in `scope`. */
  begin: (nodeId: NodeId, scope: RenameScope) => void;
  /** Close the inline editor (commit or cancel both land here). */
  cancel: () => void;
}

export const useRenameStore = create<RenameStore>((set) => ({
  renaming: null,
  begin: (nodeId, scope) => set({ renaming: { nodeId, scope } }),
  cancel: () => set({ renaming: null }),
}));
