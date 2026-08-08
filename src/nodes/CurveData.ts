// CurveData — the DATA half of the object↔data split for the Curve path
// (#385, Stage C · C2).
//
// A curve's substance is its control points, closure, and sampling resolution;
// where the path sits in the world is a pose the Object owns. This node owns the
// geometry-ish half (`points`/`closed`/`resolution`) and DELIBERATELY no transform.
//
// It is the FIRST non-mesh member of the `ObjectData` union: unlike BoxData /
// SphereData it does NOT produce a `MeshData` (a curve is not render geometry —
// Blender's curve renders nothing without a bevel). It evaluates to a
// `CurveDataValue` carrying the baked LOCAL-space polyline, and `ObjectR` draws
// that line at the Object's TRS — byte-identical to the fused `Curve` beside it.
//
// Coexists with the fused `Curve`; nothing migrates in C2-Slice-1. Slice 2 adds
// the v4→v5 format migration, Slice 3 flips every producer, Slice 4 retires the
// fused `CurveValue` kind (the Object/CurveData arm already renders the split).
//
// #349 (which world a followed curve's points live in) is UNCHANGED by the split:
// `samples` stay LOCAL and the world arc-length table lives in the seam
// (curveSampleSource.ts), exactly as for the fused Curve — parity first (#385).
//
// H14 hydrate seam: every param carries a zod default and `evaluate` re-guards
// with `?? default`, so a hand-authored or migrated param bag never yields
// undefined geometry.
//
// REF: src/nodes/curveMath.ts (sampleCurve); src/viewport/CurveLine.tsx (the line);
//      docs/OBJECT-DATA-SPLIT-DESIGN.md §3.1; issues #385, #599.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { CurveDataValue, Vec3 } from './types';
import { sampleCurve } from './curveMath';

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

// The curve-point vocabulary lives HERE, on the data half, and used to live on the fused
// `Curve` (#599). It moved because the constraint it expresses is this node's: `CurveData`
// is what declares `points` and enforces the floor, and the app's point editors enforce the
// same floor against this node's params. A retired type is not the home of record for
// vocabulary its own successor imports — the same correction the migration ladders got in
// #571, one layer up.

/** A path needs at least two points to exist. The viewport authoring tools (#322) enforce
 *  the same floor when deleting, so a curve can never be emptied into a non-path. */
export const MIN_CURVE_POINTS = 2;

/** A control point: a stable `id` (epic #453 — so a selection/reference survives an
 *  insert/delete/reorder/undo) paired with its LOCAL coordinates. The id is a reference key
 *  only — it is never a `setParam` path (the array is always written whole). ids need only be
 *  unique WITHIN one curve; a fresh curve and a migrated one share the `cp0, cp1, …` vocabulary
 *  (`mintId(_, 'cp')`). */
export const CurvePointSchema = z.object({ id: z.string(), co: Vec3Schema });
/** The TS view uses `Vec3` (readonly) for `co` so it lines up with the rest of the curve code
 *  (`curveMath`, the builders, `CurveDataValue`); the schema still validates a plain 3-tuple. */
export type CurvePoint = { id: string; co: Vec3 };

export const CurveDataParams = z.object({
  /** Control points, LOCAL to the owning Object's TRS. Each carries a stable id
   *  (CurvePointSchema — epic #453), so a selection/reference survives an
   *  insert/delete/reorder/undo. The array is always written whole. */
  points: z
    .array(CurvePointSchema)
    .min(MIN_CURVE_POINTS)
    .default([
      { id: 'cp0', co: [-2, 0, -2] },
      { id: 'cp1', co: [-0.7, 0, 0.6] },
      { id: 'cp2', co: [0.7, 0, -0.6] },
      { id: 'cp3', co: [2, 0, 2] },
    ]),
  /** A closed curve loops back to its first point (the spline wraps). */
  closed: z.boolean().default(false),
  /** Samples emitted per span. Higher = smoother line AND a finer arc-length table
   *  (the world seam integrates the polyline, so resolution bounds accuracy). */
  resolution: z.number().int().min(1).max(128).default(16),
});
export type CurveDataParams = z.infer<typeof CurveDataParams>;

export const CurveDataNode: NodeDefinition<CurveDataParams, CurveDataValue> = {
  type: 'CurveData',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: CurveDataParams,
  inputs: {},
  outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
  // The DEFINING section — a curve's substance is its points. A data node owns no
  // pose, so no 'transform'/'constraint'/'driver' (those live on the Object).
  inspectorSections: ['curve'],
  home: {
    points: 'curve',
    closed: 'curve',
    resolution: 'curve',
  },
  evaluate(params) {
    // The ONE {id,co}[] → co[] boundary (mirrors the fused Curve.evaluate): the
    // sampler, the world seam (curveSampleSource) and the renderer (CurveLine)
    // stay coordinate-only, and CurveDataValue.points stays Vec3[].
    const entries = (params.points ?? []) as CurvePoint[];
    const points = entries.map((e) => e.co);
    const closed = params.closed ?? false;
    const resolution = params.resolution ?? 16;
    return {
      kind: 'CurveData',
      points,
      closed,
      samples: sampleCurve(points, closed, resolution),
    };
  },
};
