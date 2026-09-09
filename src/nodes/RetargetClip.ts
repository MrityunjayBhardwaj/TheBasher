// RetargetClip — the retarget as an OPERATOR, not as a bake (#901, rung 2 of #900).
//
// Before this node, binding a motion to a character ran the retarget math ONCE,
// at build time, and wrote the result into a brand-new `AnimationClip` node's
// params. That is a copy, and it has a copy's failure mode: change the source
// clip, or fix a wrong bone-name map, and nothing re-flows — the target keeps
// playing the old mapping with nothing on screen saying the two have drifted.
//
//   AnimationClip (source)  ─┐
//   BoneNameMap             ─┼─→  RetargetClip  ─→  AnimationClip (the target's)
//   Skeleton (target rig)   ─┘
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
// WHY THE SOURCE RIG COMES OFF THE CLIP AND NOT OFF A FOURTH INPUT. A keyframe's
// `bone` is an index, meaningful only against the skeleton it was authored for.
// Taking the keys from one input and the rig from another makes an index/rig
// mismatch merely unlikely; reading `sourceClip.skeleton` makes it
// unrepresentable. `boundClipsForAsset` states the same reasoning for the same
// reason.
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
  BoneNameMapValue,
  PosedSkeletonValue,
  SkeletonValue,
} from './types';
import { clipLoopOf } from './clipLoop';
import { posedSkeletonFromClip } from './AnimationClip';

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

export const RetargetClipParams = z.object({
  /** Output clip name. Empty → `<sourceName>_retargeted`, the math's own default. */
  name: z.string().default(''),
  /** Is this the clip the director most recently bound? (#907) Mirrors
   *  `AnimationClip.active` — both are clip carriers in the one walk, so a flag
   *  on only one of them would leave the other's binds ordered by id. */
  active: z.boolean().default(false),
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
    sourceClip: { type: 'AnimationClip', cardinality: 'single' },
    boneMap: { type: 'BoneNameMap', cardinality: 'single' },
    skeleton: { type: 'Skeleton', cardinality: 'single' },
  },
  outputs: {
    out: { type: 'AnimationClip', cardinality: 'single' },
    posed: { type: 'PosedSkeleton', cardinality: 'single' },
  },
  inspectorSections: ['animate'],
  evaluate(params, inputs: ResolvedInputs): RetargetOutputs {
    const sourceClip = inputs.sourceClip as AnimationClipValue | undefined;
    const boneMap = inputs.boneMap as BoneNameMapValue | undefined;
    const target = inputs.skeleton as SkeletonValue | undefined;

    // An unwired input is not an error — it is a graph mid-construction. Answer
    // with an EMPTY clip rather than the source's keys: handing back the source
    // unretargeted would drive the target rig with another rig's bone indices,
    // which is the one failure this node exists to make unrepresentable.
    if (!sourceClip || !boneMap || !target || target.bones.length === 0) {
      return both({
        kind: 'AnimationClip',
        name: params.name || (sourceClip?.name ?? 'clip'),
        duration: sourceClip?.duration ?? 0,
        loop: clipLoopOf(sourceClip?.loop),
        keyframes: [],
        skeleton: target ?? EMPTY_SKELETON,
      });
    }

    const result = retargetClip({
      sourceBones: sourceClip.skeleton.bones,
      sourceClip: {
        name: sourceClip.name,
        duration: sourceClip.duration,
        keyframes: sourceClip.keyframes,
        // #919 — carried, so the node agrees with the params resolver and neither
        // decides the source's time domain for it.
        loop: sourceClip.loop,
      },
      targetBones: target.bones,
      nameMap: boneMap.map,
      ...(params.name ? { outputName: params.name } : {}),
    });

    return both({
      kind: 'AnimationClip',
      name: result.clipParams.name,
      duration: result.clipParams.duration,
      loop: result.clipParams.loop,
      keyframes: result.clipParams.keyframes,
      // The TARGET rig — the indices in the emitted keys are the target's.
      skeleton: target,
    });
  },
};
