// KeyframeChannelImage — a discrete (step) IMAGE-REFERENCE animation channel. The
// reference-image trigger (COMFYUI-KEYFRAME-COMPILER-DESIGN.md §6.4): a
// `LoadImage.image` param holds an uploaded-image filename from its key until the
// next, with NO interpolation. The sampled value is the image reference string;
// uploading the bytes is the compiler/submit concern, not the channel's. Same
// function-of-time shape as the other channels (V24/D-04), step sampler.
//
// REF: src/nodes/KeyframeChannelText.ts (the step-string sibling it mirrors);
//      src/nodes/keyframeInterp.ts (sampleStepKeyframes); vyapti V2/V24/V57/V81.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { KeyframeChannelImageValue } from './types';
import { CHANNEL_BLEND_MODES } from './types';
import { sampleStepKeyframes } from './keyframeInterp';

export const KeyframeChannelImageParams = z.object({
  name: z.string().default('channel'),
  target: z.string().default(''),
  paramPath: z.string().default(''),
  mute: z.boolean().default(false),
  solo: z.boolean().default(false),
  weight: z.number().min(0).max(1).default(1),
  /** #283 Phase 1 (NLA) — layer composition. blendMode 'replace' (legacy
   *  last-writer lerp, default → byte-identical) | 'combine' (additive/manifold
   *  over the per-type identity); order = bottom→top fold position (default 0 →
   *  DAG order → byte-identical). REF: docs/NLA-DESIGN.md §3.1; vyapti V88 D2/D3. */
  blendMode: z.enum(CHANNEL_BLEND_MODES).default('replace'),
  order: z.number().default(0),
  keyframes: z
    .array(
      z.object({
        time: z.number().nonnegative(),
        /** An image reference — an uploaded filename (or content hash). */
        value: z.string(),
        easing: z.enum(['linear', 'cubic']).default('linear'),
      }),
    )
    .default([]),
});
export type KeyframeChannelImageParams = z.infer<typeof KeyframeChannelImageParams>;

export function buildImageSampler(params: KeyframeChannelImageParams): (seconds: number) => string {
  const sorted = [...params.keyframes].sort((a, b) => a.time - b.time);
  return (seconds: number) => sampleStepKeyframes(sorted, seconds, '');
}

export const KeyframeChannelImageNode: NodeDefinition<
  KeyframeChannelImageParams,
  KeyframeChannelImageValue
> = {
  type: 'KeyframeChannelImage',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: KeyframeChannelImageParams,
  // #421 — the channel is OWNED BY its target: a bound animation curve is
  // meaningless once the object it drives is gone (the long-standing H136 sweep,
  // now declared instead of hardcoded at the delete site).
  idRefs: [{ path: 'target', shape: 'id', role: 'subject' }],
  inputs: {},
  outputs: { out: { type: 'KeyframeChannel', cardinality: 'single' } },
  inspectorSections: ['channel', 'animate'],
  evaluate(params): KeyframeChannelImageValue {
    return {
      kind: 'KeyframeChannel',
      valueType: 'image',
      name: params.name,
      target: params.target,
      paramPath: params.paramPath,
      mute: params.mute,
      solo: params.solo,
      weight: params.weight,
      blendMode: params.blendMode,
      order: params.order,
      sample: buildImageSampler(params),
    };
  },
};
