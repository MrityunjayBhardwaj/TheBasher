// KeyframeChannelText — a discrete (step) STRING animation channel. The prompt-
// travel case (COMFYUI-KEYFRAME-COMPILER-DESIGN.md §6.4): a `CLIPTextEncode.text`
// param holds a value from its key until the next, with NO interpolation. Same
// function-of-time value shape as the scalar/vec channels (V24/D-04 — no `time`
// input socket; evaluate is pure and returns a value carrying `sample(seconds)`),
// but the sampler is `sampleStepKeyframes` (hold, not lerp).
//
// REF: src/nodes/KeyframeChannelVec2.ts (the channel-add sibling it mirrors);
//      src/nodes/keyframeInterp.ts (sampleStepKeyframes — shared step core);
//      vyapti V2/V3/V24/V57/V81.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { KeyframeChannelTextValue } from './types';
import { sampleStepKeyframes } from './keyframeInterp';

export const KeyframeChannelTextParams = z.object({
  name: z.string().default('channel'),
  target: z.string().default(''),
  paramPath: z.string().default(''),
  mute: z.boolean().default(false),
  weight: z.number().min(0).max(1).default(1),
  keyframes: z
    .array(
      z.object({
        time: z.number().nonnegative(),
        value: z.string(),
        // Step channels ignore easing, but the keyframe schema carries it for
        // uniformity with the interpolated channels (the dopesheet writes it).
        easing: z.enum(['linear', 'cubic']).default('linear'),
      }),
    )
    .default([]),
});
export type KeyframeChannelTextParams = z.infer<typeof KeyframeChannelTextParams>;

/** Build the step sampler: sort once, hold the latest key's value at/before t. */
export function buildTextSampler(params: KeyframeChannelTextParams): (seconds: number) => string {
  const sorted = [...params.keyframes].sort((a, b) => a.time - b.time);
  return (seconds: number) => sampleStepKeyframes(sorted, seconds, '');
}

export const KeyframeChannelTextNode: NodeDefinition<
  KeyframeChannelTextParams,
  KeyframeChannelTextValue
> = {
  type: 'KeyframeChannelText',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: KeyframeChannelTextParams,
  inputs: {},
  outputs: { out: { type: 'KeyframeChannel', cardinality: 'single' } },
  inspectorSections: ['channel', 'animate'],
  evaluate(params): KeyframeChannelTextValue {
    return {
      kind: 'KeyframeChannel',
      valueType: 'text',
      name: params.name,
      target: params.target,
      paramPath: params.paramPath,
      mute: params.mute,
      weight: params.weight,
      sample: buildTextSampler(params),
    };
  },
};
