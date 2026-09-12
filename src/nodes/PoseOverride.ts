// PoseOverride — hand-pose a bone on a rig that something else is driving
// (#974, v3 of the armature epic; the consumer rung 2 of #900 was missing).
//
//   RetargetClip.posed  ──→  PoseOverride  ──→  (the pose band)
//
// The whole node is `PosedSkeleton → PosedSkeleton`: it takes the rig as posed by
// whatever is upstream and hands back the same rig with one bone's components
// replaced. That shape is `MaterialOverride`'s, one lane over — same sparse
// authored set, same presence-not-value rule, same "wrap the thing, replace part
// of it, pass it on" spine.
//
// WHY IT SITS AFTER THE RETARGET, NOT BEFORE. The question is settled by the
// sockets rather than by taste: `RetargetClip` consumes an `AnimationClip`, so a
// pose placed before it has nowhere to land — it would mean retargeting a single
// pose instead of a clip, which is a different operation. Downstream, the bone
// indices are the TARGET rig's, which is also the rig the director is looking at
// and clicking on. Posing the source rig would mean authoring against a skeleton
// that is not on screen.
//
// WHY THE BONE IS NAMED, NOT INDEXED. `BonePose.bone` is an index and stays one —
// index is the key across the render boundary, where two sanitisers disagree
// about spelling (#922). But an INDEX is not an authoring vocabulary: it is
// meaningful only against one skeleton, and the director picks a bone, not an
// ordinal. So the param is the bone NAME — the same key space as a
// KeyframeChannel's `childName` and the asset's `nodeNameMap` — and it is
// resolved to an index HERE, against the skeleton the incoming pose already
// carries. One reconciliation, at the one seam that has both halves in hand.
//
// LAZY, like everything else on this lane: `evaluate` resolves the bone index and
// returns a closure. No pose is computed until somebody samples, and a sample
// costs the upstream sample plus one array write.
//
// REF: src/nodes/MaterialOverride.ts (the shape); src/nodes/types.ts
//      (PosedSkeletonValue); src/nodes/RetargetClip.ts (the producer); issues
//      #974, #992, #900.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type { BonePose, PosedSkeletonValue, Vec3 } from './types';
import { nameParam } from './paramWidget';

// Local, as in TrackTo/FollowPath — the codebase declares this tuple per node
// rather than sharing one schema object.
const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

// The sparse per-field authored set, mirroring `MaterialOverriddenSet` (#124,
// V28) and for the same reason: the bit is EXPLICIT, never derived from
// value≠default. The params are seeded with a real TRS, so a value-equality test
// could not tell "the director authored this" from "this is the rest value" —
// and a director who drags a bone back to where it started must KEEP the
// override, or the upstream motion resurfaces underneath them.
export const PoseOverriddenSet = z
  .object({ position: z.boolean(), rotation: z.boolean() })
  .partial()
  .default({});

export const PoseOverrideParams = z.object({
  name: nameParam('pose-override'),
  /** The bone to pose, by NAME — the `nodeNameMap` / `childName` key space.
   *  Empty, or absent from the incoming rig, → inert (the pose passes through
   *  untouched, exactly as a muted override would). */
  bone: z.string().default(''),
  /** Authored local translation, applied when `overridden.position`. */
  position: Vec3Schema.default([0, 0, 0]),
  /** Authored local Euler rotation (degrees XYZ, the codebase convention),
   *  applied when `overridden.rotation`. */
  rotation: Vec3Schema.default([0, 0, 0]),
  overridden: PoseOverriddenSet,
  // NO `mute`. `MaterialOverride` — the shape this mirrors — has none either, and
  // for a reason worth keeping: an empty `overridden` set ALREADY means "authored
  // nothing", and the node passes its input straight through in that state. A
  // second off-switch would be a second vocabulary for bypass (the one the
  // operator-bypass gate exists to contain) expressing a state this node can
  // already represent.
});
export type PoseOverrideParams = z.infer<typeof PoseOverrideParams>;

const EMPTY_POSE: PosedSkeletonValue = {
  kind: 'PosedSkeleton',
  skeleton: { kind: 'Skeleton', bones: [] },
  sample: () => [],
};

export const PoseOverrideNode: NodeDefinition<PoseOverrideParams, PosedSkeletonValue> = {
  type: 'PoseOverride',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: PoseOverrideParams,
  inputs: { pose: { type: 'PosedSkeleton', cardinality: 'single' } },
  outputs: { out: { type: 'PosedSkeleton', cardinality: 'single' } },
  inspectorSections: ['animate'],
  evaluate(params, inputs: ResolvedInputs): PosedSkeletonValue {
    const upstream = inputs.pose as PosedSkeletonValue | undefined;
    if (!upstream) return EMPTY_POSE;

    const wantPosition = params.overridden.position === true;
    const wantRotation = params.overridden.rotation === true;
    // Resolved ONCE, here: the index this name denotes on THIS rig. A name the
    // rig does not carry resolves to -1 and the node is a pass-through rather
    // than an error — an unbound or mistyped bone is an ordinary authoring
    // state, the same way an unwired constraint target is.
    const index = params.bone
      ? upstream.skeleton.bones.findIndex((b) => b.name === params.bone)
      : -1;

    if (index < 0 || (!wantPosition && !wantRotation)) {
      // Nothing authored → hand the upstream value straight back BY REFERENCE.
      // Byte-identical to what arrived, so an inert override cannot perturb a
      // downstream identity check, and it costs nothing to leave one in a graph.
      return upstream;
    }

    const position: Vec3 = [params.position[0], params.position[1], params.position[2]];
    const rotation: Vec3 = [params.rotation[0], params.rotation[1], params.rotation[2]];

    return {
      kind: 'PosedSkeleton',
      skeleton: upstream.skeleton,
      sample: (seconds: number): readonly BonePose[] => {
        const base = upstream.sample(seconds);
        // Copy-on-write: only the overridden bone's entry is replaced, so every
        // other bone keeps the upstream object it already had.
        const out = base.slice();
        const at = out[index];
        if (at === undefined) return base;
        out[index] = {
          bone: at.bone,
          position: wantPosition ? position : at.position,
          rotation: wantRotation ? rotation : at.rotation,
        };
        return out;
      },
    };
  },
};
