// RetargetClip — the retarget as an OPERATOR, not as a bake (#901, rung 2 of #900).
//
// Before this node, binding a motion to a character ran the retarget math ONCE,
// at build time, and wrote the result into a brand-new `AnimationClip` node's
// params. That is a copy, and it has a copy's failure mode: change the source
// clip, or fix a wrong bone-name map, and nothing re-flows — the target keeps
// playing the old mapping with nothing on screen saying the two have drifted.
//
//   pose wire (source)      ─┐
//   BoneNameMap             ─┼─→  RetargetClip  ─→  AnimationClip (the target's)
//   Skeleton (target rig)   ─┘
//
// The source is the POSE WIRE (#1225): a clip's pose, a character's base layer,
// any point on a chain — sampled over the range the wire carries (Houdini's
// `clipinfo`), at the rate it carries unless `sampleRate` says otherwise. A clip's
// range lands the samples on its keys, so a clip retargets as it did when this
// input took the clip itself (`retargetWire.gate.test.ts` pins the agreement).
//
// The relationship now lives in the graph rather than in a snapshot of what the
// relationship once produced.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY IT IS TIME-FREE, AND WHY THAT — NOT `cost` — IS THE LEVER
// ─────────────────────────────────────────────────────────────────────────
// Measured on the real operands (78-bone source, 9360 keys / 120 frames, onto a
// 23-bone glTF rig): `retargetClip()` runs in ~12ms. That is fine once per graph
// change and ruinous once per frame — it alone would eat three quarters of a
// 60fps budget.
//
// `cost: 'expensive'` does NOT buy the difference. `def.cost` has zero readers in
// the whole tree and `evaluator.ts` describes it as a stub with no worker routing
// behind it. The lever that actually exists is purity: the evaluator appends
// `|t:frame.seconds` to the cache key when `pure: false`, so an impure node
// re-evaluates every frame. `pure: true` WITH NO `time` INPUT is what makes this
// recompute per graph change, and the content-addressed cache does the rest.
//
// ─────────────────────────────────────────────────────────────────────────
// IT EMITS BOTH A CLIP AND A POSED RIG (#992/#974, rung 2 of #900)
// ─────────────────────────────────────────────────────────────────────────
// This node used to return only a CLIP, and the reason recorded here was that a
// pose is an answer at one INSTANT, so producing one would need a `Time` input
// and put ~12ms on the frame path. That was true of the instant shape and is no
// longer true of the value: `PosedSkeletonValue` is now a function of time
// (`sample(seconds)`), so a posed rig can be emitted by a node that takes no
// `Time` input at all. The objection dissolved rather than being traded against.
//
// The other half of the old reason was that `PosedSkeletonValue` had no input
// socket anywhere, so a node emitting one would typecheck, validate, evaluate and
// drive nothing. That was an accurate description of a gap, not a design
// principle — and the gap was owned by this epic's own next rung. `PoseOverride`
// (#974) is the consumer, so the lane now terminates somewhere.
//
// THE `posed` OUTPUT IS ADDITIVE, and deliberately so. `out` stays an
// `AnimationClip`: 47 production sites and 19 test files treat this node as a
// clip carrier — the dep walk, `boundClipsForAsset`, the dopesheet, the bone-map
// editor, the agent builder all pair it with `AnimationClip` by TYPE. Replacing
// the output would have broken every one of them to add a lane none of them read.
// Both outputs are views of ONE computation: `posed` closes over the same
// retargeted keyframes through the same shared sampler factory, so the two can
// never disagree about where a bone is at t.
//
// WHY THE SOURCE RIG COMES OFF THE WIRE AND NOT OFF A FOURTH INPUT. The poses a
// wire samples pair index-for-index with the skeleton it carries. Taking the
// poses from one input and the rig from another makes an index/rig mismatch
// merely unlikely; reading `source.skeleton` makes it unrepresentable.
// `boundClipsForAsset` states the same reasoning for the same reason.
//
// REF: src/core/import/retarget.ts (retargetClip — the math, reused not
//      reimplemented); src/app/animate/retargetFromNodes.ts (the params-side
//      resolver the read band uses); src/nodes/BoneNameMap.ts; issues #900,
//      #901, #889.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import { retargetClip } from '../core/import/retarget';
import type {
  AnimationClipValue,
  AnimationKeyframe,
  BoneNameMapValue,
  PosedSkeletonValue,
  SkeletonValue,
  WireClipInfo,
} from './types';
import { clipLoopOf } from './clipLoop';
import { posedSkeletonFromClip } from './AnimationClip';
import { posesFromKeyframes } from '../core/import/keyframePoses';
import { eulerXYZFromQuat } from './bonePose';
import { nameParam } from './paramWidget';

/** Both views of one retarget: the clip, and that same clip as a posed rig.
 *  A `type` and not an `interface` on purpose — only a type alias gets TypeScript's
 *  implicit index signature, which is what makes it assignable to the
 *  `Record<string, O>` multi-output form `NodeDefinition.evaluate` declares. */
type RetargetOutputs = {
  readonly out: AnimationClipValue;
  readonly posed: PosedSkeletonValue;
};

/** Pair a clip with its posed view through the ONE shared adapter, so `out` and
 *  `posed` are guaranteed to be the same motion in two shapes. */
function both(out: AnimationClipValue): RetargetOutputs {
  return { out, posed: posedSkeletonFromClip(out) };
}

/**
 * The times of a wire's poses, counted from its range's start: `round(span · rate)` of them with both
 * ends included, or one at the start when that rounds below two. On a clip's pose they land on the
 * clip's keys (`clipInfoOf`). The one rule for "every pose" of a wire: the retarget samples by it, and
 * a bake keys by it (#1215).
 */
