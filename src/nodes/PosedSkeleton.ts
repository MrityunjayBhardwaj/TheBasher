// PosedSkeleton — derive a pose from a skeleton without an animation clip.
// Useful for nodes that pose procedurally, and for exercising the pose lane
// in isolation.
//
// Inputs:
//   - skeleton (Skeleton, single)
//
// TIME IS NOT AN INPUT (#992, rung 2 of #900). It used to be: the node took a
// `Time` socket and returned the sway AT that instant, which meant its cache key
// carried `|i:` a hash that flipped every playback frame, so the node re-cooked
// per frame and handed a fresh object to React each time. Time now enters as a
// parameter of the emitted value (`sample(seconds)`) instead of as an edge, so
// `evaluate` is genuinely time-free, the node cooks once per graph change, and
// the caller samples at its own cadence. This is `TransformClipValue`'s P7.10
// change (#114) one node family over.
//
// Pure: deterministic procedural sway driven by a small phase offset per bone
// index. Same time → same pose, now proven through `sample` rather than through
// a re-evaluation.
//
// REF: THESIS.md §40, vyapti V2, V3; src/nodes/types.ts (PosedSkeletonValue);
//      issues #992, #900.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type { BonePose, PosedSkeletonValue, SkeletonValue, Vec3 } from './types';

export const PosedSkeletonParams = z.object({
  /** Sway amplitude in radians; bones rotate ±amp around their bind rotation. */
  amplitude: z.number().nonnegative().default(0.1),
  /** Sway frequency in Hz. */
  frequency: z.number().nonnegative().default(1),
});
export type PosedSkeletonParams = z.infer<typeof PosedSkeletonParams>;

const TWO_PI = Math.PI * 2;

export const PosedSkeletonNode: NodeDefinition<PosedSkeletonParams, PosedSkeletonValue> = {
  type: 'PosedSkeleton',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: PosedSkeletonParams,
  inputs: {
    skeleton: { type: 'Skeleton', cardinality: 'single' },
  },
  outputs: { out: { type: 'PosedSkeleton', cardinality: 'single' } },
  evaluate(params, inputs: ResolvedInputs): PosedSkeletonValue {
    const skeleton = inputs.skeleton as SkeletonValue | undefined;

    if (!skeleton) {
      const empty: SkeletonValue = { kind: 'Skeleton', bones: [] };
      return { kind: 'PosedSkeleton', skeleton: empty, sample: () => [] };
    }
    // The sway is closed over (params, skeleton) and parameterized by `seconds`.
    // Nothing is computed here: an unsampled pose costs nothing, which is the
    // point of the lane being lazy.
    const { amplitude, frequency } = params;
    return {
      kind: 'PosedSkeleton',
      skeleton,
      sample: (seconds: number): readonly BonePose[] => {
        const poses: BonePose[] = [];
        for (let i = 0; i < skeleton.bones.length; i++) {
          const phase = (i * 0.7) % TWO_PI;
          const sway = Math.sin(seconds * frequency * TWO_PI + phase) * amplitude;
          const bind = skeleton.bones[i];
          const rot: Vec3 = [bind.rotation[0], bind.rotation[1] + sway, bind.rotation[2]];
          poses.push({ bone: i, position: bind.position, rotation: rot });
        }
        return poses;
      },
    };
  },
};
