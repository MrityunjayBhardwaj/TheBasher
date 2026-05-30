// KeyframeChannelNumber — a scalar animation channel.
//
// Drives a single number param on a target node (e.g. light.intensity, FOV,
// material.opacity). Holds a sorted list of keyframes; evaluates to the
// interpolated value at the input Time. The target + paramPath travel with
// the value so AnimationLayer / SceneFromDAG can apply it without re-resolving.
//
// Pure: same (params) → same value-of-time. P7.12 D-04 (V24/V3 amended):
// no `time` input socket — time enters via the value's `sample(seconds)`
// closure at consumer cadence, not via an upstream Time edge. This keeps
// evaluate's cache key stable across playback frames (H48/H49). No useFrame,
// no Math.random. Pre-7.12 `TimeSource→channel.time` wires in saved projects
// become harmless ghost bindings (the evaluator ignores bindings to sockets
// the node no longer declares).
//
// Interpolation:
//   - linear  — simple lerp between adjacent keyframes
//   - cubic   — smoothstep (Hermite with auto-tangents) for a soft default.
//               Wave C extends this with full bezier when handle drag lands.
// Out-of-range times clamp to the first / last keyframe.
//
// REF: THESIS §42, project_p3_plan, vyapti V2/V3 (amended P7.10)/V24,
//      hetvabhasa H48/H49, PLAN 7.12 D-04.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { Easing, KeyframeChannelNumberValue } from './types';

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
  // P7.12 D-04: no `time` input — time enters via value.sample(seconds).
  inputs: {},
  outputs: { out: { type: 'KeyframeChannel', cardinality: 'single' } },
  inspectorSections: ['channel', 'animate'],
  evaluate(params): KeyframeChannelNumberValue {
    // Sort defensively ONCE in the closure — ops may insert keyframes out of
    // order; sorting at evaluator time keeps purity (same params → same sorted
    // view). sample() interpolates per call (function of time, V24).
    const sorted = [...params.keyframes].sort((a, b) => a.time - b.time);
    return {
      kind: 'KeyframeChannel',
      valueType: 'number',
      name: params.name,
      target: params.target,
      paramPath: params.paramPath,
      sample: (seconds: number) => sample(sorted, seconds),
    };
  },
};
