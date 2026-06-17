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

const QuatSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export const KeyframeChannelQuatParams = z.object({
  name: z.string().default('channel'),
  target: z.string().default(''),
  paramPath: z.string().default(''),
  /** Per-channel gate/blend lifted off the retired AnimationLayer (#199 / V57);
   *  identity defaults → byte-identical to pre-#199. */
  mute: z.boolean().default(false),
  weight: z.number().min(0).max(1).default(1),
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

function dot(a: Quat, b: Quat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

function neg(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], -q[3]];
}

function normalize(q: Quat): Quat {
  const len = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  if (len === 0) return [0, 0, 0, 1];
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

/** Slerp a→b at u∈[0,1]. Picks the shortest arc by negating b when dot<0. */
function slerp(a: Quat, b: Quat, u: number): Quat {
  let d = dot(a, b);
  let bb: Quat = b;
  if (d < 0) {
    bb = neg(b);
    d = -d;
  }
  // Use lerp+normalize when nearly parallel — slerp degenerates to 0/0.
  if (d > 0.9995) {
    return normalize([
      a[0] + (bb[0] - a[0]) * u,
      a[1] + (bb[1] - a[1]) * u,
      a[2] + (bb[2] - a[2]) * u,
      a[3] + (bb[3] - a[3]) * u,
    ]);
  }
  const theta = Math.acos(d);
  const sinTheta = Math.sin(theta);
  const wA = Math.sin((1 - u) * theta) / sinTheta;
  const wB = Math.sin(u * theta) / sinTheta;
  return [
    a[0] * wA + bb[0] * wB,
    a[1] * wA + bb[1] * wB,
    a[2] * wA + bb[2] * wB,
    a[3] * wA + bb[3] * wB,
  ];
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
      sample: (seconds: number) => sample(sorted, seconds),
    };
  },
};
