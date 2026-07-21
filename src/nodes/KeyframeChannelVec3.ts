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
import { CHANNEL_BLEND_MODES } from './types';
import {
  sampleVec3KeyframesExtended,
  resolveExtend,
  buildPerAxisExtend,
  KEYFRAME_INTERPS,
  EASE_DIRS,
  EXTRAPOLATE_RULES,
  KEYFRAME_HANDLE_TYPES,
  type ChannelExtrapolate,
  type Easing,
  type EaseDir,
  type HandleType,
} from './keyframeInterp';
import {
  ChannelModifiersSchema,
  AxisModifiersSchema,
  migrateExtendParamsToCycles,
} from './channelModifiers';

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
  solo: z.boolean().default(false),
  weight: z.number().min(0).max(1).default(1),
  /** #283 Phase 1 (NLA) — layer composition. blendMode 'replace' (legacy
   *  last-writer lerp, default → byte-identical) | 'combine' (additive/manifold
   *  over the per-type identity); order = bottom→top fold position (default 0 →
   *  DAG order → byte-identical). REF: docs/NLA-DESIGN.md §3.1; vyapti V88 D2/D3. */
  blendMode: z.enum(CHANNEL_BLEND_MODES).default('replace'),
  order: z.number().default(0),
  /** D1 (#269) / #275 — per-side EXTRAPOLATION for times OUTSIDE the authored
   *  keyframe domain: 'hold' (clamp, default) or 'slope' (linear). The cycling
   *  rules (cycle-offset on position = a walk that travels) moved to a Cycles
   *  F-Modifier (#275). Default 'hold' → byte-identical to the pre-#269 clamp. */
  extendBefore: z
    .enum(EXTRAPOLATE_RULES as unknown as [ChannelExtrapolate, ...ChannelExtrapolate[]])
    .default('hold'),
  extendAfter: z
    .enum(EXTRAPOLATE_RULES as unknown as [ChannelExtrapolate, ...ChannelExtrapolate[]])
    .default('hold'),
  /** #274 (V88 D2) / #275 — per-channel F-MODIFIER STACK (Noise, Cycles …); default
   *  `[]` → byte-identical. */
  modifiers: ChannelModifiersSchema,
  /** #280 — OPTIONAL per-axis modifier override (axisModifiers[i] = the complete stack
   *  for component i; absent → that axis uses the shared `modifiers`). Absent whole array
   *  → byte-identical to pre-#280. Blender: each axis is an independent F-curve. */
  axisModifiers: AxisModifiersSchema,
  /** #289 — OPTIONAL per-axis EXTRAPOLATION override (axisExtend[i] = the hold/slope for
   *  component i; `null` → that axis uses channel-level extendBefore/After). Per-axis Cycles
   *  lives in `axisModifiers[i]` (an override stack). Absent whole array → byte-identical.
   *  Blender: each axis F-curve extrapolates independently. */
  axisExtend: z
    .array(
      z
        .object({
          before: z.enum(
            EXTRAPOLATE_RULES as unknown as [ChannelExtrapolate, ...ChannelExtrapolate[]],
          ),
          after: z.enum(
            EXTRAPOLATE_RULES as unknown as [ChannelExtrapolate, ...ChannelExtrapolate[]],
          ),
        })
        .nullable(),
    )
    .optional(),
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
        easing: z.enum(KEYFRAME_INTERPS as unknown as [Easing, ...Easing[]]).default('cubic'),
        ease: z.enum(EASE_DIRS as unknown as [EaseDir, ...EaseDir[]]).optional(),
        // #273 — bézier HANDLE TYPE; optional, undefined = pre-#273 path (byte-identical).
        handleType: z
          .enum(KEYFRAME_HANDLE_TYPES as unknown as [HandleType, ...HandleType[]])
          .optional(),
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
  const { modifiers, axisModifiers, axisExtend } = params;
  // #275 — resolve stored extrapolation + Cycles modifier into the engine's rule +
  // counts; the sampler & planExtend are unchanged (byte-identical). This is the
  // channel-level fallback for axes with no per-axis override.
  const { before, after, cyclesBefore, cyclesAfter } = resolveExtend(
    params.extendBefore,
    params.extendAfter,
    modifiers,
  );
  // #289 — per-axis extrapolation/Cycles: resolve each axis against its OWN extrapolation
  // + effective stack; undefined (no per-axis mods AND no per-axis extend) → the sampler's
  // channel-level fast path, byte-identical.
  const perAxisExtend = buildPerAxisExtend(
    3,
    params.extendBefore,
    params.extendAfter,
    modifiers,
    axisModifiers,
    axisExtend,
  );
  return (seconds: number) =>
    sampleVec3KeyframesExtended(
      sorted,
      seconds,
      before,
      after,
      cyclesBefore,
      cyclesAfter,
      modifiers,
      axisModifiers,
      perAxisExtend,
    );
}

export const KeyframeChannelVec3Node: NodeDefinition<
  KeyframeChannelVec3Params,
  KeyframeChannelVec3Value
> = {
  type: 'KeyframeChannelVec3',
  version: 2,
  // #275 v1→v2: split the D1 extend enum (see KeyframeChannelNumber). Byte-identical.
  migrations: {
    1: (oldParams) => {
      const { extendBefore, extendAfter, modifiers } = migrateExtendParamsToCycles(oldParams);
      const rest = { ...(oldParams as Record<string, unknown>) };
      delete rest.cyclesBefore;
      delete rest.cyclesAfter;
      return { ...rest, extendBefore, extendAfter, modifiers };
    },
  },
  pure: true,
  cost: 'cheap',
  paramSchema: KeyframeChannelVec3Params,
  // #421 — the channel is OWNED BY its target: a bound animation curve is
  // meaningless once the object it drives is gone (the long-standing H136 sweep,
  // now declared instead of hardcoded at the delete site).
  idRefs: [{ path: 'target', shape: 'id', role: 'subject' }],
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
      solo: params.solo,
      weight: params.weight,
      blendMode: params.blendMode,
      order: params.order,
      sample: buildVec3Sampler(params),
    };
  },
};