export function wirePoseTimes(range: WireClipInfo, rate: number): number[] {
  const span = range.end - range.start;
  const count = Math.max(1, Math.round(span * rate));
  const times: number[] = [];
  // One sample is a single pose, at the start: three samples a one-key clip once too.
  for (let i = 0; i < count; i++) times.push(count === 1 ? 0 : (i * span) / (count - 1));
  return times;
}

/**
 * #1225 — the source wire as keys the retarget math reads: every bone, sampled `round(span · rate)`
 * times across the wire's range with both ends included (at least twice), at times counted from the
 * range's start. Three's retarget samples the same count over the same span, so on a clip's pose the
 * samples land on the clip's keys (`clipInfoOf`). Rotations leave as XYZ euler radians, the keys'
 * current spelling; three turns them straight back into the quaternions the wire gave.
 */
export function wireKeyframes(
  source: PosedSkeletonValue,
  range: WireClipInfo,
  rate: number,
): AnimationKeyframe[] {
  const keyframes: AnimationKeyframe[] = [];
  for (const time of wirePoseTimes(range, rate)) {
    const poses = source.sample(range.start + time);
    poses.forEach((pose, bone) => {
      keyframes.push({
        bone,
        time,
        position: pose.position,
        rotation: eulerXYZFromQuat(pose.quaternion),
      });
    });
  }
  return keyframes;
}

export const RetargetClipParams = z.object({
  /** Output clip name. Empty → `<sourceName>_retargeted`, the math's own default. */
  name: nameParam(''),
  /** Is this the clip the director most recently bound? (#907) Mirrors
   *  `AnimationClip.active` — both are clip carriers in the one walk, so a flag
   *  on only one of them would leave the other's binds ordered by id. */
  active: z.boolean().default(false),
  /**
   * #1225 — samples per second taken off the source wire, as Houdini's MotionClip Sample Rate. 0 (the
   * default) uses the rate the wire carries, which is where the source's own keys sit.
   */
  sampleRate: z.number().nonnegative().default(0),
});
export type RetargetClipParams = z.infer<typeof RetargetClipParams>;

const EMPTY_SKELETON: SkeletonValue = { kind: 'Skeleton', bones: [] };

// `O` is the union of the SOCKET value types, not the record — a multi-output
// node's evaluate returns `Record<string, O>` (types.ts:523), and this is how
// `SampleGeometry` declares its three. `RetargetOutputs` names that record for
// readers and for the return annotation below.
export const RetargetClipNode: NodeDefinition<
  RetargetClipParams,
  AnimationClipValue | PosedSkeletonValue
> = {
  type: 'RetargetClip',
  version: 1,
  pure: true,
  // Inert either way (`def.cost` has no readers); 'cheap' is the honest label for
  // a node that runs once per graph change. Purity + no `time` input is the lever.
  cost: 'cheap',
  paramSchema: RetargetClipParams,
  inputs: {
    /**
     * #1225 — the motion to retarget, as the pose wire: a clip's pose, a character's base layer, any
     * point on a chain. Its `clip` range says what to sample; the source rig travels on it.
     */
    source: { type: 'PosedSkeleton', cardinality: 'single' },
    boneMap: { type: 'BoneNameMap', cardinality: 'single' },
    skeleton: { type: 'Skeleton', cardinality: 'single' },
  },
  outputs: {
    out: { type: 'AnimationClip', cardinality: 'single' },
    posed: { type: 'PosedSkeleton', cardinality: 'single' },
  },
  inspectorSections: ['animate'],
  evaluate(params, inputs: ResolvedInputs): RetargetOutputs {
    const source = inputs.source as PosedSkeletonValue | undefined;
    const boneMap = inputs.boneMap as BoneNameMapValue | undefined;
    const target = inputs.skeleton as SkeletonValue | undefined;
    const range = source?.clip;

    // An unwired input is not an error — it is a graph mid-construction. Answer
    // with an EMPTY clip rather than the source's keys: handing back the source
    // unretargeted would drive the target rig with another rig's bone indices,
    // which is the one failure this node exists to make unrepresentable. A source
    // with no range (a skeleton at rest) has no motion to retarget.
    if (!source || !range || !boneMap || !target || target.bones.length === 0) {
      return both({
        kind: 'AnimationClip',
        name: params.name || (range?.name ?? 'clip'),
        duration: range ? range.end : 0,
        loop: clipLoopOf(range?.loop),
        interpolation: 'linear',
        poses: [],
        skeleton: target ?? EMPTY_SKELETON,
      });
    }

    const result = retargetClip({
      // The source rig travels on the wire, with the poses it indexes.
      sourceBones: source.skeleton.bones,
      sourceClip: {
        name: range.name ?? 'clip',
        duration: range.end - range.start,
        keyframes: wireKeyframes(source, range, params.sampleRate || range.rate),
        // #919 — carried, so neither side decides the source's time domain for it.
        loop: clipLoopOf(range.loop),
      },
      targetBones: target.bones,
      nameMap: boneMap.map,
      ...(params.name ? { outputName: params.name } : {}),
    });

    // Sampled from the range's start; placed back where the source plays it.
    const keyframes =
      range.start === 0
        ? result.clipParams.keyframes
        : result.clipParams.keyframes.map((k) => ({ ...k, time: k.time + range.start }));
    return both({
      kind: 'AnimationClip',
      name: result.clipParams.name,
      duration: result.clipParams.duration + range.start,
      loop: result.clipParams.loop,
      // Sampled from the source at its rate, so the samples read linearly between them.
      interpolation: 'linear',
      // #1225 — the retargeted keys as timed poses on the TARGET rig's bone names.
      poses: posesFromKeyframes(keyframes, target.bones),
      // The TARGET rig — the poses name its bones.
      skeleton: target,
    });
  },
};
