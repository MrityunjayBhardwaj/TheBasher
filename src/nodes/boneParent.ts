// #1210 — an Object parented to a bone: what sits between the armature Object and the child.
//
// Blender (`object.cc`, `BKE_object_get_parent_matrix` → `ob_parbone`, 5.1.1): for
// `parent_type = 'BONE'` the parent matrix is the armature's world times the bone's posed matrix
// (`pchan->pose_mat`), then moved along the bone to its TAIL; a bone name the armature does not
// have logs a warning and parents as identity. Basher parents at the bone's HEAD — the joint's
// origin, which is what glTF means by a node under a joint, and what keeps a placement independent
// of the drawn bone length (#1217). Blender's importer adds `(0, -bone_length, 0)` to the child to
// undo its tail (`io_scene_gltf2/blender/imp/node.py`), so the world placement is the same.
//
// REF: ref/sources/blender-transform/object.cc (`ob_parbone`); issue #1210.

import type { Matrix4 } from 'three';
import { actionPoseOf } from './AnimationClip';
import { posedBoneMatrices } from './armatureDeform';
import type { ObjectValue } from './types';

/**
 * The matrix between `parent`'s own space and `child`'s, at `seconds`: the named bone's posed
 * matrix in armature space, or `null` when the child is not parented to a bone of this parent — a
 * parent that is not an armature Object, or a bone name its skeleton does not have (Blender's
 * identity, with nothing to warn through here).
 *
 * The pose is the one the armature Object's deform reads: its action when it poses this rig
 * (`actionPoseOf`), the rest otherwise.
 */
export function boneParentMatrix(
  parent: { readonly kind: string },
  child: object,
  seconds: number,
): Matrix4 | null {
  const bone = (child as { parentBone?: unknown }).parentBone;
  if (typeof bone !== 'string' || parent.kind !== 'Object') return null;
  const armature = parent as ObjectValue;
  const data = armature.data;
  if (data?.kind !== 'Skeleton') return null;
  const index = data.bones.findIndex((b) => b.name === bone);
  if (index < 0) return null;
  const action = actionPoseOf(armature) === null ? null : (armature.action ?? null);
  return posedBoneMatrices(data.bones, action, seconds)[index];
}
