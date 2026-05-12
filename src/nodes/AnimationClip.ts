// AnimationClip — sample a keyframed clip at a given Time and produce a
// PosedSkeleton.
//
// Inputs:
//   - skeleton (Skeleton, single)
//   - time (Time, single)
//
// Pure: same (params, inputs.skeleton, inputs.time) → same pose. The clip
// keyframes live in params; the time-sample is taken from the input Time
// value, not from `ctx.time`. This is the V3 first-use that flips the
// invariant from NOT YET IMPLEMENTED → ALIGNED.
//
// Sampling: piecewise-linear interpolation between adjacent keyframes per
// bone. Looping: the input time is folded into [0, duration) so scrubbing
// past the clip end wraps cleanly. A pre-keyframe time clamps to keyframe 0;
// post-keyframe clamps to the last keyframe. Bones without keyframes inherit
// their bind-pose from the input skeleton.
//
// Discipline: NO three.js AnimationMixer (it secretly clocks). NO useFrame.
// All math is the local interpolator below.
//
// REF: THESIS.md §40, §49, vyapti V2, V3.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type {
  AnimationClipValue,
  AnimationKeyframe,
  BonePose,
  SkeletonValue,
  TimeValue,
  Vec3,
} from './types';

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

export const AnimationClipParams = z.object({
  name: z.string().default('clip'),
  duration: z.number().positive().default(2),
  /** When true, time is folded into [0, duration); else clamped to range. */
  loop: z.boolean().default(true),
  keyframes: z
    .array(
      z.object({
        bone: z.number().int().nonnegative(),
        time: z.number().nonnegative(),
        position: Vec3Schema.default([0, 0, 0]),
        rotation: Vec3Schema.default([0, 0, 0]),
      }),
    )
    .default([]),
});
export type AnimationClipParams = z.infer<typeof AnimationClipParams>;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** Group keyframes by bone, sorted ascending by time. Pure given (keyframes). */
function groupByBone(keyframes: readonly AnimationKeyframe[]): Map<number, AnimationKeyframe[]> {
  const map = new Map<number, AnimationKeyframe[]>();
  for (const k of keyframes) {
    const list = map.get(k.bone) ?? [];
    list.push(k);
    map.set(k.bone, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.time - b.time);
  return map;
}

/** Sample a single bone's track at clip-time `t`. Clamps at endpoints. */
function sampleBone(track: AnimationKeyframe[], t: number): { position: Vec3; rotation: Vec3 } {
  if (track.length === 0) return { position: [0, 0, 0], rotation: [0, 0, 0] };
  if (t <= track[0].time) return { position: track[0].position, rotation: track[0].rotation };
  const last = track[track.length - 1];
  if (t >= last.time) return { position: last.position, rotation: last.rotation };
  // Linear scan: clip keyframes are typically <50; binary search overkill.
  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i];
    const b = track[i + 1];
    if (t >= a.time && t <= b.time) {
      const span = b.time - a.time;
      const u = span > 0 ? (t - a.time) / span : 0;
      return {
        position: lerpVec3(a.position, b.position, u),
        rotation: lerpVec3(a.rotation, b.rotation, u),
      };
    }
  }
  return { position: last.position, rotation: last.rotation };
}

export const AnimationClipNode: NodeDefinition<AnimationClipParams, AnimationClipValue> = {
  type: 'AnimationClip',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: AnimationClipParams,
  inputs: {
    skeleton: { type: 'Skeleton', cardinality: 'single' },
    time: { type: 'Time', cardinality: 'single' },
  },
  outputs: { out: { type: 'AnimationClip', cardinality: 'single' } },
  inspectorSections: ['animate'],
  evaluate(params, inputs: ResolvedInputs) {
    const skeleton = inputs.skeleton as SkeletonValue | undefined;
    const time = inputs.time as TimeValue | undefined;
    const tSeconds = time?.seconds ?? 0;
    const folded = params.loop
      ? ((tSeconds % params.duration) + params.duration) % params.duration
      : Math.max(0, Math.min(tSeconds, params.duration));

    if (!skeleton) {
      return {
        kind: 'AnimationClip',
        name: params.name,
        duration: params.duration,
        pose: { kind: 'PosedSkeleton', skeleton: { kind: 'Skeleton', bones: [] }, poses: [] },
      };
    }

    const tracks = groupByBone(params.keyframes);
    const poses: BonePose[] = [];
    for (let i = 0; i < skeleton.bones.length; i++) {
      const track = tracks.get(i);
      if (!track || track.length === 0) {
        poses.push({
          bone: i,
          position: skeleton.bones[i].position,
          rotation: skeleton.bones[i].rotation,
        });
        continue;
      }
      const { position, rotation } = sampleBone(track, folded);
      poses.push({ bone: i, position, rotation });
    }
    return {
      kind: 'AnimationClip',
      name: params.name,
      duration: params.duration,
      pose: { kind: 'PosedSkeleton', skeleton, poses },
    };
  },
};
