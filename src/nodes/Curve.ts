// Curve — a PATH scene object (#321). Blender's Curve / Houdini's curve SOP, cut down to
// what the camera rig needs: control points a spline passes THROUGH, so "drag a point and
// the path goes there" is literally true (centripetal Catmull-Rom — curveMath.ts).
//
// It is a full SceneObject (TRS, selectable, parentable, grabbable by the existing gizmo —
// `Gizmo.tsx getManipulable` needs only a vec3 `position` param), so a path can be moved,
// rotated, scaled and parented like anything else. Follow-Path (Phase 4) will name a Curve
// by `{node}` ref and sample it — which is why the WORLD-space read lives in the seam
// (`src/app/curveSampleSource.ts`), not here: `evaluate` is pure and cannot see world
// transforms. This node bakes only the LOCAL polyline.
//
// A curve is NOT render geometry in v1 (a Blender curve renders only once it has a bevel),
// so `CurveLine.tsx` draws it as editor chrome — visible in the viewport, absent from
// image renders. Bevel/extrude, and Bezier tangent handles, are additive later slices that
// change how `samples` is GENERATED and never the seam that consumes it.
//
// H14 hydrate seam: every param carries a zod default and `evaluate` re-guards with
// `?? default`, so a hand-authored or migrated param bag can never yield undefined TRS.
//
// REF: src/nodes/curveMath.ts (the sampler); src/app/curveSampleSource.ts (the world
//      arc-length seam); src/viewport/CurveLine.tsx (the line); issue #321.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import { sampleCurve } from './curveMath';
import type { CurveValue, Vec3 } from './types';

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

/** A path needs at least two points to exist. The viewport authoring tools (#322) enforce
 *  the same floor when deleting, so a curve can never be emptied into a non-path. */
export const MIN_CURVE_POINTS = 2;

export const CurveParams = z.object({
  position: Vec3Schema.default([0, 0, 0]),
  rotation: Vec3Schema.default([0, 0, 0]),
  scale: Vec3Schema.default([1, 1, 1]),
  /** Control points, LOCAL to the curve's TRS. */
  points: z
    .array(Vec3Schema)
    .min(MIN_CURVE_POINTS)
    .default([
      [-2, 0, -2],
      [-0.7, 0, 0.6],
      [0.7, 0, -0.6],
      [2, 0, 2],
    ]),
  /** A closed curve loops back to its first point (the spline wraps, no phantom tangents). */
  closed: z.boolean().default(false),
  /** Samples emitted per span. Higher = smoother line AND a finer arc-length table (the
   *  seam integrates the polyline, so resolution bounds constant-speed accuracy). */
  resolution: z.number().int().min(1).max(128).default(16),
});
export type CurveParams = z.infer<typeof CurveParams>;

export const CurveNode: NodeDefinition<CurveParams, CurveValue> = {
  type: 'Curve',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: CurveParams,
  inputs: {},
  outputs: { out: { type: 'SceneObject', cardinality: 'single' } },
  // The DEFINING section leads — only the first is expanded by default
  // (`isDefaultCollapsed`), and a curve's substance is its points, exactly as a mesh leads
  // with 'mesh' and a camera with 'camera'. Leading with 'transform' would open a Curve on
  // its TRS and hide the path itself.
  inspectorSections: ['curve', 'transform', 'constraint', 'driver'],
  evaluate(params) {
    const points = (params.points ?? []) as Vec3[];
    const closed = params.closed ?? false;
    const resolution = params.resolution ?? 16;
    return {
      kind: 'Curve',
      position: (params.position ?? [0, 0, 0]) as Vec3,
      rotation: (params.rotation ?? [0, 0, 0]) as Vec3,
      scale: (params.scale ?? [1, 1, 1]) as Vec3,
      points,
      closed,
      samples: sampleCurve(points, closed, resolution),
    };
  },
};
