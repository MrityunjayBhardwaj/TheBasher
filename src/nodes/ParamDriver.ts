// ParamDriver — the PULL half of the wire-less overlay rail (#293, Epic 1 Inc 2).
//
// A driver binds a target node's param to a COMPUTED value: its `in` Number input
// (fed by the Inc-1 compute vocabulary — Math/Fit/Clamp/…) overlays `target.paramPath`
// through the SAME resolution + fold that KeyframeChannel* already ride. It is the
// pull twin of the push overlay: instead of a CHOP-export pushing a value onto a
// param, the param reads a value out of the compute graph (Houdini `ch()`). Grounded
// in GROUND_TRUTH_HOUDINI_DRIVERS_CONTROLLERS.md §0/§1 (a driver = pull half of the
// rail Basher already built), decisions F1 (explicit relation node on the V88 rail,
// NOT a hidden "driven" flag on the target slot) + D-2 (authored via an inspector bind).
//
// SHAPE — a deliberate MIRROR of KeyframeChannel* (nodeChannels.ts): one edge-less
// relation `driver → {target, paramPath}` (enumerated by the target's followers, never
// wired — the V88 N2 pattern), and one REAL wired edge `compute.out → driver.in` (a
// Number socket, cycle-checked by the existing connect guard). Its `evaluate` returns a
// KeyframeChannelValue whose `.sample()` yields the resolved input — so the driver folds
// through `overlayChannels`/`foldChannelValue` byte-identically to a channel. The `out`
// output exists for introspection only (like Constraint/Strip), enumerated not wired.
//
// STATELESS → PURE → H40: the Inc-2 compute vocabulary has no time-varying leaf (no Time
// input), so a driver's value is CONSTANT over `t` → render == read under scrub for free.
// (Time-varying / stateful drivers = the interval+seed contract of Epic 2, not here.)
//
// REF: ref/GROUND_TRUTH_HOUDINI_DRIVERS_CONTROLLERS.md §0/§1/§7 (G1); vyapti V88 (rail) /
//      V89 (spare params) ; hetvabhasa H40; issue #293; memory project_drivers-controllers-opnet.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import { CHANNEL_BLEND_MODES } from './types';
import type { KeyframeChannelNumberValue } from './types';

/** #296 — the nine readable transform channels of a controller node (Blender's
 *  Transform Channel driver types): t=translate, r=rotate(°), s=scale, per axis. */
