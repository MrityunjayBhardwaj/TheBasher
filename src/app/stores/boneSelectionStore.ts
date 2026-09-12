// Bone sub-selection — WHICH bone of a rig is being inspected (#973).
//
// Its own store, for the reason `curveSelectionStore` is its own store: a bone is
// not a node. It is an element of a skeleton, identified by (nodeId, name), and
// widening `selectionStore` to carry it would push a bone name through the
// outliner, the gizmo, box-select and the agent — none of which have any use for
// one.
//
// WHY THE CHAIN IS STORED AND THE POINT SELECTION'S ANALOGUE IS NOT. A curve
// point can be re-resolved from the DAG at any time, so its store holds only the
// pair. A bone's ancestry, as DRAWN, comes from the live three.js scene: the
// helper walks the actual Bone tree, which is the thing a director clicked. The
// DAG's projection of the same rig is a second answer to that question — the two
// even sanitise the same name differently (`mixamorig_Hips` against
// `mixamorigHips`), which cost a silent failure in #977. So the chain is
// captured at click time from the tree that was drawn, and this store carries it
// rather than inviting a reader to re-derive it somewhere else.
//
// The store is DUMB. Whether the pair still names a live bone is answered in ONE
// place — `boneSelection.ts` — and every reader goes through it.
//
// REF: src/app/boneSelection.ts (the validating accessor);
//      src/app/stores/curveSelectionStore.ts (the sub-selection precedent);
//      src/viewport/armaturePick.ts (where a click becomes one of these);
//      issues #973, #971.

import { create } from 'zustand';

export interface BoneSelectionStore {
  /** The DAG node that produced the rig; null = no bone selection. */
  nodeId: string | null;
  /** The bone's name as the LIVE three.js tree spells it. */
  boneName: string | null;
  /** Root first, the selected bone last. Empty when nothing is selected. */
  chain: readonly string[];
  selectBone: (nodeId: string, boneName: string, chain: readonly string[]) => void;
  clear: () => void;
}

export const useBoneSelectionStore = create<BoneSelectionStore>((set) => ({
  nodeId: null,
  boneName: null,
  chain: [],
  selectBone: (nodeId, boneName, chain) => set({ nodeId, boneName, chain }),
  clear: () => set({ nodeId: null, boneName: null, chain: [] }),
}));
