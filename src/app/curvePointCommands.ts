// curvePointCommands — the COMMIT layer over curvePoints.ts's pure op-builders (#322).
//
// `curvePoints.ts` answers "what ops does this edit produce?". This module answers "what
// happens when a director performs that edit?" — which is the ops PLUS the sub-selection
// bookkeeping, and the two must not be separable. A curve point is addressed by its INDEX,
// so every insert or delete RE-INDEXES the points after it: delete point 0 while point 2 is
// selected and, if nothing adjusts, the selection silently slides onto what used to be
// point 3. The gizmo then sits on a point the director never picked, and the next drag
// moves the wrong one — with no error anywhere.
//
// Three surfaces perform these edits (the inspector rows, the viewport handles, the
// keyboard), so the re-index rule lives HERE, once, rather than in each of them. Same
// reason the op-builders are shared: an edit has to mean the same thing whichever surface
// you use it from.
//
// The selection rules, stated once:
//   - move    → selection unchanged (no re-index).
//   - insert/extrude after i → everything after i shifts up by one; the NEW point (i+1)
//     becomes the selection, so the director can immediately drag what they just made
//     (Blender's extrude leaves the new vertex selected and grabbable).
//   - delete i → the selected point is gone: clear (there is nothing to keep selected).
//     A selection AFTER i shifts down by one so it keeps naming the SAME point.
//   - a refused edit (the two-point floor) commits nothing and touches no selection.
//
// REF: src/app/curvePoints.ts (the op-builders + resolveCurvePointSelection);
//      src/app/stores/curveSelectionStore.ts; issue #322.

import { useDagStore } from '../core/dag/store';
import {
  buildDeleteCurvePointOps,
  buildInsertCurvePointOps,
  buildSetCurvePointOps,
  buildToggleCurveClosedOp,
  curvePointsOf,
} from './curvePoints';
import { MIN_CURVE_POINTS } from '../nodes/Curve';
import { useCurveSelectionStore } from './stores/curveSelectionStore';
import { useNotificationStore } from './stores/notificationStore';
import type { Vec3 } from '../nodes/types';

/** Dispatch a builder's ops as ONE undo entry. Null (a refused edit — the two-point floor,
 *  a dangling index) commits nothing rather than eating an undo slot on a no-op. */
function commit(ops: ReturnType<typeof buildSetCurvePointOps>, description: string): boolean {
  if (!ops || ops.length === 0) return false;
  useDagStore.getState().dispatchAtomic(ops, 'user', description);
  return true;
}

/** Move one control point to a new LOCAL position. */
export function moveCurvePoint(nodeId: string, index: number, value: Vec3): boolean {
  return commit(
    buildSetCurvePointOps(useDagStore.getState().state, nodeId, index, value),
    `Move curve point ${index}`,
  );
}

/**
 * Insert a point after `index` (the inspector's "+"). The insert re-indexes everything after
 * `index`, so a selection sitting there must move with it or it silently comes to name a
 * DIFFERENT point. The panel does not steal the viewport's selection — it inserts, and
 * whatever was selected stays selected.
 */
export function insertCurvePoint(nodeId: string, index: number): boolean {
  const ok = commit(
    buildInsertCurvePointOps(useDagStore.getState().state, nodeId, index),
    'Insert curve point',
  );
  if (!ok) return false;
  const sel = useCurveSelectionStore.getState();
  // Only OUR curve's selection re-indexes; a point selected on another curve is untouched.
  if (sel.nodeId === nodeId && sel.pointIndex !== null && sel.pointIndex > index) {
    sel.selectPoint(nodeId, sel.pointIndex + 1);
  }
  return true;
}

/**
 * Extrude (the viewport's E) — an insert whose NEW point becomes the selection, so the
 * director can immediately drag what they just made. Blender's extrude leaves the new
 * element selected and grabbable for exactly this reason; extruding and then having to hunt
 * for the thing you extruded would make the tool useless in the viewport.
 *
 * The insert half is `insertCurvePoint` verbatim — the two differ ONLY in what they leave
 * selected, which is the whole distinction between a panel edit and a viewport gesture.
 */
export function extrudeCurvePoint(nodeId: string, index: number): boolean {
  if (!insertCurvePoint(nodeId, index)) return false;
  useCurveSelectionStore.getState().selectPoint(nodeId, index + 1);
  return true;
}

/**
 * Delete a control point. Refused (returns false, commits nothing) at the two-point floor —
 * below which the curve stops being a path at all.
 *
 * A refusal is ANNOUNCED, never silent (V38): the inspector's ✕ can disable itself at the
 * floor, but the viewport's Delete key has no disabled state — press it and, without this,
 * nothing whatsoever would happen and the director would be left wondering whether the key
 * was even bound.
 */
export function deleteCurvePoint(nodeId: string, index: number): boolean {
  const points = curvePointsOf(useDagStore.getState().state, nodeId);
  const ok = commit(
    buildDeleteCurvePointOps(useDagStore.getState().state, nodeId, index),
    'Delete curve point',
  );
  if (!ok) {
    if (points && points.length <= MIN_CURVE_POINTS) {
      useNotificationStore.getState().notify({
        severity: 'warn',
        message: `A path needs at least ${MIN_CURVE_POINTS} points`,
      });
    }
    return false;
  }
  const sel = useCurveSelectionStore.getState();
  if (sel.nodeId !== nodeId || sel.pointIndex === null) return true;
  if (sel.pointIndex === index)
    sel.clear(); // the selected point IS the deleted one
  else if (sel.pointIndex > index) sel.selectPoint(nodeId, sel.pointIndex - 1); // keeps naming the same point
  return true;
}

/** Open ⇄ closed (the viewport's C). Points and their indices are unchanged. */
export function toggleCurveClosed(nodeId: string): boolean {
  return commit(
    buildToggleCurveClosedOp(useDagStore.getState().state, nodeId),
    'Toggle curve closed',
  );
}
