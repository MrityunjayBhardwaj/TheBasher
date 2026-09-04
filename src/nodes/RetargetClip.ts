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
// That is why this node returns a CLIP and not a pose. A pose is an answer at one
// instant, so producing one would require a `Time` input, which would put ~12ms
// on the frame path. It is also why `AnimationClipValue.pose` is optional: a
// time-free producer omits it rather than inventing an answer at t=0.
//
// WHY A CLIP AND NOT A POSED RIG (the placement fork #901 asked to be answered in
// writing). Every reader that actually drives pixels today is params-side, behind
// the one `boundClipsForAsset` edge walk: the render band, the dopesheet, the
// channel mint, the format migration. `AnimationClipValue` has no production
// consumer at all and `PosedSkeletonValue` has no input socket anywhere — so a
// node emitting a posed rig would typecheck, validate, evaluate, and drive
// nothing. See the answer posted on #901.
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
import type { AnimationClipValue, BoneNameMapValue, SkeletonValue } from './types';

export const RetargetClipParams = z.object({
  /** Output clip name. Empty → `<sourceName>_retargeted`, the math's own default. */
  name: z.string().default(''),
});
export type RetargetClipParams = z.infer<typeof RetargetClipParams>;

const EMPTY_SKELETON: SkeletonValue = { kind: 'Skeleton', bones: [] };

export const RetargetClipNode: NodeDefinition<RetargetClipParams, AnimationClipValue> = {
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
  outputs: { out: { type: 'AnimationClip', cardinality: 'single' } },
  inspectorSections: ['animate'],
  evaluate(params, inputs: ResolvedInputs): AnimationClipValue {
    const sourceClip = inputs.sourceClip as AnimationClipValue | undefined;
    const boneMap = inputs.boneMap as BoneNameMapValue | undefined;
    const target = inputs.skeleton as SkeletonValue | undefined;

    // An unwired input is not an error — it is a graph mid-construction. Answer
    // with an EMPTY clip rather than the source's keys: handing back the source
    // unretargeted would drive the target rig with another rig's bone indices,
    // which is the one failure this node exists to make unrepresentable.
    if (!sourceClip || !boneMap || !target || target.bones.length === 0) {
      return {
        kind: 'AnimationClip',
        name: params.name || (sourceClip?.name ?? 'clip'),
        duration: sourceClip?.duration ?? 0,
        loop: sourceClip?.loop ?? true,
        keyframes: [],
        skeleton: target ?? EMPTY_SKELETON,
      };
    }

    const result = retargetClip({
      sourceBones: sourceClip.skeleton.bones,
      sourceClip: {
        name: sourceClip.name,
        duration: sourceClip.duration,
        keyframes: sourceClip.keyframes,
      },
      targetBones: target.bones,
      nameMap: boneMap.map,
      ...(params.name ? { outputName: params.name } : {}),
    });

    return {
      kind: 'AnimationClip',
      name: result.clipParams.name,
      duration: result.clipParams.duration,
      loop: result.clipParams.loop,
      keyframes: result.clipParams.keyframes,
      // The TARGET rig — the indices in the emitted keys are the target's.
      skeleton: target,
    };
  },
};
