// The ACTIVE curve point — the one datum four surfaces have to agree on (#322).
//
// The handles draw it highlighted, the point gizmo mounts on it, Delete removes it, E
// extrudes from it, and the object gizmo hides because of it. If any of those five asked
// the question its own way, the UI would sooner or later act on a point that isn't there:
// the raw (nodeId, index) pair in `curveSelectionStore` survives the deletion of the point
// it names, the deletion of the whole curve, and an undo that removes both. So all of them
// ask HERE.
//
// Two conditions, in one place:
//   1. The pair still names a real point of a real Curve — `resolveCurvePointSelection`.
//   2. That curve is the PRIMARY object selection. Selecting a cube while a curve point was
//      selected must give the cube its gizmo back; the stale point selection must not keep
//      a point gizmo alive on an object the director is no longer editing.
//
// Both an imperative form (for the keyboard handler, which reads stores at event time) and
// a hook form (for the two components, which must re-render when any of the three stores
// changes). Same logic, one definition — the imperative one is not a second copy.
//
// REF: src/app/curvePoints.ts (resolveCurvePointSelection — the DAG-validity half);
//      src/app/stores/curveSelectionStore.ts (the raw pair); src/app/Gizmo.tsx (the gate);
//      src/app/CurvePointHandles.tsx (the handles + the point gizmo); issue #322.

import { useDagStore } from '../core/dag/store';
import { resolveCurvePointSelection, type CurvePointSelection } from './curvePoints';
import { useCurveSelectionStore } from './stores/curveSelectionStore';
import { useSelectionStore } from './stores/selectionStore';
import type { DagState } from '../core/dag/state';

/** The pure core — given the three states, is there a live point selection? */
function activeCurvePoint(
  state: DagState,
  primaryNodeId: string | null,
  selection: { nodeId: string | null; pointIndex: number | null },
): CurvePointSelection | null {
  if (!primaryNodeId || selection.nodeId !== primaryNodeId) return null;
  return resolveCurvePointSelection(state, selection);
}

/** Imperative read (keyboard shortcuts — no React context at keydown time). */
export function getActiveCurvePoint(): CurvePointSelection | null {
  const sel = useCurveSelectionStore.getState();
  return activeCurvePoint(
    useDagStore.getState().state,
    useSelectionStore.getState().primaryNodeId,
    { nodeId: sel.nodeId, pointIndex: sel.pointIndex },
  );
}

/** Reactive read (the gizmo gate + the handles). */
export function useActiveCurvePoint(): CurvePointSelection | null {
  const state = useDagStore((s) => s.state);
  const primaryNodeId = useSelectionStore((s) => s.primaryNodeId);
  const nodeId = useCurveSelectionStore((s) => s.nodeId);
  const pointIndex = useCurveSelectionStore((s) => s.pointIndex);
  return activeCurvePoint(state, primaryNodeId, { nodeId, pointIndex });
}

export { activeCurvePoint };
