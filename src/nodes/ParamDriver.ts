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
import type {
  KeyframeChannelNumberValue,
  KeyframeChannelVec3Value,
  KeyframeChannelValue,
  Vec3,
} from './types';

/** #296 — the nine readable transform channels of a controller node (Blender's
 *  Transform Channel driver types): t=translate, r=rotate(°), s=scale, per axis. */
export const TRANSFORM_CHANNELS = ['tx', 'ty', 'tz', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'] as const;
export type TransformChannel = (typeof TRANSFORM_CHANNELS)[number];

/** The "Transform Channel" source shape (#296): one transform channel of a controller
 *  node, optionally remapped through a range. Shared by the ParamDriver's transform
 *  road AND the stateful Lag node (#297), so both parse identically. */
export const TransformSourceSchema = z.object({
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
});

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
  /** Bottom→top fold position among all overlays on the band (V88 D2). Default 0.
   *  #315 — AUTHORABLE at last: the driver stack (`driverStackForTarget`) enumerates by
   *  this field and the two fold seams (overlayChannels / resolveEvaluatedParam) already
   *  stable-sort by it. Before the stack every creation site hardcoded 0, so the stable
   *  sort degenerated to node-table order — the arbitrary-order bug. Default 0 keeps a
   *  pre-stack project byte-identical (a no-op sort over an all-zero corpus). */
  order: z.number().default(0),
  /** #315 — Bypass. A muted driver contributes NOTHING to its band: it is dropped at
   *  ENUMERATION (so a bypassed stateful driver is never even replayed), and the flag is
   *  carried on the emitted channel value so both fold seams' existing mute gates
   *  (overlayChannels.ts:58) hold it out too. Mirrors `TrackTo.mute` — the pose twin.
   *  Default false → the pre-#315 channel-value shape is unchanged. */
  mute: z.boolean().default(false),
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
  sourceTransform: TransformSourceSchema.optional(),
  /** #300 F2b — the VEC controller road (the "Point controller"): the driver reads a
   *  controller node's WHOLE evaluated POSITION [x,y,z] as a Vector3 and folds it onto
   *  a Vector3 target (an object's position, an aim). The scalar `sourceTransform` reads
   *  ONE channel; this reads the whole position vector. Resolved in the enumeration seam
   *  via `resolveEvaluatedTransform` (the EVALUATED position, so an animated / gizmo-
   *  dragged controller drives correctly), NOT through `inVec`. Optional so other drivers
   *  serialize byte-identical. */
  sourceTransformVec: z.object({ node: z.string() }).optional(),
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
    // #315 — the driver's OWN bypass flag, not a hardcoded false. `?? false` because a
    // params object built by hand (not zod-parsed) has no `mute`, and this field is a
    // GATE: an `undefined` here must stay falsy, never leak into the fold as a
    // truthiness accident. Same defensiveness overlayChannels applies to blendMode/weight.
    //
    // NOTE this flag is BELT, not braces: the real bypass happens at ENUMERATION
    // (paramDrivers.driverStackForTarget drops muted members) — which is what makes mute
    // hold on BOTH roads. The render fold gates on `ch.mute` (overlayChannels.ts:58) but
    // the READ fold (resolveEvaluatedParam) does NOT, so relying on the fold gates alone
    // would mute the viewport and not the read side (an H40 render≠read split).
    mute: params.mute ?? false,
    weight: 1,
    blendMode: params.blendMode,
    order: params.order,
    valueType: 'number',
    sample,
  };
}

/** The Vec3 twin of {@link makeParamDriverChannelValueFn}: the folded value is a Vec3
 *  function of the playhead. A driver whose target is a Vector3 param (a position, an
 *  aim) folds a `KeyframeChannelVec3Value` — the SAME fold pipeline a position keyframe
 *  channel rides, so a vec driver and a vec channel compose identically. */
export function makeParamDriverVec3ChannelValueFn(
  params: ParamDriverParams,
  sample: (seconds: number) => Vec3,
): KeyframeChannelVec3Value {
  return {
    kind: 'KeyframeChannel',
    name: params.paramPath ? `→ ${params.paramPath}` : 'driver',
    target: params.target,
    paramPath: params.paramPath,
    mute: params.mute ?? false, // #315 — as the scalar twin above.
    weight: 1,
    blendMode: params.blendMode,
    order: params.order,
    valueType: 'vec3',
    sample,
  };
}

/** Build a Vec3 driver channel value from a single resolved vector (the constant twin
 *  of {@link makeParamDriverVec3ChannelValueFn}). */
export function makeParamDriverVec3ChannelValue(
  params: ParamDriverParams,
  value: Vec3,
): KeyframeChannelVec3Value {
  return makeParamDriverVec3ChannelValueFn(params, () => value);
}

/** A runtime Vec3 guard for the `inVec` road (a wired Vector3 output resolves to a
 *  3-number array). Anything else falls through to the scalar `in` road. */
function asVec3(v: unknown): Vec3 | null {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number')
    ? [v[0], v[1], v[2]]
    : null;
}

export const ParamDriverNode: NodeDefinition<ParamDriverParams, KeyframeChannelValue> = {
  type: 'ParamDriver',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: ParamDriverParams,
  // Two wired source roads, discriminated by the target param's type: `in` (a scalar
  // compute output) drives a Number param; `inVec` (a Vector3 compute output) drives a
  // Vector3 param (a position / aim). A bind wires exactly one; evaluate picks by which
  // is present. The edge-less spare/transform roads live in the seam, not here.
  inputs: {
    in: { type: 'Number', cardinality: 'single' },
    inVec: { type: 'Vector3', cardinality: 'single' },
  },
  // Introspection-only output (like Constraint/Strip/Track): the driver is enumerated
  // + overlay-resolved by the target's followers, never wired into the render graph.
  outputs: { out: { type: 'Number', cardinality: 'single' } },
  evaluate: (params, inputs): KeyframeChannelValue => {
    // The Vector3 road wins when `inVec` is wired (a Vec3 value) — it folds a vec3
    // channel onto a Vector3 target. Otherwise the scalar road: the evaluator resolves
    // `in` by walking the compute graph; an unbound driver reads 0 (parity with the
    // compute nodes' unconnected-input default). Constant over `t` for a stateless
    // compute leaf → H40. A spare/transform-sourced driver reads 0 HERE — its real
    // value is resolved in the paramDrivers seam (evaluate cannot see another node's
    // spare or a controller's evaluated transform).
    const vec = asVec3(inputs.inVec);
    if (vec) return makeParamDriverVec3ChannelValue(params, vec);
    const value = (inputs.in as number | undefined) ?? 0;
    return makeParamDriverChannelValue(params, value);
  },
};
