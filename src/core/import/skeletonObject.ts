// A motion nothing binds, standing in the scene as an Object of its own (#1056).
//
// A `.bvh` or `.fbx` lands as a `Skeleton` + an `AnimationClip` — data with no scene
// presence. When a character takes the clip that is right: the character is what gets looked
// at. When nothing does, the motion could not be looked at at all — no bones drawn, nothing to
// select, nothing to scrub. These are the ops that give that skeleton an Object, the same
// citizen an armature is in Blender (its own Object, pointing at armature data), so a motion
// can be judged on its own before anything is bound to it.
//
// THE OBJECT POINTS AT THE SKELETON ITSELF. `Object.data` accepts a `Skeleton` directly; no
// wrapper node is minted, because the skeleton is already the right noun
// (docs/OBJECT-DATA-SPLIT-DESIGN.md §0, "skeleton-as-data").
//
// SCALE. BVH declares no unit, and our own files run from 0.1 to 100 units against a
// metre-scale scene, so a caller that does not know the unit asks for `normalise` and the
// Object's `scale` is set so the rest pose stands at a human height. The height is measured
// the way the source-rig overlay measures one — `armatureBounds` over `boneTransforms`, a
// rig's transport root excluded — and it lands in `scale`, where it is visible and editable,
// rather than being baked into the bones.
//
// REF: src/viewport/referenceRig.ts (armatureBounds); src/nodes/ObjectNode.ts (the data
//      socket); src/app/asset/importBvhFbx.ts (the caller); issue #1056.

import type { Op } from '../dag/types';
import type { BoneSpec } from '../../nodes/types';
import { boneTransforms } from '../../viewport/boneShape';
import { armatureBounds } from '../../viewport/referenceRig';

/** The height an unbound rig of unknown unit is stood at, in metres. */
export const UNBOUND_RIG_HEIGHT_METRES = 1.8;

/** Below this a rig has no height to normalise by (no bones; a collapsed rig still has the
 *  minimum drawn bone length, so it lands above this). */
const MIN_HEIGHT = 1e-6;

/**
 * The uniform scale that stands `bones`' rest pose at {@link UNBOUND_RIG_HEIGHT_METRES}.
 *
 * 1 when the rig has no measurable height, so a degenerate rig draws at its own size rather
 * than being blown up by a division by almost nothing.
 */
export function normalisedRigScale(bones: readonly BoneSpec[]): number {
  const bounds = armatureBounds(boneTransforms(bones));
  if (bounds.empty || !(bounds.height >= MIN_HEIGHT)) return 1;
  return UNBOUND_RIG_HEIGHT_METRES / bounds.height;
}

/** The Object's id, derived from the skeleton's — one skeleton, one Object, reproducibly. */
export function skeletonObjectId(skeletonId: string): string {
  return `${skeletonId}_object`;
}

export interface SkeletonObjectArgs {
  readonly skeletonId: string;
  /** The skeleton's rest bones — what the scale is measured on. */
  readonly bones: readonly BoneSpec[];
  /** The scene aggregator the Object joins as a child. */
  readonly sceneNodeId: string;
  /** True when the caller does not know the unit and the rig should stand at human height. */
  readonly normalise: boolean;
}

/** The Object, its `data` edge from the skeleton, and its place among the scene's children. */
export function buildSkeletonObjectOps(args: SkeletonObjectArgs): {
  readonly ops: Op[];
  readonly objectId: string;
} {
  const objectId = skeletonObjectId(args.skeletonId);
  const s = args.normalise ? normalisedRigScale(args.bones) : 1;
  return {
    objectId,
    ops: [
      {
        type: 'addNode',
        nodeId: objectId,
        nodeType: 'Object',
        params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [s, s, s] },
      },
      {
        type: 'connect',
        from: { node: args.skeletonId, socket: 'out' },
        to: { node: objectId, socket: 'data' },
      },
      {
        type: 'connect',
        from: { node: objectId, socket: 'out' },
        to: { node: args.sceneNodeId, socket: 'children' },
      },
    ],
  };
}
