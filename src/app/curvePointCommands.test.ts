// curvePointCommands — the commit layer over the point-edit op-builders (#322).
//
// The op-builders' array math is pinned in curvePoints.test.ts. What is pinned HERE is the
// half that only exists because the viewport can select a point: the SUB-SELECTION
// BOOKKEEPING. A point is addressed by its index, so an insert or a delete re-indexes every
// point after it — and a selection that doesn't move with them silently comes to name a
// DIFFERENT point. Nothing throws; the gizmo simply sits on the wrong one and the next drag
// moves the wrong one. That is the class of bug these tests exist for.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag/ops';
import { useDagStore } from '../core/dag/store';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import type { Vec3 } from '../nodes/types';
import { curvePointsOf, resolveCurvePointSelection } from './curvePoints';
import {
  deleteCurvePoint,
  extrudeCurvePoint,
  insertCurvePoint,
  moveCurvePoint,
  toggleCurveClosed,
} from './curvePointCommands';
import { activeCurvePoint } from './curvePointSelection';
import { useCurveSelectionStore } from './stores/curveSelectionStore';
import { useNotificationStore } from './stores/notificationStore';

const LINE: Vec3[] = [
  [0, 0, 0],
  [2, 0, 0],
  [4, 0, 0],
];

function seedCurve(points: Vec3[] = LINE, closed = false): DagState {
  const state = applyOp(buildDefaultDagState(), {
    type: 'addNode',
    nodeId: 'c1',
    nodeType: 'Curve',
    params: { points, closed },
  }).next;
  useDagStore.setState({ state } as never);
  return state;
}

const points = () => curvePointsOf(useDagStore.getState().state, 'c1');
const selection = () => useCurveSelectionStore.getState();

beforeEach(() => {
  registerAllNodes();
  useCurveSelectionStore.getState().clear();
  useNotificationStore.setState({ toasts: [] } as never);
});

describe('curvePointCommands — the edit', () => {
  it('moves a point through the store (one atomic dispatch)', () => {
    seedCurve();
    expect(moveCurvePoint('c1', 1, [2, 5, 0])).toBe(true);
    expect(points()).toEqual([
      [0, 0, 0],
      [2, 5, 0],
      [4, 0, 0],
    ]);
  });

  it('a whole drag is ONE undo entry back to the prior array', () => {
    seedCurve();
    moveCurvePoint('c1', 1, [2, 5, 0]);
    useDagStore.getState().undo();
    expect(points()).toEqual(LINE); // the inverse carries the prior array — undo is free
  });

  it('toggles the loop closed and open again', () => {
    seedCurve();
    toggleCurveClosed('c1');
    expect((useDagStore.getState().state.nodes.c1.params as { closed: boolean }).closed).toBe(true);
    toggleCurveClosed('c1');
    expect((useDagStore.getState().state.nodes.c1.params as { closed: boolean }).closed).toBe(
      false,
    );
  });
});

describe('curvePointCommands — the sub-selection bookkeeping', () => {
  it('EXTRUDE selects the NEW point, so the director can drag what they just made', () => {
    seedCurve();
    useCurveSelectionStore.getState().selectPoint('c1', 1);
    expect(extrudeCurvePoint('c1', 1)).toBe(true);
    expect(selection().pointIndex).toBe(2); // the new point, not the one extruded FROM
    expect(points()![2]).toEqual([3, 0, 0]); // the midpoint of the span it split
  });

  it('an INSERT before the selection shifts it, so it keeps naming the SAME point', () => {
    seedCurve();
    useCurveSelectionStore.getState().selectPoint('c1', 2); // [4,0,0]
    insertCurvePoint('c1', 0); // a new point lands at index 1
    expect(selection().pointIndex).toBe(3);
    const sel = resolveCurvePointSelection(useDagStore.getState().state, selection());
    expect(sel!.point).toEqual([4, 0, 0]); // still the point the director picked
  });

  it('an INSERT after the selection leaves it alone (nothing re-indexed)', () => {
    seedCurve();
    useCurveSelectionStore.getState().selectPoint('c1', 0);
    insertCurvePoint('c1', 1);
    expect(selection().pointIndex).toBe(0);
  });

  it('deleting the SELECTED point clears the selection (there is nothing left to select)', () => {
    seedCurve();
    useCurveSelectionStore.getState().selectPoint('c1', 1);
    expect(deleteCurvePoint('c1', 1)).toBe(true);
    expect(selection().pointIndex).toBeNull();
    expect(selection().nodeId).toBeNull();
  });

  it('deleting BEFORE the selection shifts it down — it keeps naming the same point', () => {
    seedCurve();
    useCurveSelectionStore.getState().selectPoint('c1', 2); // [4,0,0]
    deleteCurvePoint('c1', 0);
    expect(selection().pointIndex).toBe(1);
    const sel = resolveCurvePointSelection(useDagStore.getState().state, selection());
    expect(sel!.point).toEqual([4, 0, 0]);
  });

  it('an edit on ANOTHER curve never touches this curve’s selection', () => {
    seedCurve();
    const two = applyOp(useDagStore.getState().state, {
      type: 'addNode',
      nodeId: 'c2',
      nodeType: 'Curve',
      params: { points: LINE },
    }).next;
    useDagStore.setState({ state: two } as never);
    useCurveSelectionStore.getState().selectPoint('c1', 2);
    insertCurvePoint('c2', 0);
    deleteCurvePoint('c2', 0);
    expect(selection()).toMatchObject({ nodeId: 'c1', pointIndex: 2 });
  });
});

