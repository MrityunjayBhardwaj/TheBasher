// Which interaction mode an armature is in — Object, Edit or Pose (#1335).
//
// UI STATE ONLY. The mode decides what a click picks, which gizmo appears and whether the rest
// pose is drawn; evaluation never reads it, so entering or leaving a mode changes no node in the
// graph. Blender keeps the mode on the Object (`ob->mode |= OB_MODE_POSE`,
// `editors/armature/pose_edit.cc:77-95`) and its pose evaluation checks only edit bones and
// rest-position, never the mode (`blenkernel/intern/armature.cc:3079-3087`). Here it lives in a
// store beside the selection, which is where "what is the director working on" already lives,
// and not on the node, which would put an editor's state into the saved scene.
//
// The store is DUMB, as `boneSelectionStore` is: whether the pair is live (the armature is still
// the primary selection) is answered in ONE place — `armatureMode.ts` — and every reader goes
// through it.
//
// REF: src/app/armatureMode.ts (the validating accessor); src/app/stores/boneSelectionStore.ts
//      (the sub-selection precedent); issue #1335.

import { create } from 'zustand';

export type ArmatureMode = 'object' | 'edit' | 'pose';

export interface ArmatureModeStore {
  /** The armature Object the mode belongs to; null = object mode everywhere. */
  nodeId: string | null;
  mode: ArmatureMode;
  /**
   * #1339 — in Edit mode, whether moving a joint carries its children (`follow`) or leaves them
   * where they stand (`stay`, Houdini's Child Compensate). Read by the Edit-mode gizmo and the
   * inspector's rest fields, so the two move a joint the same way.
   */
  editChildren: 'follow' | 'stay';
  setMode: (nodeId: string, mode: ArmatureMode) => void;
  setEditChildren: (v: 'follow' | 'stay') => void;
  clear: () => void;
}

export const useArmatureModeStore = create<ArmatureModeStore>((set) => ({
  nodeId: null,
  mode: 'object',
  editChildren: 'follow',
  setEditChildren: (editChildren) => set({ editChildren }),
  setMode: (nodeId, mode) =>
    set(mode === 'object' ? { nodeId: null, mode: 'object' } : { nodeId, mode }),
  clear: () => set({ nodeId: null, mode: 'object' }),
}));
