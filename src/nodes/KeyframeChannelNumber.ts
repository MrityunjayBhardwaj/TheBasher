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
import { CHANNEL_BLEND_MODES } from './types';
import {
  sampleScalarKeyframesExtended,
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
  migrateExtendParamsToCycles,
  type FChannelModifier,
} from './channelModifiers';

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
  solo: z.boolean().default(false),
  weight: z.number().min(0).max(1).default(1),
  /** #283 Phase 1 (NLA) — layer composition. blendMode 'replace' (legacy
   *  last-writer lerp, default → byte-identical) | 'combine' (additive/manifold
   *  over the per-type identity); order = bottom→top fold position (default 0 →
   *  DAG order → byte-identical). REF: docs/NLA-DESIGN.md §3.1; vyapti V88 D2/D3. */
  blendMode: z.enum(CHANNEL_BLEND_MODES).default('replace'),
  order: z.number().default(0),
  /** D1 (#269) / #275 — per-side EXTRAPOLATION for times OUTSIDE the authored
   *  keyframe domain: 'hold' (clamp, default → byte-identical to the pre-#269 clamp)
   *  or 'slope' (linear). The cycling rules moved to a Cycles F-Modifier (#275). */
  extendBefore: z
    .enum(EXTRAPOLATE_RULES as unknown as [ChannelExtrapolate, ...ChannelExtrapolate[]])
    .default('hold'),
  extendAfter: z
    .enum(EXTRAPOLATE_RULES as unknown as [ChannelExtrapolate, ...ChannelExtrapolate[]])
    .default('hold'),
  /** #274 (V88 D2) / #275 — per-channel F-MODIFIER STACK (Noise, Cycles …), applied
   *  on top of the evaluated + extended curve. Default `[]` → byte-identical. */
  modifiers: ChannelModifiersSchema,
  keyframes: z
    .array(
      z.object({
        time: z.number().nonnegative(),
        value: z.number(),
        easing: z.enum(KEYFRAME_INTERPS as unknown as [Easing, ...Easing[]]).default('linear'),
        // #272 — easing DIRECTION for the equation interps (sine…elastic); ignored
        // by linear/cubic/constant. Optional → defaults to 'inout' at sample time.
        ease: z.enum(EASE_DIRS as unknown as [EaseDir, ...EaseDir[]]).optional(),
        // #273 — bézier HANDLE TYPE (auto/auto-clamped/vector/aligned/free). Optional →
        // undefined = the pre-#273 stored-handle/legacy path (byte-identical). Opt-in only.
        handleType: z
          .enum(KEYFRAME_HANDLE_TYPES as unknown as [HandleType, ...HandleType[]])
          .optional(),
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
  extendBefore: ChannelExtrapolate,
  extendAfter: ChannelExtrapolate,
  modifiers: readonly FChannelModifier[],
): number {
  // #275 — resolve the stored extrapolation + Cycles modifier into the engine's
  // 5-value rule + counts; the sampler and planExtend are unchanged (byte-identical).
  const { before, after, cyclesBefore, cyclesAfter } = resolveExtend(
    extendBefore,
    extendAfter,
    modifiers,
  );
  return sampleScalarKeyframesExtended(
    keyframes,
    t,
    before,
    after,
    cyclesBefore,
    cyclesAfter,
    modifiers,
  );
}

export const KeyframeChannelNumberNode: NodeDefinition<
  KeyframeChannelNumberParams,
  KeyframeChannelNumberValue
> = {
  type: 'KeyframeChannelNumber',
  version: 2,
  // #275 v1→v2: split the D1 extend enum — hold/slope stay `extend{Before,After}`,
  // the cycle family moves to a Cycles F-Modifier. Byte-identical (resolveExtend maps
  // it straight back onto the unchanged planExtend inputs; proven in migrations.test).
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
  paramSchema: KeyframeChannelNumberParams,
  // #421 — the channel is OWNED BY its target: a bound animation curve is
  // meaningless once the object it drives is gone (the long-standing H136 sweep,
  // now declared instead of hardcoded at the delete site).
  idRefs: [{ path: 'target', shape: 'id', role: 'subject' }],
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
      solo: params.solo,
      weight: params.weight,
      blendMode: params.blendMode,
      order: params.order,
      sample: (seconds: number) =>
        sample(sorted, seconds, params.extendBefore, params.extendAfter, params.modifiers),
    };
  },
};
