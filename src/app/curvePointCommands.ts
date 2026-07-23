// curvePointCommands — the COMMIT layer over curvePoints.ts's pure op-builders (#322).
//
// `curvePoints.ts` answers "what ops does this edit produce?". This module answers "what
// happens when a director performs that edit?" — the ops PLUS the sub-selection rule.
//
// The selection is now addressed by a STABLE id, not an index (#453). That is the whole
// point: an id travels WITH its point across every insert, delete and reorder, so a
// selection can no longer silently slide onto a neighbour the way a raw index did. The old
// re-index dance — shift the selection up on an insert-before, down on a delete-before — is
// GONE, because there is nothing to re-index: the id already names the same physical point
// after the array is spliced. That dissolution IS the #326 fix for curve points.
//
// What remains is genuinely id-level, not positional:
//   - move    → selection unchanged (the point kept its id AND its slot).
//   - insert  → MINT a fresh id for the new point (the caller mints into the pure op); the
//               selection is untouched (its id is unchanged, its slot may shift — irrelevant).
//   - extrude → an insert whose NEW point (its minted id) becomes the selection, so the
//               director can immediately drag what they just made (Blender's extrude).
//   - delete  → if the DELETED point's id IS the selected id, clear (nothing left to keep);
//               otherwise leave the selection alone — its id still names a surviving point.
//   - a refused edit (the two-point floor) commits nothing and touches no selection.
//
// Three surfaces perform these edits (the inspector rows, the viewport handles, the
// keyboard), so the rule lives HERE, once, rather than in each of them. Same reason the
// op-builders are shared: an edit has to mean the same thing whichever surface you use.
//
// REF: src/app/curvePoints.ts (the op-builders + resolveCurvePointSelection);
//      src/app/identifiedArray.ts (mintId — the deterministic id source);
//      src/app/stores/curveSelectionStore.ts; issues #322, #326, #453.

import { useDagStore } from '../core/dag/store';
import {
  buildDeleteCurvePointOps,
  buildInsertCurvePointOps,
  buildSetCurvePointOps,
  buildToggleCurveClosedOp,
  curvePointEntriesOf,
  curvePointsOf,
} from './curvePoints';
import { mintId } from './identifiedArray';
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
 * Insert a point after `index`, MINTING its stable id, and commit. Returns the new point's id
 * on success, null on a refused/failed edit. The caller mints the id into the pure op (locked
 * decision 3): the builder cannot call `crypto.randomUUID`, so the id is an INPUT. `mintId`'s
 * deterministic scan over the current ids guarantees a fresh, collision-free `cpN`.
 *
 * The selection needs no bookkeeping: a selected id is unchanged by an insert (its point kept
 * its id; only its slot may have shifted, which the id-addressed resolver reads through). This
 * is the shared half of insert (selection untouched) and extrude (selection → the new id).
 */
function commitInsert(nodeId: string, index: number): string | null {
  const state = useDagStore.getState().state;
  const newId = mintId(
    (curvePointEntriesOf(state, nodeId) ?? []).map((p) => p.id),
    'cp',
  );
  const ok = commit(buildInsertCurvePointOps(state, nodeId, index, newId), 'Insert curve point');
  return ok ? newId : null;
}

/**
 * Insert a point after `index` (the inspector's "+"). The panel does not steal the viewport's
 * selection — it inserts, and whatever was selected stays selected (its id is untouched; the
 * former re-index shift is gone because the selection is now id-addressed, #453).
 */
export function insertCurvePoint(nodeId: string, index: number): boolean {
  return commitInsert(nodeId, index) !== null;
}

/**
 * Extrude (the viewport's E) — an insert whose NEW point becomes the selection, so the
 * director can immediately drag what they just made. Blender's extrude leaves the new
 * element selected and grabbable for exactly this reason; extruding and then having to hunt
 * for the thing you extruded would make the tool useless in the viewport.
 *
 * It selects the MINTED id of the new point — NOT `index + 1`. A positional guess would be a
 * regression back to index-addressing (and wrong the moment an insert lands elsewhere); the
 * id names exactly the point that was just created, whatever slot it occupies.
 */
export function extrudeCurvePoint(nodeId: string, index: number): boolean {
  const newId = commitInsert(nodeId, index);
  if (!newId) return false;
  useCurveSelectionStore.getState().selectPoint(nodeId, newId);
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
  const state = useDagStore.getState().state;
  const points = curvePointsOf(state, nodeId);
  // Read the DELETED point's id BEFORE the commit — after it, `index` names a different point
  // (or nothing). This is the ONLY thing the selection rule needs: an id equality, not a shift.
  const deletedId = curvePointEntriesOf(state, nodeId)?.[index]?.id ?? null;
  const ok = commit(buildDeleteCurvePointOps(state, nodeId, index), 'Delete curve point');
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
  // Clear ONLY when the selected id is the one that vanished. Any other selected id still
  // names a surviving point — no shift, because the id addresses the point, not its slot.
  if (sel.nodeId === nodeId && sel.pointId !== null && sel.pointId === deletedId) sel.clear();
  return true;
}

/** Open ⇄ closed (the viewport's C). Points and their indices are unchanged. */
export function toggleCurveClosed(nodeId: string): boolean {
  return commit(
    buildToggleCurveClosedOp(useDagStore.getState().state, nodeId),
    'Toggle curve closed',
  );
}
