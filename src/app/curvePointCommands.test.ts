// curvePointCommands — the commit layer over the point-edit op-builders (#322).
//
// The op-builders' array math is pinned in curvePoints.test.ts. What is pinned HERE is the
// half that only exists because the viewport can select a point: the SELECTION-AFTER-EDIT
// rule. A point is now addressed by a STABLE id (#453), so the id travels WITH its point
// across every insert, delete and reorder — a selection can no longer silently slide onto a
// neighbour the way a raw index did. These tests are the proof of that survival: after an
// insert BEFORE the selection, or a delete of a LATER point, the selected id is UNCHANGED and
// still resolves to the same physical point. The old index re-index dance is gone; there is
// nothing left to re-index.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag/ops';
import { useDagStore } from '../core/dag/store';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import type { Vec3 } from '../nodes/types';
import { withIds } from '../test-utils/curvePoints';
import { curvePointEntriesOf, curvePointsOf, resolveCurvePointSelection } from './curvePoints';
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
    params: { points: withIds(points), closed },
  }).next;
  useDagStore.setState({ state } as never);
  return state;
}

const points = () => curvePointsOf(useDagStore.getState().state, 'c1');
const entries = () => curvePointEntriesOf(useDagStore.getState().state, 'c1');
const selection = () => useCurveSelectionStore.getState();
const resolved = () => resolveCurvePointSelection(useDagStore.getState().state, selection());

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

describe('curvePointCommands — the id-addressed selection rule', () => {
  it('EXTRUDE selects the NEW point by its minted id, so the director can drag what they just made', () => {
    seedCurve();
    useCurveSelectionStore.getState().selectPoint('c1', 'cp1');
    expect(extrudeCurvePoint('c1', 1)).toBe(true);
    // The new point landed at array index 2 (inserted after index 1); mintId over cp0..cp2 → cp3.
    const newPoint = entries()![2];
    expect(newPoint.co).toEqual([3, 0, 0]); // the midpoint of the span it split
    expect(newPoint.id).toBe('cp3'); // deterministic mint over the existing ids
    expect(selection().pointId).toBe(newPoint.id); // the store selected the NEW point, by id
  });

  it('an INSERT before the selection leaves its id UNCHANGED — the SAME physical point stays selected', () => {
    seedCurve();
    useCurveSelectionStore.getState().selectPoint('c1', 'cp2'); // [4,0,0], at index 2
    const before = resolved();
    insertCurvePoint('c1', 0); // a new point lands at index 1, pushing cp2 to index 3
    // The crux of the whole phase: the selected id did NOT shift (an id is not an index).
    expect(selection().pointId).toBe('cp2');
    const after = resolved();
    expect(after!.co).toEqual([4, 0, 0]); // still the same physical point
    expect(after!.co).toEqual(before!.co);
    expect(after!.index).toBe(3); // its SLOT moved 2→3; its id did not
  });

  it('an INSERT after the selection leaves it alone (same id, same point)', () => {
    seedCurve();
    useCurveSelectionStore.getState().selectPoint('c1', 'cp0'); // [0,0,0], at index 0
    insertCurvePoint('c1', 1); // a new point lands at index 2 — after the selection
    expect(selection().pointId).toBe('cp0');
    expect(resolved()!.co).toEqual([0, 0, 0]);
    expect(resolved()!.index).toBe(0);
  });

  it('deleting the SELECTED point clears the selection (there is nothing left to select)', () => {
    seedCurve();
    useCurveSelectionStore.getState().selectPoint('c1', 'cp1');
    expect(deleteCurvePoint('c1', 1)).toBe(true); // index 1 IS cp1
    expect(selection().pointId).toBeNull();
    expect(selection().nodeId).toBeNull();
  });

  it('deleting a LATER point leaves the selected id UNCHANGED — it still names the same point', () => {
    seedCurve();
    useCurveSelectionStore.getState().selectPoint('c1', 'cp0'); // [0,0,0], at index 0
    deleteCurvePoint('c1', 2); // removes cp2, a LATER point
    expect(selection().pointId).toBe('cp0');
    expect(resolved()!.co).toEqual([0, 0, 0]);
    expect(resolved()!.index).toBe(0);
  });

  it('deleting a point BEFORE the selection leaves its id UNCHANGED — no decrement', () => {
    seedCurve();
    useCurveSelectionStore.getState().selectPoint('c1', 'cp2'); // [4,0,0], at index 2
    deleteCurvePoint('c1', 0); // removes cp0, shrinking cp2 from index 2 → 1
    expect(selection().pointId).toBe('cp2'); // the id did not decrement (it is not an index)
    expect(resolved()!.co).toEqual([4, 0, 0]);
    expect(resolved()!.index).toBe(1); // slot shifted 2→1, id intact
  });

  it('an edit on ANOTHER curve never touches this curve’s selection', () => {
    seedCurve();
    const two = applyOp(useDagStore.getState().state, {
      type: 'addNode',
      nodeId: 'c2',
      nodeType: 'Curve',
      params: { points: withIds(LINE) },
    }).next;
    useDagStore.setState({ state: two } as never);
    useCurveSelectionStore.getState().selectPoint('c1', 'cp2');
    insertCurvePoint('c2', 0);
    deleteCurvePoint('c2', 0);
    expect(selection()).toMatchObject({ nodeId: 'c1', pointId: 'cp2' });
  });
});

