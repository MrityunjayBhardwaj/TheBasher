// KeyframeChannelVec2 — a 2-vector animation channel (a layer's 2D
// position / scale — the Compositor's transform params, V83). The 2-component
// sibling of KeyframeChannelVec3: same function-of-time value shape (V24/D-04 —
// no `time` input socket; evaluate is pure over params and returns a value
// carrying `sample(seconds)`), same per-component interpolation, default cubic
// easing (spatial values look stiff under linear). The first vec2 param is a
// Layer's `transform.position` / `transform.scale`.
//
// REF: src/nodes/KeyframeChannelVec3.ts (the 3-vector sibling it mirrors);
//      src/nodes/keyframeInterp.ts (sampleVec2Keyframes — shared interp core);
//      vyapti V2/V3/V24/V57/V83.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { KeyframeChannelVec2Value, Vec2 } from './types';
import {
  sampleVec2KeyframesExtended,
  resolveExtend,
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

const Vec2Schema = z.tuple([z.number(), z.number()]);
const HandleSchema = z
  .object({
    time: z.number(),
    value: Vec2Schema,
  })
  .optional();

export const KeyframeChannelVec2Params = z.object({
  name: z.string().default('channel'),
  target: z.string().default(''),
  paramPath: z.string().default(''),
  /** Per-channel gate/blend lifted off the retired AnimationLayer (#199 / V57);
   *  identity defaults → byte-identical to pre-#199. */
  mute: z.boolean().default(false),
  weight: z.number().min(0).max(1).default(1),
  /** D1 (#269) / #275 — per-side EXTRAPOLATION for times OUTSIDE the authored
   *  keyframe domain: 'hold' (clamp, default) or 'slope' (linear). The cycling
   *  rules moved to a Cycles F-Modifier (#275). Default 'hold' → byte-identical. */
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
   *  for component i; absent → shared `modifiers`). Absent whole array → byte-identical. */
  axisModifiers: AxisModifiersSchema,
  keyframes: z
    .array(
      z.object({
        time: z.number().nonnegative(),
        value: Vec2Schema,
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
export type KeyframeChannelVec2Params = z.infer<typeof KeyframeChannelVec2Params>;

/**
 * Build the function-of-time sampler for a vec2 channel (V24): sort the keyframes
 * ONCE, return a closure that interpolates per call via `sampleVec2Keyframes` (the
 * SAME shared interp core as the scalar + vec3 channels — cubic Bézier when a
 * segment carries handles, else the exact legacy linear/smoothstep, render parity).
 */
export function buildVec2Sampler(params: KeyframeChannelVec2Params): (seconds: number) => Vec2 {
  const sorted = [...params.keyframes].sort((a, b) => a.time - b.time);
  const { modifiers, axisModifiers } = params;
  // #275 — resolve stored extrapolation + Cycles modifier into the engine's rule +
  // counts; the sampler & planExtend are unchanged (byte-identical). Cycles is resolved
  // from the SHARED stack only — extrapolation stays channel-level (#280).
  const { before, after, cyclesBefore, cyclesAfter } = resolveExtend(
    params.extendBefore,
    params.extendAfter,
    modifiers,
  );
  return (seconds: number) =>
    sampleVec2KeyframesExtended(
      sorted,
      seconds,
      before,
      after,
      cyclesBefore,
      cyclesAfter,
      modifiers,
      axisModifiers,
    );
}

export const KeyframeChannelVec2Node: NodeDefinition<
  KeyframeChannelVec2Params,
  KeyframeChannelVec2Value
> = {
  type: 'KeyframeChannelVec2',
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
  paramSchema: KeyframeChannelVec2Params,
  // D-04: no `time` input — time enters via value.sample(seconds).
  inputs: {},
  outputs: { out: { type: 'KeyframeChannel', cardinality: 'single' } },
  inspectorSections: ['channel', 'animate'],
  evaluate(params): KeyframeChannelVec2Value {
    return {
      kind: 'KeyframeChannel',
      valueType: 'vec2',
      name: params.name,
      target: params.target,
      paramPath: params.paramPath,
      mute: params.mute,
      weight: params.weight,
      sample: buildVec2Sampler(params),
    };
  },
};