export const TRANSFORM_CHANNELS = ['tx', 'ty', 'tz', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'] as const;
export type TransformChannel = (typeof TRANSFORM_CHANNELS)[number];

export const ParamDriverParams = z.object({
  /** Target node id whose param this driver overlays (resolved at enumeration
   *  time, not at evaluator time — the KeyframeChannel* contract). '' = unbound. */
  target: z.string().default(''),
  /** Param path on the target — e.g. 'intensity', 'material.opacity'. */
  paramPath: z.string().default(''),
  /** Fold composition on the (target, paramPath) band, shared with channels: 'replace'
   *  (default — the driver REPLACES the param) or 'combine' (additive over the identity).
   *  Inc 2 authors only 'replace'; the field exists so a driver + channel stack folds
   *  deterministically (V88 D2/D3). */
  blendMode: z.enum(CHANNEL_BLEND_MODES).default('replace'),
  /** Bottom→top fold position among all overlays on the band (V88 D2). Default 0. */
  order: z.number().default(0),
  /** #294 (Inc 3) — the SECOND source road: instead of a wired compute output on
   *  `in`, the driver's value pulls directly from a promoted spare param on another
   *  node (the Houdini `ch("../ctrl/knob")` pull — GT §1, "the driver binding itself,
   *  not a node"). ABSENT = the wired `in` road (Inc 2). Present = the spare road: the
   *  value is resolved in the enumeration seam via readBaseParam (the evaluator cannot
   *  see another node's spare), NOT through `in`. Optional so Inc-2 drivers serialize
   *  byte-identical. */
  sourceSpare: z.object({ node: z.string(), key: z.string() }).optional(),
  /** #296 — the THIRD source road, the PRIMARY controller idiom (Blender's "Transform
   *  Channel" driver variable / Houdini `ch("../null/tx")`): the driver reads one
   *  TRANSFORM CHANNEL (tx…sz) of a controller node (a Null), optionally remapped
   *  through a range (`fit`, the "map a transform to a range" model). Resolved in the
   *  enumeration seam via `resolveEvaluatedTransform` (the EVALUATED local transform, so
   *  an animated / auto-keyed controller drives correctly), NOT through `in`. Optional
   *  so wired/spare drivers serialize byte-identical. */
  sourceTransform: z
    .object({
      node: z.string(),
      channel: z.enum(TRANSFORM_CHANNELS),
      remap: z
        .object({
          inMin: z.number(),
          inMax: z.number(),
          outMin: z.number(),
          outMax: z.number(),
        })
        .optional(),
    })
    .optional(),
});
export type ParamDriverParams = z.infer<typeof ParamDriverParams>;

/** Build the KeyframeChannelValue a ParamDriver overlays onto its target from a single
 *  resolved scalar. ONE builder shared by both source roads: `evaluate` feeds it the
 *  wired-`in` value; the spare road (paramDrivers.ts) feeds it the readBaseParam value
 *  — so a spare-sourced and a compute-sourced driver fold byte-identically. */
export function makeParamDriverChannelValue(
  params: ParamDriverParams,
  value: number,
): KeyframeChannelNumberValue {
  // A stateless driver folds a CONSTANT over `t` — the value is captured at build
  // time and `sample` ignores `seconds`.
  return makeParamDriverChannelValueFn(params, () => value);
}

/** The general builder: the folded value is a FUNCTION of the playhead `seconds`,
 *  not a constant. The stateless roads pass `() => value` (via
 *  {@link makeParamDriverChannelValue}); the STATEFUL road (statefulOps.ts) passes a
 *  `sample` that RE-INTEGRATES the recurrence from a seed up to `frame(seconds)` — so
 *  the same channel-value shape carries a memoryless OR a memoryful relation, and the
 *  fold seam / both H40 roads consume it identically (they all just call `sample`). */
export function makeParamDriverChannelValueFn(
  params: ParamDriverParams,
  sample: (seconds: number) => number,
): KeyframeChannelNumberValue {
  return {
    kind: 'KeyframeChannel',
    name: params.paramPath ? `→ ${params.paramPath}` : 'driver',
    target: params.target,
    paramPath: params.paramPath,
    mute: false,
    weight: 1,
    blendMode: params.blendMode,
    order: params.order,
    valueType: 'number',
    sample,
  };
}

export const ParamDriverNode: NodeDefinition<ParamDriverParams, KeyframeChannelNumberValue> = {
  type: 'ParamDriver',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: ParamDriverParams,
  inputs: { in: { type: 'Number', cardinality: 'single' } },
  // Introspection-only output (like Constraint/Strip/Track): the driver is enumerated
  // + overlay-resolved by the target's followers, never wired into the render graph.
  outputs: { out: { type: 'Number', cardinality: 'single' } },
  evaluate: (params, inputs): KeyframeChannelNumberValue => {
    // The evaluator resolves `in` by walking the compute graph (the real wired edge);
    // an unbound driver reads 0 (parity with the compute nodes' unconnected-input
    // default). Constant over `t` in Inc 2 (no time-varying compute leaf) → H40. A
    // spare-sourced driver (params.sourceSpare) reads 0 HERE — its real value is
    // resolved in the paramDrivers seam (evaluate cannot see another node's spare).
    const value = (inputs.in as number | undefined) ?? 0;
    return makeParamDriverChannelValue(params, value);
  },
};