describe('curvePointCommands — the refused delete ANNOUNCES itself (V38)', () => {
  it('refuses at the two-point floor, commits nothing, and toasts', () => {
    seedCurve([
      [0, 0, 0],
      [1, 0, 0],
    ]);
    useCurveSelectionStore.getState().selectPoint('c1', 'cp0');
    expect(deleteCurvePoint('c1', 0)).toBe(false);
    expect(points()).toHaveLength(2); // nothing committed
    expect(selection().pointId).toBe('cp0'); // the selection survives a refusal
    // The viewport's Delete key has no disabled state — a silent refusal would read as an
    // unbound key. The toast IS the outcome.
    const toasts = useNotificationStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toMatch(/at least 2 points/i);
  });
});

describe('resolveCurvePointSelection — the one accessor, resolving id → current index', () => {
  it('resolves a live (nodeId, id) pair to its point, with the current index and co', () => {
    const state = seedCurve();
    expect(resolveCurvePointSelection(state, { nodeId: 'c1', pointId: 'cp1' })).toEqual({
      nodeId: 'c1',
      pointId: 'cp1',
      index: 1,
      co: [2, 0, 0],
    });
  });

  it('null for an id that no longer exists — the point was deleted under the selection', () => {
    seedCurve();
    deleteCurvePoint('c1', 2); // removes cp2 (nothing selected, so no auto-clear)
    useCurveSelectionStore.getState().selectPoint('c1', 'cp2'); // a stale pointer, by hand
    expect(resolveCurvePointSelection(useDagStore.getState().state, selection())).toBeNull();
  });

  it('null for a non-Curve node, a missing node, and an empty selection', () => {
    const state = seedCurve();
    expect(resolveCurvePointSelection(state, { nodeId: 'n_box', pointId: 'cp0' })).toBeNull();
    expect(resolveCurvePointSelection(state, { nodeId: 'nope', pointId: 'cp0' })).toBeNull();
    expect(resolveCurvePointSelection(state, { nodeId: null, pointId: null })).toBeNull();
    expect(resolveCurvePointSelection(state, { nodeId: 'c1', pointId: null })).toBeNull();
  });
});

describe('activeCurvePoint — what hides the object gizmo', () => {
  it('is live only while the point’s curve is the PRIMARY object selection', () => {
    const state = seedCurve();
    const sel = { nodeId: 'c1', pointId: 'cp1' };
    // The curve is selected → the point selection is live → Gizmo yields to the point gizmo.
    expect(activeCurvePoint(state, 'c1', sel)).toMatchObject({
      nodeId: 'c1',
      pointId: 'cp1',
      index: 1,
    });
    // Select a cube instead. The raw (c1, cp1) pair is still sitting in the store, but the
    // director is editing the cube now: it MUST get its gizmo back, or the viewport shows a
    // point gizmo for an object that isn't selected.
    expect(activeCurvePoint(state, 'n_box', sel)).toBeNull();
    expect(activeCurvePoint(state, null, sel)).toBeNull();
  });
});
