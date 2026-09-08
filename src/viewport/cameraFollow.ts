// cameraFollow — WHERE the view centre should sit when it is locked to
// something that moves (#856).
//
// THE PROBLEM IT EXISTS FOR. A retargeted character walks out of frame in about
// a second. Framing it once does not help, because the framing is a pose and the
// character is not staying still; and the two things a director reaches for both
// fail. `frameSelected` is a one-shot. Writing the camera transform directly is
// undone on the next frame, because OrbitControls rewrites BOTH ends of the view
// from its own state every frame:
//
//   offset = position - target ; … ; position = target + offset ; lookAt(target)
//   (node_modules/three-stdlib/controls/OrbitControls.js, `update`)
//
// Read as a fixed point, that same code says exactly how to win: translate the
// TARGET and the camera by the same vector and `update` reproduces the result
// unchanged, so the user keeps orbiting and dollying while the centre travels.
// That is one line of camera math and it already exists (`applyTarget` in
// src/app/character/framing.ts). What does NOT exist is the answer to "which
// point", and that is all this module is.
//
// GROUNDED IN BLENDER, which ships this feature as `View3D.lock_object` /
// `lock_bone` ("3D View center is locked to this object's position", read live
// off the RNA on 5.1.1 b70da489d7f4). Its implementation settles three design
// questions we would otherwise have guessed at —
// `view3d_viewmatrix_set`, source/blender/editors/space_view3d/view3d_view.cc:393
// (tag v5.1.1):
//
//   1. THE LOCK MOVES THE CENTRE ONLY. `viewquat` (orbit angle) and `rv3d->dist`
//      (zoom) are applied BEFORE the lock and are never touched by it; the lock
//      substitutes the followed point for `rv3d->ofs`, the stored pivot. So it
//      is a toggle over the user's own view, not a camera mode that takes it.
//   2. A RIG IS FOLLOWED BY A BONE, NOT BY ITS ORIGIN. For an armature Blender
//      reads `pchan->pose_mat[3]` — the POSED head of a named bone — precisely
//      because an armature object's origin does not move when the motion lives
//      in the pose. Ours is the same: root travel is written to `Bone` objects,
//      so the object a director selected sits still while the character walks.
//   3. IT DOES NOT APPLY IN CAMERA VIEW. The `RV3D_CAMOB` branch returns before
//      the lock block, so looking through a camera ignores it (view3d_view.cc:399).
//
// WHERE WE DIVERGE, and why. Blender has no default bone, so locking to an
// armature with no bone named follows an origin that does not move. We fall back
// to the WHOLE RIG's bounds centre instead, which is what a director means by
// "follow the character" and needs no second decision from them. The bounds come
// from `armatureBounds`, which already excludes root bones — measured there: a
// BVH transport root pinned at the world origin grew a rig's Z extent from 25 to
// 238 units across 1.5 s while the body never changed size.
//
// Pure: plain data in, a point out. No scene traversal, no store, no DAG — the
// caller does the live reads and hands the results over.
//
// REF: src/app/character/framing.ts (`applyTarget`, the camera half);
//      src/viewport/referenceRig.ts (`armatureBounds`);
//      src/viewport/armaturePick.ts (`assetIdsFor`, the node↔rig join);
//      node_modules/three-stdlib/controls/OrbitControls.js (`update`);
//      issue #856.

import { armatureBounds } from './referenceRig';
import type { BoneFrame } from './boneShape';

/** Which of the three answers the point came from. Reported rather than
 *  inferred: "the view did not follow" and "the view followed a thing that is
 *  not moving" look identical on screen, and only one of them is a bug. */
export type FollowSource = 'bone' | 'armature' | 'object';

export interface FollowPoint {
  readonly point: readonly [number, number, number];
  readonly source: FollowSource;
  /** The bone the point came from, when it came from one. */
  readonly bone: string | null;
}

/** One live armature, reduced to what choosing a point needs. */
export interface FollowArmature {
  /** Every DAG node id that names some part of this rig's asset — the set
   *  `assetIdsFor` builds. Membership, not equality: a director who clicks the
   *  body selects a `GltfChild` that is the armature's SIBLING, so the id they
   *  locked with is almost never the one on the armature's own ancestors. */
  readonly ids: ReadonlySet<string>;
  /** The rig as placed THIS frame, heads and tails in world space. */
  readonly frames: readonly BoneFrame[];
}

/**
 * The world point the view centre should sit on, or null when the lock names
 * nothing that is in the scene.
 *
 * `boneName` is matched EXACTLY, and that is correct rather than lax: it was
 * captured from the live three.js tree at click time (`ArmatureHelper` →
 * `boneSelectionStore`), which is the same tree `frames` is walked from. The
 * normalisation that the rest of the codebase applies to bone names exists for a
 * different boundary — the DAG projection spells the same bone `mixamorig_Hips`
 * where three spells it `mixamorigHips` — and applying it here would be a second
 * reconciliation of a name that never crossed that boundary.
 *
 * A named bone that is no longer in the rig falls through to the rig's centre
 * rather than returning null: the character is still there and still walking,
 * and refusing to follow it because one bone was renamed would be a worse
 * answer than following the body.
 */
export function followPoint(
  armatures: readonly FollowArmature[],
  nodeId: string,
  boneName: string | null,
  objectPoint: readonly [number, number, number] | null,
): FollowPoint | null {
  const rig = armatures.find((a) => a.ids.has(nodeId));
  if (rig && rig.frames.length > 0) {
    if (boneName !== null) {
      const frame = rig.frames.find((f) => f.name === boneName);
      if (frame) return { point: frame.head, source: 'bone', bone: frame.name };
    }
    const bounds = armatureBounds(rig.frames);
    if (!bounds.empty) {
      return {
        point: [bounds.center.x, bounds.center.y, bounds.center.z],
        source: 'armature',
        bone: null,
      };
    }
  }
  if (objectPoint) return { point: objectPoint, source: 'object', bone: null };
  return null;
}
