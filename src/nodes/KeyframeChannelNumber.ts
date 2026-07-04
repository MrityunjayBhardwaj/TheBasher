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
import type { KeyframeChannelNumberValue } from './types';
import { sampleScalarKeyframesExtended, type ChannelExtend } from './keyframeInterp';

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
  /** Per-channel gate/blend lifted off the retired AnimationLayer (#199 / V57);
   *  identity defaults → byte-identical to pre-#199. */
  mute: z.boolean().default(false),
  weight: z.number().min(0).max(1).default(1),
  /** D1 (#269) — per-side extrapolation rule for times OUTSIDE the authored
   *  keyframe domain. Default 'hold' → byte-identical to the pre-#269 clamp. */
  extendBefore: z.enum(['hold', 'cycle', 'cycle-offset', 'mirror', 'slope']).default('hold'),
  extendAfter: z.enum(['hold', 'cycle', 'cycle-offset', 'mirror', 'slope']).default('hold'),
  /** #270 — repetition COUNT per side for the cycling extend rules (Blender
   *  FModifierCycles.count). 0 = infinite; past N the side freezes. Ignored by
   *  hold. Default 0 → byte-identical to the pre-count behaviour. */
  cyclesBefore: z.number().int().min(0).default(0),
  cyclesAfter: z.number().int().min(0).default(0),
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

/**
 * Sample the channel at clip-time `t`. Empty channels return 0; pre-keyframe
 * times clamp to the first sample, post-keyframe to the last. Interpolation is
 * the shared `sampleScalarKeyframes` (cubic Bézier when a segment carries
 * handles, else the exact legacy linear/smoothstep — render parity, V49).
 */
function sample(
  keyframes: KeyframeChannelNumberParams['keyframes'],
  t: number,
  before: ChannelExtend,
  after: ChannelExtend,
  cyclesBefore: number,
  cyclesAfter: number,
): number {
  return sampleScalarKeyframesExtended(keyframes, t, before, after, cyclesBefore, cyclesAfter);
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
      mute: params.mute,
      weight: params.weight,
      sample: (seconds: number) =>
        sample(
          sorted,
          seconds,
          params.extendBefore,
          params.extendAfter,
          params.cyclesBefore,
          params.cyclesAfter,
        ),
    };
  },
};
