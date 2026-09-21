// KeyframeChannelQuat — quaternion (xyzw) animation channel.
//
// Spherical interpolation (slerp) keeps the rotation arc on the unit sphere;
// a naive component lerp would bow the magnitude away from 1 and produce a
// non-rotation. Cubic easing applies smoothstep to the slerp parameter — same
// shape as the other channels, no sudden velocity changes. 'constant' holds the
// previous key until the next and snaps (glTF STEP; Blender CONSTANT) — the one
// scalar-channel interpolation that means the same thing on a rotation.
//
// A key MAY carry bézier handles (#1157). A glTF rotation sampled CUBICSPLINE
// is a cubic over the four components, normalized after (spec Appendix C.5), and
// a slerp arc cannot hold that tangent — so a segment whose handles are stored is
// read as the spec defines it, and one with none slerps exactly as it always did.
// The handles are the key's, not the importer's: whoever writes the key can carry
// them, and keying an existing key keeps them (#1165). What a director still cannot
// do is SEE them — the curve editor has no quaternion projection yet (#1176).
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
import type { KeyframeChannelQuatValue, Quat } from './types';
import { CHANNEL_BLEND_MODES } from './types';
// The sampling itself lives in keyframeInterp, beside the scalar and vec samplers —
// the ONE road a keyframe curve is read through, slerp and bézier both. The slerp it
// uses is quatMath's, the same one the NLA layer-fold reducer (foldChannel.ts) folds
// with. No second copy of either.
import { sampleQuatKeyframes, type QuatKey } from './keyframeInterp';
import { nameParam } from './paramWidget';

const QuatSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

/** A handle is a (time, value) OFFSET from its key — the four components together,
 *  so the key stays one thing. Same shape as the vec channels' handles. */
const QuatHandleSchema = z
  .object({
    time: z.number(),
    value: QuatSchema,
  })
  .optional();

/** The interpolations a quaternion key takes. The Penner curves and handles stay
 *  on the scalar channels: they shape a value, and a slerp has no value axis. */
export const QUAT_EASINGS = ['linear', 'cubic', 'constant'] as const;
export type QuatEasing = (typeof QUAT_EASINGS)[number];

export const KeyframeChannelQuatParams = z.object({
  name: nameParam('channel'),
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
  keyframes: z
    .array(
      z.object({
        time: z.number().nonnegative(),
        value: QuatSchema,
        easing: z.enum(QUAT_EASINGS).default('cubic'),
        // #1157 — optional, and absent keeps the slerp road byte-identical. A glTF
        // CUBICSPLINE rotation lands its per-second tangents here as ±Δt/3 offsets,
        // the same shape the vec channels store.
        inHandle: QuatHandleSchema,
        outHandle: QuatHandleSchema,
      }),
    )
    .default([]),
});
export type KeyframeChannelQuatParams = z.infer<typeof KeyframeChannelQuatParams>;

function sample(keyframes: KeyframeChannelQuatParams['keyframes'], t: number): Quat {
  return sampleQuatKeyframes(keyframes as readonly QuatKey[], t);
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
  // #421 — the channel is OWNED BY its target: a bound animation curve is
  // meaningless once the object it drives is gone (the long-standing H136 sweep,
  // now declared instead of hardcoded at the delete site).
  idRefs: [{ path: 'target', shape: 'id', role: 'subject' }],
  // P7.12 D-04: no `time` input — time enters via value.sample(seconds).
  inputs: {},
  outputs: { out: { type: 'KeyframeChannel', cardinality: 'single' } },
  inspectorSections: ['channel', 'animate'],
  home: {
    paramPath: 'channel',
    weight: 'animate',
    keyframes: 'channel',
  },
  evaluate(params): KeyframeChannelQuatValue {
    // Sort ONCE in the closure; sample() interpolates per call (function of time, V24).
    const sorted = [...params.keyframes].sort((a, b) => a.time - b.time);
    return {
      kind: 'KeyframeChannel',
      valueType: 'quat',
      name: params.name,
      target: params.target,
      paramPath: params.paramPath,
      mute: params.mute,
      solo: params.solo,
      weight: params.weight,
      blendMode: params.blendMode,
      order: params.order,
      sample: (seconds: number) => sample(sorted, seconds),
    };
  },
};
