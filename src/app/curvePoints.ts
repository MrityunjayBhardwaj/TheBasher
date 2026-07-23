// curvePoints — the AUTHORING half of the Curve path (#321): every edit to a curve's
// control points, as pure `Op[]`.
//
// THE ONE AUTHORITY. Two surfaces edit these points — the inspector's numeric rows (here,
// #321) and the viewport's grabbable handles (#322) — and they must not each re-derive the
// array math. "Insert a point" has to mean the same thing whichever surface you use, or the
// two drift and the bug reads as "the viewport and the panel disagree". Same discipline as
// the constraint/driver stacks: ONE enumeration + ONE set of op-builders behind every
// surface, never a second copy in the UI.
//
// WHOLE-ARRAY REPLACE, always. `setParam`'s path walker is dot-only and explicitly refuses
// to descend into arrays (`setAtPath`, core/dag/ops.ts) — a paramPath of `points.3` would
// replace the whole array with `{3: …}` and fail zod re-validation. So each edit reads the
// current array, maps a new one, and writes `points` entire. This is the established
// pattern for every array param in the codebase (a glTF's `materials`, a channel's
// `keyframes`), and undo comes free: the inverse op carries the prior array.
//
// REF: src/nodes/Curve.ts (the schema + MIN_CURVE_POINTS); src/core/dag/ops.ts (why the
//      whole-array write); src/app/constraintStack.ts (the pure-Op[] builder convention).

import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { MIN_CURVE_POINTS, type CurvePoint } from '../nodes/Curve';
import type { Vec3 } from '../nodes/types';
import { mintId } from './identifiedArray';

/** The curve's control-point ENTRIES ({id,co}[]), or null when `nodeId` is not a Curve. The
 *  builders read through this so a write can PRESERVE each point's id across a topology edit —
 *  one accessor, one truth. The coordinate-only `curvePointsOf` is derived from it. */
export function curvePointEntriesOf(state: DagState, nodeId: string): CurvePoint[] | null {
  const node = state.nodes[nodeId];
  if (!node || node.type !== 'Curve') return null;
  const pts = (node.params as { points?: unknown }).points;
  if (!Array.isArray(pts)) return null;
  return pts as CurvePoint[];
}

/** The curve's authored control points as bare coordinates (LOCAL space), or null when
 *  `nodeId` is not a Curve. The render/sample consumers (the sampler, the handles' geometry,
 *  the rows) stay coordinate-only; ids live on the entries (`curvePointEntriesOf`). */
export function curvePointsOf(state: DagState, nodeId: string): Vec3[] | null {
  const entries = curvePointEntriesOf(state, nodeId);
  return entries ? entries.map((e) => e.co) : null;
}

/** The one write. Every builder funnels here so there is exactly one place that knows the
 *  param is called `points` and that the whole `{id,co}[]` array is written at once (the id is
 *  a reference key, never a `setParam` path — setParam refuses to descend into arrays). */
function writePoints(nodeId: string, points: readonly CurvePoint[]): Op[] {
  return [{ type: 'setParam', nodeId, paramPath: 'points', value: points }];
}

/** A resolved control-point selection: the point the viewport handles, the point gizmo and
 *  the keyboard are all talking about. */
export interface CurvePointSelection {
  nodeId: string;
  pointIndex: number;
  /** The point's authored (LOCAL) coordinates. */
  point: Vec3;
}

/**
 * THE ONE ACCESSOR for "which control point is selected" (#322).
 *
 * `curveSelectionStore` holds a raw (nodeId, index) pair and validates nothing — because
 * whether that pair still names a real point is a question about the DAG, not about the UI.
 * A point can vanish under the selection at any moment: delete the point, delete the curve,
 * undo the add. Every reader — the handles, the point gizmo, the Delete/E shortcuts, the
 * gate that hides the object gizmo — asks HERE, so a stale index is never acted on, and the
 * four surfaces can never disagree about what is selected. (The same rule the constraint
 * and driver stacks learned the hard way: when several surfaces address "the current one",
 * they must all address it through the SAME accessor, or the UI narrates one thing while
 * the engine does another.)
 *
 * Null ⇒ there is no live point selection ⇒ the object gizmo owns the viewport.
 */
