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
import type { KeyframeChannelVec3Value, Vec3 } from './types';
import { sampleVec3KeyframesExtended } from './keyframeInterp';

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
  /** Per-channel gate/blend lifted off the retired AnimationLayer (#199 / V57);
   *  identity defaults → byte-identical to pre-#199. */
  mute: z.boolean().default(false),
  weight: z.number().min(0).max(1).default(1),
  /** D1 (#269) — per-side extrapolation rule for times OUTSIDE the authored
   *  keyframe domain (cycle-offset on position = a walk cycle that travels).
   *  Default 'hold' → byte-identical to the pre-#269 clamp. */
  extendBefore: z.enum(['hold', 'cycle', 'cycle-offset', 'mirror', 'slope']).default('hold'),
  extendAfter: z.enum(['hold', 'cycle', 'cycle-offset', 'mirror', 'slope']).default('hold'),
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

/**
 * Build the function-of-time sampler for a vec3 channel (V24): sort the
 * keyframes ONCE, return a closure that interpolates per call. Exported so the
 * P7.12 baked-channel enumerator (`bakedGltfChannels.ts`, the resolver band)
 * reuses the SAME interpolation as the node's evaluate — one source of the
 * sampling math, no per-frame ctx/inputs needed (BLOCK-1 shared logic).
 * Interpolation is `sampleVec3Keyframes` (cubic Bézier when a segment carries
 * handles, else the exact legacy linear/smoothstep — render parity, V49).
 */
export function buildVec3Sampler(params: KeyframeChannelVec3Params): (seconds: number) => Vec3 {
  const sorted = [...params.keyframes].sort((a, b) => a.time - b.time);
  const { extendBefore, extendAfter } = params;
  return (seconds: number) =>
    sampleVec3KeyframesExtended(sorted, seconds, extendBefore, extendAfter);
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
      mute: params.mute,
      weight: params.weight,
      sample: buildVec3Sampler(params),
    };
  },
};
