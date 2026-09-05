// LocomotionState — the integrating P2 node.
//
// Inputs:
//   - path (WalkPath, single)         — the trajectory
//   - clip (AnimationClip, single)    — the character's locomotion clip,
//                                       sampled at the input time
//   - time (Time, single)             — drives speed-along-path
//
// Output:
//   - LocomotionState { position, heading, pose }
//
// Pure: same (params, inputs) → same locomotion. Travel speed in
// world-units/second is a param; given a constant time and a constant
// path, a constant position falls out. The pose comes from the clip.
//
// Position-along-path:
//   distance = (time.seconds * speed) modulo path.length    (looping)
//   walk samples linearly until distance budget is consumed.
//   heading = atan2(dx, dz) on the active segment.
//
// REF: THESIS.md §40, vyapti V2, krama K7.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type {
  AnimationClipValue,
  BonePose,
  LocomotionStateValue,
  PosedSkeletonValue,
  TimeValue,
  Vec3,
  WalkPathValue,
} from './types';
import { buildClipBoneSamplers } from './AnimationClip';

export const LocomotionStateParams = z.object({
  /** World-units per second along the path. */
  speed: z.number().nonnegative().default(2),
  /** Loop the walk when the end is reached, vs. clamp to last sample. */
  loop: z.boolean().default(true),
});
export type LocomotionStateParams = z.infer<typeof LocomotionStateParams>;

const EMPTY_POSE: PosedSkeletonValue = {
  kind: 'PosedSkeleton',
  skeleton: { kind: 'Skeleton', bones: [] },
  poses: [],
};

/**
 * Sample the bound clip at this node's own time (#920).
 *
 * The clip used to arrive pre-posed, which made a CLIP a function of the current
 * frame. It is now a description, and this is the node that holds the `Time` to
 * sample it AT — so the sampling lands here rather than being invented upstream.
 *
 * It delegates to `buildClipBoneSamplers`, the SAME factory the baked render band
 * uses (#888), because a second interpolator would be a second answer to "where
 * is this bone at t" that drifts from the first silently. A bone the clip does
 * not touch holds its rest pose, exactly as before.
 */
function poseClipAt(clip: AnimationClipValue | undefined, tSeconds: number): PosedSkeletonValue {
  if (!clip) return EMPTY_POSE;
  const { skeleton } = clip;
  const samplers = buildClipBoneSamplers(clip);
  const poses: BonePose[] = [];
  for (let i = 0; i < skeleton.bones.length; i++) {
    const sampler = samplers.get(i);
    if (!sampler) {
      poses.push({
        bone: i,
        position: skeleton.bones[i].position,
        rotation: skeleton.bones[i].rotation,
      });
      continue;
    }
    const { position, rotation } = sampler(tSeconds);
    poses.push({ bone: i, position, rotation });
  }
  return { kind: 'PosedSkeleton', skeleton, poses };
}

function distanceAlong(
  samples: readonly Vec3[],
  distance: number,
  totalLength: number,
): { position: Vec3; heading: number } {
  if (samples.length === 0) return { position: [0, 0, 0], heading: 0 };
  if (samples.length === 1 || totalLength === 0) return { position: samples[0], heading: 0 };
  let remaining = distance;
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const segLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (segLen === 0) continue;
    if (remaining <= segLen) {
      const u = remaining / segLen;
      return {
        position: [a[0] + dx * u, a[1] + dy * u, a[2] + dz * u],
        heading: Math.atan2(dx, dz),
      };
    }
    remaining -= segLen;
  }
  // Past the end — return last sample with last segment heading.
  const last = samples[samples.length - 1];
  const prev = samples[samples.length - 2];
  return { position: last, heading: Math.atan2(last[0] - prev[0], last[2] - prev[2]) };
}

export const LocomotionStateNode: NodeDefinition<LocomotionStateParams, LocomotionStateValue> = {
  type: 'LocomotionState',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: LocomotionStateParams,
  inputs: {
    path: { type: 'WalkPath', cardinality: 'single' },
    clip: { type: 'AnimationClip', cardinality: 'single' },
    time: { type: 'Time', cardinality: 'single' },
  },
  outputs: { out: { type: 'LocomotionState', cardinality: 'single' } },
  evaluate(params, inputs: ResolvedInputs) {
    const path = inputs.path as WalkPathValue | undefined;
    const clip = inputs.clip as AnimationClipValue | undefined;
    const time = inputs.time as TimeValue | undefined;
    const tSeconds = time?.seconds ?? 0;

    if (!path || path.samples.length === 0) {
      return {
        kind: 'LocomotionState',
        position: [0, 0, 0],
        heading: 0,
        pose: poseClipAt(clip, tSeconds),
      };
    }
    const total = path.length;
    const traveled = tSeconds * params.speed;
    const distance =
      total > 0 && params.loop ? ((traveled % total) + total) % total : Math.min(traveled, total);
    const { position, heading } = distanceAlong(path.samples, distance, total);
    return {
      kind: 'LocomotionState',
      position,
      heading,
      pose: poseClipAt(clip, tSeconds),
    };
  },
};
