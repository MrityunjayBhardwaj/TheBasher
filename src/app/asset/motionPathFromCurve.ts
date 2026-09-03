// An authored curve, read as a control input to motion generation (#730, A2).
//
// ─────────────────────────────────────────────────────────────────────────
// THE CURVE IS CHOSEN BY SELECTION, NEVER BY BEING PRESENT
// ─────────────────────────────────────────────────────────────────────────
// The tempting rule is "if the scene has a curve, walk it". It is wrong, and
// quietly so: a curve in this app is already a CAMERA RAIL, and under that rule
// drawing a camera move would silently start steering every character generated
// afterwards. The director never said the two were related.
//
// So the path is the SELECTED curve and nothing else. Selection is the director
// saying which one they mean — it is already how the bind path breaks a tie
// between characters — and it costs no new UI, no new param, and no new node.
// Nothing selected, or something selected that is not a curve, means no path was
// asked for: an ordinary generation, exactly as before.
//
// ─────────────────────────────────────────────────────────────────────────
// LOCAL POINTS ARE NOT WAYPOINTS
// ─────────────────────────────────────────────────────────────────────────
// `CurveData.points` are LOCAL to the owning Object's transform, and the server
// wants world XZ in metres. Reading `points` directly would produce a path of
// exactly the right shape in exactly the wrong place — and, under a rotated or
// scaled parent, the wrong shape too.
//
// This goes through `curveSamplerFor`, the existing world seam, which resolves
// the world matrix and builds the arc-length table. That also buys the sampling
// property that matters: sampling at even fractions of ARC LENGTH pairs with the
// server spreading waypoints evenly over FRAMES (`_resample_frames`), so the two
// halves agree that the character moves at constant speed. Sampling evenly in
// the curve's parameter instead would silently ask for a character that speeds up
// through the straight bits.
//
// Invariants honoured:
//   - V8: app-layer, no `src/viewport/` imports.
//   - V22: no Date.now / Math.random — a pure read of the graph.
//
// REF: src/app/curveSampleSource.ts (the world seam + arc-length table);
//      src/nodes/CurveData.ts (why points are local);
//      ~/Documents/projects/auto-animate/kimodo/authoring/constraints.py
//        (`_as_xz` rejects the 3-wide form; `_resample_frames` spreads evenly);
//      issues #730, #826.

import type { DagState } from '../../core/dag/state';
import { curveSamplerFor } from '../curveSampleSource';

/**
 * How many points describe the path.
 *
 * The server spreads whatever it is given evenly across the clip's frames, so
 * this is a resolution choice, not a length: too few and a curved path is walked
 * as a polygon, too many and every frame is pinned, leaving the model no freedom
 * to produce a natural gait between the pins. Sixteen puts a waypoint roughly
 * every eighth of a second in a two-second clip — dense enough to hold the shape
 * of a curve, sparse enough that the motion between them is still generated
 * rather than dictated.
 */
export const MOTION_PATH_WAYPOINTS = 16;

/** Frame 0 — a path is a static authoring artefact, so any frame samples the
 *  same curve. Mirrors the bind path's `BIND_POSE_CTX` for the same reason. */
const PATH_CTX = { time: { frame: 0, seconds: 0, normalized: 0 } } as const;

/** A ground path in world XZ metres, in the shape the request carries. */
export type MotionWaypoints = readonly { readonly x: number; readonly z: number }[];

/**
 * Sample a curve into world XZ waypoints, or `null` when `curveId` is not a
 * curve at all.
 *
 * `null` and an empty array are NOT the same answer and neither is returned
 * loosely: null means "this node is not a path", which is the ordinary case for
 * any other selection, while a curve that cannot produce points is a curve that
 * failed and is reported as such by the caller.
 */
export function waypointsFromCurve(
  state: DagState,
  curveId: string,
  count: number = MOTION_PATH_WAYPOINTS,
): MotionWaypoints | null {
  const sampler = curveSamplerFor(state, curveId, PATH_CTX);
  if (!sampler) return null;
  // A degenerate curve (every control point stacked) has a zero-length table and
  // would sample the same spot `count` times — a "path" that asks the character
  // to stand still while claiming it was given somewhere to go. Refused as no
  // path rather than passed on as a path of one repeated point.
  if (!(sampler.length > 0)) return null;

  const n = Math.max(2, Math.floor(count));
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    // Arc-length fraction, endpoints included: i/(n-1) spans [0, 1] so the path
    // starts at the curve's start and ends at its end.
    const p = sampler.pointAt(i / (n - 1));
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[2])) return null;
    // The Y component is dropped on purpose: the server takes GROUND positions,
    // and its `_as_xz` rejects a 3-wide point outright rather than mis-slicing it
    // as (x, y). A curve drawn with height still walks the ground track it
    // describes.
    out.push({ x: p[0], z: p[2] });
  }
  return out;
}

/**
 * The path the director asked for, from the current selection.
 *
 * Returns `null` for "no path requested", which includes the common case of
 * nothing selected. A selected curve that fails to sample also returns null —
 * the caller cannot tell those apart and does not need to: both mean generate
 * without a path, and the second is already impossible for any curve the
 * viewport can draw.
 */
export function motionPathFromSelection(
  state: DagState,
  selectedNodeId: string | null,
): MotionWaypoints | null {
  if (!selectedNodeId) return null;
  return waypointsFromCurve(state, selectedNodeId);
}