describe('curvePointCommands — the refused delete ANNOUNCES itself (V38)', () => {
  it('refuses at the two-point floor, commits nothing, and toasts', () => {
    seedCurve([
      [0, 0, 0],
      [1, 0, 0],
    ]);
    useCurveSelectionStore.getState().selectPoint('c1', 0);
    expect(deleteCurvePoint('c1', 0)).toBe(false);
    expect(points()).toHaveLength(2); // nothing committed
    expect(selection().pointIndex).toBe(0); // the selection survives a refusal
    // The viewport's Delete key has no disabled state — a silent refusal would read as an
    // unbound key. The toast IS the outcome.
    const toasts = useNotificationStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toMatch(/at least 2 points/i);
  });
});

describe('resolveCurvePointSelection — the one accessor, guarding against a stale index', () => {
  it('resolves a live (nodeId, index) pair to its point', () => {
    const state = seedCurve();
    expect(resolveCurvePointSelection(state, { nodeId: 'c1', pointIndex: 1 })).toEqual({
      nodeId: 'c1',
      pointIndex: 1,
      point: [2, 0, 0],
    });
  });

  it('null for an index that no longer exists — the point was deleted under the selection', () => {
    seedCurve();
    useCurveSelectionStore.getState().selectPoint('c1', 2);
    // A row-delete of a LATER-indexed point can't happen here, so shrink the curve directly:
    // whatever the route, an index past the end must not resolve.
    deleteCurvePoint('c1', 2);
    useCurveSelectionStore.getState().selectPoint('c1', 2); // a stale pointer, by hand
    expect(resolveCurvePointSelection(useDagStore.getState().state, selection())).toBeNull();
  });

  it('null for a non-Curve node, a missing node, and an empty selection', () => {
    const state = seedCurve();
    expect(resolveCurvePointSelection(state, { nodeId: 'n_box', pointIndex: 0 })).toBeNull();
    expect(resolveCurvePointSelection(state, { nodeId: 'nope', pointIndex: 0 })).toBeNull();
    expect(resolveCurvePointSelection(state, { nodeId: null, pointIndex: null })).toBeNull();
    expect(resolveCurvePointSelection(state, { nodeId: 'c1', pointIndex: null })).toBeNull();
  });
});

describe('activeCurvePoint — what hides the object gizmo', () => {
  it('is live only while the point’s curve is the PRIMARY object selection', () => {
    const state = seedCurve();
    const sel = { nodeId: 'c1', pointIndex: 1 };
    // The curve is selected → the point selection is live → Gizmo yields to the point gizmo.
    expect(activeCurvePoint(state, 'c1', sel)).toMatchObject({ nodeId: 'c1', pointIndex: 1 });
    // Select a cube instead. The raw (c1, 1) pair is still sitting in the store, but the
    // director is editing the cube now: it MUST get its gizmo back, or the viewport shows a
    // point gizmo for an object that isn't selected.
    expect(activeCurvePoint(state, 'n_box', sel)).toBeNull();
    expect(activeCurvePoint(state, null, sel)).toBeNull();
  });
});
