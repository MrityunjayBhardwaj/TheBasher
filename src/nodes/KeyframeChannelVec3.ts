// KeyframeChannelVec3 — a 3-vector animation channel (position, scale,
// Euler-degrees rotation). Mirrors KeyframeChannelNumber but interpolates
// per component. Default easing is cubic (smoothstep) — vec3 channels are
// usually spatial and look stiff under linear interpolation.
//
// P7.12 D-04 — function-of-time value shape (V24/V3 amended, mirrors P7.10
// TransformClip). No `time` input socket: evaluate is pure over (params) and
// returns a value carrying `sample(seconds)` (the existing module-private
// `sample(keyframes, t)` closed over the sorted keyframes). Time enters via
// the value's method at consumer cadence (AnimationLayer-render useFrame /
// the resolver band), so the channel's cache hits across playback frames
// instead of flipping every frame (H48/H49). Pre-7.12 saved projects with a
// `TimeSource→channel.time` wire become harmless ghost bindings: the
// evaluator ignores bindings to sockets the node no longer declares.
//
// REF: THESIS §42, project_p3_plan, vyapti V2/V3 (amended P7.10)/V24,
//      hetvabhasa H48/H49, PLAN 7.12 D-04.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { Easing, KeyframeChannelVec3Value, Vec3 } from './types';

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
const HandleSchema = z
  .object({
    time: z.number(),
    value: Vec3Schema,
  })
  .optional();

export const KeyframeChannelVec3Params = z.object({
  name: z.string().default('channel'),
  target: z.string().default(''),
  paramPath: z.string().default(''),
  // P7.12 #108 (BLOCK-2) — the COPY-ON-WRITE BAKE variant: when a glTF bone's
  // imported clip track is materialized into per-bone channels (bakeGltfChannel,
  // Wave D), each channel carries the bone's `childName` AND the owning asset's
  // `assetRef` so the renderer/read-side resolver can enumerate it by name with
  // no per-frame nodeNameMap inverse scan. These MUST be declared on the schema —
  // the DAG stores zod-PARSED params (ops.ts applyAddNode), so an undeclared key
  // would be silently stripped and the baked band would never be found. Optional
  // + absent on ordinary authored channels (addChannel), so it's a no-op there.
  childName: z.string().optional(),
  assetRef: z.string().optional(),
  keyframes: z
    .array(
      z.object({
        time: z.number().nonnegative(),
        value: Vec3Schema,
        easing: z.enum(['linear', 'cubic']).default('cubic'),
        inHandle: HandleSchema,
        outHandle: HandleSchema,
      }),
    )
    .default([]),
});
export type KeyframeChannelVec3Params = z.infer<typeof KeyframeChannelVec3Params>;

function smoothstep(u: number): number {
  return u * u * (3 - 2 * u);
}

function interp(a: Vec3, b: Vec3, u: number, easing: Easing): Vec3 {
  const t = easing === 'cubic' ? smoothstep(u) : u;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Build the function-of-time sampler for a vec3 channel (V24): sort the
 * keyframes ONCE, return a closure that interpolates per call. Exported so the
 * P7.12 baked-channel enumerator (`bakedGltfChannels.ts`, the resolver band)
 * reuses the SAME interpolation as the node's evaluate — one source of the
 * sampling math, no per-frame ctx/inputs needed (BLOCK-1 shared logic).
 */
export function buildVec3Sampler(params: KeyframeChannelVec3Params): (seconds: number) => Vec3 {
  const sorted = [...params.keyframes].sort((a, b) => a.time - b.time);
  return (seconds: number) => sample(sorted, seconds);
}

function sample(keyframes: KeyframeChannelVec3Params['keyframes'], t: number): Vec3 {
  if (keyframes.length === 0) return [0, 0, 0];
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

export const KeyframeChannelVec3Node: NodeDefinition<
  KeyframeChannelVec3Params,
  KeyframeChannelVec3Value
> = {
  type: 'KeyframeChannelVec3',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: KeyframeChannelVec3Params,
  // P7.12 D-04: no `time` input — time enters via value.sample(seconds).
  inputs: {},
  outputs: { out: { type: 'KeyframeChannel', cardinality: 'single' } },
  inspectorSections: ['channel', 'animate'],
  evaluate(params): KeyframeChannelVec3Value {
    // Sort ONCE in the closure; sample() interpolates per call (function of
    // time, V24). buildVec3Sampler is the shared sampler builder (also used by
    // the P7.12 baked-channel resolver band).
    return {
      kind: 'KeyframeChannel',
      valueType: 'vec3',
      name: params.name,
      target: params.target,
      paramPath: params.paramPath,
      sample: buildVec3Sampler(params),
    };
  },
};
