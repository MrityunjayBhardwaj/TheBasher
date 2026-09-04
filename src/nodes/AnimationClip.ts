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

/**
 * Fold a wall-clock time into the clip's own time domain — looping folds into
 * [0, duration), else it clamps to the range. THE one folding rule: both
 * `evaluate` and the exported per-bone samplers below go through it, so a clip
 * sampled by the band and the same clip sampled by the node cannot disagree
 * about where time `t` lands.
 */
function foldClipTime(seconds: number, duration: number, loop: boolean): number {
  // A non-positive duration has no time domain to fold into, and `x % 0` is
  // NaN — which would propagate silently through every lerp into a bone pose
  // of NaNs and a bone that vanishes rather than an error anyone can trace.
  // The schema forbids it, but these params are also read straight off saved
  // files by the baked band (#888), where nothing has re-validated them.
  if (!(duration > 0)) return 0;
  return loop
    ? ((seconds % duration) + duration) % duration
    : Math.max(0, Math.min(seconds, duration));
}

/** A bone's pose as a function of wall-clock time — the clip's own sampling. */
export type ClipBoneSampler = (seconds: number) => { position: Vec3; rotation: Vec3 };

/**
 * Build a per-bone-INDEX sampler over a clip's keyframes: the clip's own
 * `sample(t)`, exposed as closures so a caller can invoke it at its own cadence.
 *
 * WHY THIS IS EXPORTED (#888). The baked band needs to reach a retargeted clip
 * for a bone that has no channel node, and it must produce the value the CLIP
 * would produce. Two roads were available and only this one is safe:
 *
 *   - rebuild the clip's keys as `KeyframeChannelVec3` params and sample those.
 *     A clip keyframe carries no easing field at all while a channel carries
 *     twelve easing modes plus bezier handles and an extrapolation rule, so
 *     rebuilding forces a DEFAULT to be chosen for properties the source never
 *     described. The last time that default was picked without thinking it was
 *     the interpolation defect the first half of #877 fixed.
 *   - delegate to the clip's own math, below. Nothing is defaulted because
 *     nothing is invented: the clip interpolates linearly (`lerpVec3`) because
 *     that is what the clip DOES, not because linear was chosen for it.
 *
 * Grouping happens once, per DAG change; the returned closures are invoked per
 * frame. Bones with no keyframes are ABSENT from the map rather than mapped to
 * a zero pose — the caller must be able to fall through to the bands below,
 * and a bone the clip never touched has no opinion to contribute.
 *
 * Rotation is in the clip's own units (RADIANS). Callers writing into a
 * degrees-valued band convert at that boundary; see
 * app/animate/ensureChannelForBone.ts, which is where that unit change is
 * documented, and app/bakedGltfChannels.ts, which makes the same conversion for
 * the read band.
 */
export function buildClipBoneSamplers(
  params: Pick<AnimationClipParams, 'keyframes' | 'duration' | 'loop'>,
): Map<number, ClipBoneSampler> {
  const { duration, loop } = params;
  const out = new Map<number, ClipBoneSampler>();
  for (const [bone, track] of groupByBone(params.keyframes)) {
    if (track.length === 0) continue;
    out.set(bone, (seconds: number) => sampleBone(track, foldClipTime(seconds, duration, loop)));
  }
  return out;
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

    if (!skeleton) {
      const empty: SkeletonValue = { kind: 'Skeleton', bones: [] };
      return {
        kind: 'AnimationClip',
        name: params.name,
        duration: params.duration,
        loop: params.loop,
        keyframes: params.keyframes,
        skeleton: empty,
        pose: { kind: 'PosedSkeleton', skeleton: empty, poses: [] },
      };
    }

    // The SAME per-bone samplers the baked band delegates to (#888), so a bone
    // posed here and the same bone resolved through the band cannot disagree.
    const samplers = buildClipBoneSamplers(params);
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
    return {
      kind: 'AnimationClip',
      name: params.name,
      duration: params.duration,
      loop: params.loop,
      keyframes: params.keyframes,
      // The rig the keys are indexed against — the SAME one this pose was
      // sampled on, so a consumer cannot pair the two from different sources.
      skeleton,
      pose: { kind: 'PosedSkeleton', skeleton, poses },
    };
  },
};
