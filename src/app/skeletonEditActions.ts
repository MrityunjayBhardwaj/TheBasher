// Edit mode's one road into a skeleton edit (#1339): the keys, the inspector's Edit-bone section and
// the Edit-mode gizmo all call `editSkeletonFromUI`, which dispatches the agent's verb
// (`mutator.rig.editSkeleton`) and then selects the bone a director works on next — the new tip
// after an extrude, the first new piece after a subdivide, the edited bone otherwise — as Blender
// makes the extruded bone active.
//
// REF: src/app/animate/editSkeleton.ts (the operations); src/agent/mutators/builders/editSkeleton.ts
//      (the verb); issue #1339.

import { useDagStore } from '../core/dag/store';
import { dispatchMutatorFromUI } from './animate/dispatchMutator';
import { applySkeletonEdit, type SkeletonEdit } from './animate/editSkeleton';
import { rigReach } from './animate/renameBone';
import { useBoneSelectionStore } from './stores/boneSelectionStore';
import type { BoneSpec } from '../nodes/types';

/** The skeleton's bones under an armature Object, or null when it is not one. */
export function armatureBones(objectId: string): readonly BoneSpec[] | null {
  const state = useDagStore.getState().state;
  const reach = rigReach(state, objectId);
  if (!reach) return null;
  return ((state.nodes[reach.skeleton].params as { bones?: BoneSpec[] }).bones ?? []) as BoneSpec[];
}

/** Root first, `name` last. */
export function boneChain(bones: readonly BoneSpec[], name: string): string[] {
  const at = bones.findIndex((b) => b.name === name);
  const chain: string[] = [];
  for (let i = at, hops = 0; i >= 0 && hops <= bones.length; i = bones[i].parent, hops++) {
    chain.unshift(bones[i].name);
  }
  return chain;
}

export type EditOutcome = { ok: true } | { ok: false; reason: string };

/** Make `edit` on the armature `objectId`'s skeleton, and select the bone to work on next. */
export function editSkeletonFromUI(
  objectId: string,
  edit: SkeletonEdit,
  label: string,
): EditOutcome {
  const before = armatureBones(objectId);
  if (!before) return { ok: false, reason: 'the selection is not an armature.' };
  // The same pure operation the verb runs, read for the bone it makes active.
  const planned = applySkeletonEdit(before, edit);
  if (!planned.ok) return planned;
  const res = dispatchMutatorFromUI('mutator.rig.editSkeleton', { object: objectId, edit }, label);
  if (!res.ok) return res;
  const after = armatureBones(objectId) ?? [];
  if (planned.active) {
    useBoneSelectionStore
      .getState()
      .selectBone(objectId, planned.active, boneChain(after, planned.active));
  } else {
    useBoneSelectionStore.getState().clear();
  }
  return { ok: true };
}