export function resolveCurvePointSelection(
  state: DagState,
  selection: { nodeId: string | null; pointIndex: number | null },
): CurvePointSelection | null {
  const { nodeId, pointIndex } = selection;
  if (!nodeId || pointIndex === null || !Number.isInteger(pointIndex)) return null;
  const points = curvePointsOf(state, nodeId);
  if (!points || pointIndex < 0 || pointIndex >= points.length) return null;
  return { nodeId, pointIndex, point: points[pointIndex] };
}

/** Move one control point. */
export function buildSetCurvePointOps(
  state: DagState,
  nodeId: string,
  index: number,
  value: Vec3,
): Op[] | null {
  const entries = curvePointEntriesOf(state, nodeId);
  if (!entries || index < 0 || index >= entries.length) return null;
  return writePoints(
    nodeId,
    entries.map((e, i) => (i === index ? { ...e, co: value } : e)),
  );
}

/**
 * Insert a new point AFTER `index`, placed at the midpoint of the span it splits — so the
 * path's shape is preserved at the moment of insertion and the new point is immediately
 * grabbable where the director expects it (rather than at the origin, which would fling the
 * path across the scene). Inserting after the LAST point of an open curve has no following
 * span, so the point EXTENDS the path: it continues the final direction by the same step
 * (Blender's extrude). A closed curve wraps, so the midpoint always exists.
 */
export function buildInsertCurvePointOps(
  state: DagState,
  nodeId: string,
  index: number,
  newPointId?: string,
): Op[] | null {
  const entries = curvePointEntriesOf(state, nodeId);
  if (!entries || index < 0 || index >= entries.length) return null;
  const node = state.nodes[nodeId];
  const closed = (node?.params as { closed?: unknown })?.closed === true;
  const points = entries.map((e) => e.co);

  const a = points[index];
  const isLast = index === points.length - 1;
  let next: Vec3;
  if (!isLast || closed) {
    const b = points[isLast ? 0 : index + 1];
    next = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  } else {
    // Extend past the end, continuing the last span's direction. A 1-span degenerate
    // curve (both points coincident) would extend by zero, so fall back to a unit step
    // on +X — a new point the user can actually see and grab.
    const prev = points[points.length - 2] ?? a;
    const d: Vec3 = [a[0] - prev[0], a[1] - prev[1], a[2] - prev[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    next = len > 1e-6 ? [a[0] + d[0], a[1] + d[1], a[2] + d[2]] : [a[0] + 1, a[1], a[2]];
  }

  // Caller mints the id (locked decision 3); the internal fallback keeps this task's existing
  // 3-arg caller compiling — Task 2 tightens the caller to always pass a minted id.
  const id =
    newPointId ??
    mintId(
      entries.map((e) => e.id),
      'cp',
    );
  const out = entries.slice();
  out.splice(index + 1, 0, { id, co: next });
  return writePoints(nodeId, out);
}

/** Remove a control point. Null (a refused edit, not a silent no-op) when the curve is
 *  already at the two-point floor below which it stops being a path at all. */
export function buildDeleteCurvePointOps(
  state: DagState,
  nodeId: string,
  index: number,
): Op[] | null {
  const entries = curvePointEntriesOf(state, nodeId);
  if (!entries || index < 0 || index >= entries.length) return null;
  if (entries.length <= MIN_CURVE_POINTS) return null;
  return writePoints(
    nodeId,
    entries.filter((_, i) => i !== index),
  );
}

/** Open ⇄ closed. A closed curve loops (and a Follow-Path over it wraps rather than
 *  clamping — curveSampleSource.ts). */
export function buildToggleCurveClosedOp(state: DagState, nodeId: string): Op[] | null {
  const node = state.nodes[nodeId];
  if (!node || node.type !== 'Curve') return null;
  const closed = (node.params as { closed?: unknown }).closed === true;
  return [{ type: 'setParam', nodeId, paramPath: 'closed', value: !closed }];
}
