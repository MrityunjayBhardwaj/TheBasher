// KeyframeChannelQuat — quaternion (xyzw) animation channel.
//
// Spherical interpolation (slerp) keeps the rotation arc on the unit sphere;
// a naive component lerp would bow the magnitude away from 1 and produce a
// non-rotation. Cubic easing applies smoothstep to the slerp parameter — same
// shape as the other channels, no sudden velocity changes.
//
// V0.5 keeps quaternion handles deferred (no inHandle/outHandle in the
// schema) — explicit quaternion bezier is rare in user-facing tools and
// adds substantial math; revisit when a real use case appears.
//
// P7.12 D-04 — function-of-time value shape (V24/V3 amended): no `time` input
// socket; evaluate is pure over (params) and returns a value carrying
// `sample(seconds)` (slerp closed over the sorted keyframes). Time enters at
// consumer cadence, so the channel's cache hits across playback frames
// (H48/H49). Pre-7.12 `TimeSource→channel.time` wires become harmless ghost
// bindings.
//
// REF: THESIS §42, project_p3_plan, vyapti V2/V3 (amended P7.10)/V24,
//      hetvabhasa H48/H49, PLAN 7.12 D-04.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { Easing, KeyframeChannelQuatValue, Quat } from './types';
import { CHANNEL_BLEND_MODES } from './types';
// slerp lives in quatMath now — the ONE shared unit-quat slerp, also consumed by
// the NLA layer-fold reducer (foldChannel.ts). No drift (H40).
import { slerp } from './quatMath';

const QuatSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export const KeyframeChannelQuatParams = z.object({
  name: z.string().default('channel'),
  target: z.string().default(''),
  paramPath: z.string().default(''),
  /** Per-channel gate/blend lifted off the retired AnimationLayer (#199 / V57);
   *  identity defaults → byte-identical to pre-#199. */
  mute: z.boolean().default(false),
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
        value: QuatSchema,
        easing: z.enum(['linear', 'cubic']).default('cubic'),
      }),
    )
    .default([]),
});
export type KeyframeChannelQuatParams = z.infer<typeof KeyframeChannelQuatParams>;

function smoothstep(u: number): number {
  return u * u * (3 - 2 * u);
}

function interp(a: Quat, b: Quat, u: number, easing: Easing): Quat {
  const t = easing === 'cubic' ? smoothstep(u) : u;
  return slerp(a, b, t);
}

function sample(keyframes: KeyframeChannelQuatParams['keyframes'], t: number): Quat {
  if (keyframes.length === 0) return [0, 0, 0, 1];
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

export const KeyframeChannelQuatNode: NodeDefinition<
  KeyframeChannelQuatParams,
  KeyframeChannelQuatValue
> = {
  type: 'KeyframeChannelQuat',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: KeyframeChannelQuatParams,
  // P7.12 D-04: no `time` input — time enters via value.sample(seconds).
  inputs: {},
  outputs: { out: { type: 'KeyframeChannel', cardinality: 'single' } },
  inspectorSections: ['channel', 'animate'],
  evaluate(params): KeyframeChannelQuatValue {
    // Sort ONCE in the closure; sample() slerps per call (function of time, V24).
    const sorted = [...params.keyframes].sort((a, b) => a.time - b.time);
    return {
      kind: 'KeyframeChannel',
      valueType: 'quat',
      name: params.name,
      target: params.target,
      paramPath: params.paramPath,
      mute: params.mute,
      weight: params.weight,
      blendMode: params.blendMode,
      order: params.order,
      sample: (seconds: number) => sample(sorted, seconds),
    };
  },
};
