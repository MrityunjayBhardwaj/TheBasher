// PosedSkeleton — derive a pose from (skeleton, time) without an animation
// clip. Useful for testing the time-socket plumbing in isolation, and for
// nodes that pose procedurally.
//
// Inputs:
//   - skeleton (Skeleton, single)
//   - time (Time, single)
//
// Pure: deterministic procedural sway driven by a small phase offset per
// bone index. Same time → same pose. Verified by twice-eval at multiple t
// in CI.
//
// REF: THESIS.md §40, vyapti V2, V3.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type { BonePose, PosedSkeletonValue, SkeletonValue, TimeValue, Vec3 } from './types';

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
    time: { type: 'Time', cardinality: 'single' },
  },
  outputs: { out: { type: 'PosedSkeleton', cardinality: 'single' } },
  evaluate(params, inputs: ResolvedInputs) {
    const skeleton = inputs.skeleton as SkeletonValue | undefined;
    const time = inputs.time as TimeValue | undefined;
    const tSeconds = time?.seconds ?? 0;

    if (!skeleton) {
      return { kind: 'PosedSkeleton', skeleton: { kind: 'Skeleton', bones: [] }, poses: [] };
    }
    const poses: BonePose[] = [];
    for (let i = 0; i < skeleton.bones.length; i++) {
      const phase = (i * 0.7) % TWO_PI;
      const sway = Math.sin(tSeconds * params.frequency * TWO_PI + phase) * params.amplitude;
      const bind = skeleton.bones[i];
      const rot: Vec3 = [bind.rotation[0], bind.rotation[1] + sway, bind.rotation[2]];
      poses.push({ bone: i, position: bind.position, rotation: rot });
    }
    return { kind: 'PosedSkeleton', skeleton, poses };
  },
};
