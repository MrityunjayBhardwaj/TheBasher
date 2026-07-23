// curvePoints — the point-edit op-builders (#321). These are the ONE authority both the
// inspector rows and the viewport handles (#322) commit through, so the array math is
// pinned here once rather than trusted twice.

import { describe, expect, it, beforeAll } from 'vitest';
import { applyOp } from '../core/dag/ops';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import type { Vec3 } from '../nodes/types';
import { withIds } from '../test-utils/curvePoints';
import {
  buildDeleteCurvePointOps,
  buildInsertCurvePointOps,
  buildSetCurvePointOps,
  buildToggleCurveClosedOp,
  curvePointEntriesOf,
  curvePointsOf,
} from './curvePoints';

const LINE: Vec3[] = [
  [0, 0, 0],
  [2, 0, 0],
  [4, 0, 0],
];

function withCurve(points: Vec3[] = LINE, closed = false): DagState {
  return applyOp(buildDefaultDagState(), {
    type: 'addNode',
    nodeId: 'c1',
    nodeType: 'Curve',
    params: { points: withIds(points), closed },
  }).next;
}

/** Apply the builder's ops — proving they are VALID ops the store accepts (a whole-array
 *  `setParam` that re-validates against the zod schema), not just plausible objects. */
function apply(state: DagState, ops: ReturnType<typeof buildSetCurvePointOps>): DagState {
  let s = state;
  for (const op of ops!) s = applyOp(s, op).next;
  return s;
}

beforeAll(() => {
  registerAllNodes();
});

describe('curvePoints — whole-array edits', () => {
  it('moves one point and leaves the rest untouched', () => {
    const state = withCurve();
    const next = apply(state, buildSetCurvePointOps(state, 'c1', 1, [2, 5, 0]));
    expect(curvePointsOf(next, 'c1')).toEqual([
      [0, 0, 0],
      [2, 5, 0],
      [4, 0, 0],
    ]);
  });

  it('writes the WHOLE array — setParam cannot index into one (core/dag/ops setAtPath)', () => {
    const state = withCurve();
    const ops = buildSetCurvePointOps(state, 'c1', 1, [2, 5, 0])!;
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: 'setParam', nodeId: 'c1', paramPath: 'points' });
    expect((ops[0] as { value: Vec3[] }).value).toHaveLength(3);
  });

  it('inserts at the MIDPOINT of the span it splits, so the path shape survives the insert', () => {
    const state = withCurve();
    const next = apply(state, buildInsertCurvePointOps(state, 'c1', 0));
    expect(curvePointsOf(next, 'c1')).toEqual([
      [0, 0, 0],
      [1, 0, 0], // midway between [0,0,0] and [2,0,0]
      [2, 0, 0],
      [4, 0, 0],
    ]);
  });

  it('inserting after the LAST point of an open curve EXTENDS it, continuing the direction', () => {
    const state = withCurve();
    const next = apply(state, buildInsertCurvePointOps(state, 'c1', 2));
    // The last span ran [2,0,0] → [4,0,0]; the new point continues by the same step.
    expect(curvePointsOf(next, 'c1')).toEqual([...LINE, [6, 0, 0]]);
  });

  it('a CLOSED curve has no "last" span — inserting after the end splits the wrap-around', () => {
    const state = withCurve(LINE, true);
    const next = apply(state, buildInsertCurvePointOps(state, 'c1', 2));
    // Midway between the last point [4,0,0] and the first [0,0,0].
    expect(curvePointsOf(next, 'c1')![3]).toEqual([2, 0, 0]);
  });

  it('deletes a point', () => {
    const state = withCurve();
    const next = apply(state, buildDeleteCurvePointOps(state, 'c1', 1));
    expect(curvePointsOf(next, 'c1')).toEqual([
      [0, 0, 0],
      [4, 0, 0],
    ]);
  });

  it('REFUSES to delete below two points — a path needs a span (a refusal, not a no-op)', () => {
    const state = withCurve([
      [0, 0, 0],
      [1, 0, 0],
    ]);
    expect(buildDeleteCurvePointOps(state, 'c1', 0)).toBeNull();
  });

  it('toggles closed', () => {
    const state = withCurve();
    const next = apply(state, buildToggleCurveClosedOp(state, 'c1'));
    expect((next.nodes.c1.params as { closed: boolean }).closed).toBe(true);
  });

  it('refuses a non-Curve node and an out-of-range index', () => {
    const state = withCurve();
    expect(curvePointsOf(state, 'n_box')).toBeNull();
    expect(buildSetCurvePointOps(state, 'n_box', 0, [0, 0, 0])).toBeNull();
    expect(buildSetCurvePointOps(state, 'c1', 9, [0, 0, 0])).toBeNull();
    expect(buildDeleteCurvePointOps(state, 'c1', -1)).toBeNull();
  });
});

describe('curvePoints — stable ids (#453)', () => {
  it('preserves the moved point’s id (a move changes co, not identity)', () => {
    const state = withCurve(); // cp0, cp1, cp2
    const before = curvePointEntriesOf(state, 'c1')!;
    const next = apply(state, buildSetCurvePointOps(state, 'c1', 1, [2, 5, 0]));
    const after = curvePointEntriesOf(next, 'c1')!;
    expect(after.map((e) => e.id)).toEqual(before.map((e) => e.id));
    expect(after[1]).toEqual({ id: before[1].id, co: [2, 5, 0] });
  });

  it('preserves survivor ids across a delete (identity is not re-indexed)', () => {
    const state = withCurve();
    const next = apply(state, buildDeleteCurvePointOps(state, 'c1', 1)); // drop cp1
    expect(curvePointEntriesOf(next, 'c1')!.map((e) => e.id)).toEqual(['cp0', 'cp2']);
  });

  it('stamps the caller-minted id on an inserted point', () => {
    const state = withCurve();
    const next = apply(state, buildInsertCurvePointOps(state, 'c1', 0, 'mine'));
    expect(curvePointEntriesOf(next, 'c1')!.map((e) => e.id)).toEqual([
      'cp0',
      'mine',
      'cp1',
      'cp2',
    ]);
  });

  it('falls back to a fresh unique id when the caller passes none', () => {
    const state = withCurve();
    const next = apply(state, buildInsertCurvePointOps(state, 'c1', 0));
    const ids = curvePointEntriesOf(next, 'c1')!.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // no collision
    expect(ids).toContain('cp3'); // cp0..cp2 taken → mints cp3
  });
});
