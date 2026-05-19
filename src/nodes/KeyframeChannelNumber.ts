// KeyframeChannelNumber — a scalar animation channel.
//
// Drives a single number param on a target node (e.g. light.intensity, FOV,
// material.opacity). Holds a sorted list of keyframes; evaluates to the
// interpolated value at the input Time. The target + paramPath travel with
// the value so AnimationLayer / SceneFromDAG can apply it without re-resolving.
//
// Pure: same (params, inputs.time) → same value. Time enters via a `Time`
// input socket (V3); no useFrame, no Math.random.
//
// Interpolation:
//   - linear  — simple lerp between adjacent keyframes
//   - cubic   — smoothstep (Hermite with auto-tangents) for a soft default.
//               Wave C extends this with full bezier when handle drag lands.
// Out-of-range times clamp to the first / last keyframe.
//
// REF: THESIS §42, project_p3_plan, vyapti V2/V3.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type { Easing, KeyframeChannelNumberValue, TimeValue } from './types';

const HandleSchema = z
  .object({
    time: z.number(),
    value: z.number(),
  })
  .optional();

export const KeyframeChannelNumberParams = z.object({
  name: z.string().default('channel'),
  /** Target node id (resolved at apply time, not at evaluator time). */
  target: z.string().default(''),
  /** Param path on the target — e.g. 'intensity', 'fov'. */
  paramPath: z.string().default(''),
  keyframes: z
    .array(
      z.object({
        time: z.number().nonnegative(),
        value: z.number(),
        easing: z.enum(['linear', 'cubic']).default('linear'),
        inHandle: HandleSchema,
        outHandle: HandleSchema,
      }),
    )
    .default([]),
});
export type KeyframeChannelNumberParams = z.infer<typeof KeyframeChannelNumberParams>;

function smoothstep(u: number): number {
  return u * u * (3 - 2 * u);
}

function interp(aValue: number, bValue: number, u: number, easing: Easing): number {
  const t = easing === 'cubic' ? smoothstep(u) : u;
  return aValue + (bValue - aValue) * t;
}

/**
 * Sample the channel at clip-time `t`. Empty channels return 0; pre-keyframe
 * times clamp to the first sample, post-keyframe to the last.
 */
function sample(keyframes: KeyframeChannelNumberParams['keyframes'], t: number): number {
  if (keyframes.length === 0) return 0;
  if (t <= keyframes[0].time) return keyframes[0].value;
  const last = keyframes[keyframes.length - 1];
  if (t >= last.time) return last.value;
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    if (t >= a.time && t <= b.time) {
      const span = b.time - a.time;
      const u = span > 0 ? (t - a.time) / span : 0;
      return interp(a.value, b.value, u, b.easing);
    }
  }
  return last.value;
}

export const KeyframeChannelNumberNode: NodeDefinition<
  KeyframeChannelNumberParams,
  KeyframeChannelNumberValue
> = {
  type: 'KeyframeChannelNumber',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: KeyframeChannelNumberParams,
  inputs: {
    time: { type: 'Time', cardinality: 'single' },
  },
  outputs: { out: { type: 'KeyframeChannel', cardinality: 'single' } },
  inspectorSections: ['channel', 'animate'],
  evaluate(params, inputs: ResolvedInputs) {
    const time = inputs.time as TimeValue | undefined;
    const tSeconds = time?.seconds ?? 0;
    // Sort defensively — ops may insert keyframes out of order; sorting at
    // evaluator time keeps purity (same params → same sorted view) without
    // requiring callers to sort first. Shallow copy avoids mutating params.
    const sorted = [...params.keyframes].sort((a, b) => a.time - b.time);
    const value = sample(sorted, tSeconds);
    return {
      kind: 'KeyframeChannel',
      valueType: 'number',
      name: params.name,
      target: params.target,
      paramPath: params.paramPath,
      value,
    };
  },
};
