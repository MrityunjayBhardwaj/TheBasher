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
// bone. Outside the authored key range the per-side EXTEND rule decides, per
// component: a looping clip cycles its rotation and cycles its position WITH
// OFFSET, so a root that travels keeps travelling instead of teleporting home
// once per period (#924); a non-looping clip holds both endpoints. Bones
// without keyframes inherit their bind-pose from the input skeleton.
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
import { sampleVec3KeyframesExtended, type ChannelExtend, type Vec3Key } from './keyframeInterp';

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
function clipExtendRules(loop: boolean): {
  position: ChannelExtend;
  rotation: ChannelExtend;
} {
  return loop
    ? { position: 'cycle-offset', rotation: 'cycle' }
    : { position: 'hold', rotation: 'hold' };
}

/** A bone's pose as a function of wall-clock time — the clip's own sampling. */
export type ClipBoneSampler = (seconds: number) => { position: Vec3; rotation: Vec3 };

/**
 * Build a per-bone-INDEX sampler over a clip's keyframes: the clip's own
 * `sample(t)`, exposed as closures so a caller can invoke it at its own cadence.
 *
 * WHY THIS IS EXPORTED (#888). The baked band needs to reach a retargeted clip
 * for a bone that has no channel node, and it must produce the value the CLIP
 * would produce.
 *
 * It samples through the CHANNEL sampler (`sampleVec3KeyframesExtended`) while
 * naming the clip's own interpolation explicitly. The earlier note here warned
 * that rebuilding a clip's keys as channel params "forces a DEFAULT to be chosen
 * for properties the source never described", and that warning still stands for
 * EASING — which is why `easing: 'linear'` is stated at the call site rather than
 * inherited: it records what the clip does, it is not a default being picked.
 *
 * What changed (#924) is that the EXTEND rule is not such a property. A clip that
 * is sampled outside its key range must answer somehow, and `t % duration` was an
 * answer chosen by omission — one that cannot express travel, because it replays
 * identical frames. The extend vocabulary is where this project already keeps
 * that answer, so the clip band now speaks it instead of folding time itself.
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
  const { position: posRule, rotation: rotRule } = clipExtendRules(loop);
  const out = new Map<number, ClipBoneSampler>();
  for (const [bone, track] of groupByBone(params.keyframes)) {
    if (track.length === 0) continue;
    const sorted = [...track].sort((a, b) => a.time - b.time);
    // `easing: 'linear'` STATES what the clip does rather than choosing for it —
    // a clip keyframe carries no easing field and interpolates linearly. The mint
    // makes the identical call for the identical reason (bakeChannelOps.ts), so an
    // edited bone and an unedited one cannot disagree about the curve between two
    // keys. Measured on the real fixture: 94,068 in-range scalars over 78 bones,
    // worst delta exactly 0 against the clip's own lerp.
    const posKeys: Vec3Key[] = sorted.map((k) => ({
      time: k.time,
      value: k.position,
      easing: 'linear',
    }));
    const rotKeys: Vec3Key[] = sorted.map((k) => ({
      time: k.time,
      value: k.rotation,
      easing: 'linear',
    }));
    out.set(bone, (seconds: number) => {
      // A non-positive or NaN duration has no time domain to extend over, so every
      // time collapses to the first key rather than producing a pose of NaNs. The
      // schema forbids it, but these params are read straight off saved files by
      // the baked band (#888), where nothing has re-validated them.
      const t = duration > 0 ? seconds : sorted[0].time;
      return {
        position: sampleVec3KeyframesExtended(posKeys, t, posRule, posRule),
        rotation: sampleVec3KeyframesExtended(rotKeys, t, rotRule, rotRule),
      };
    });
  }
  return out;
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
