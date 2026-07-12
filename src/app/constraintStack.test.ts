// constraintStack — the authoring half of the constraint stack (#312). Asserts the
// EDGE-LESS mutations: add writes `target` + an `order` above the stack, mute toggles
// `mute`, move SWAPS `order` (no re-wiring — a constraint has no data edge), remove
// just drops the node. And the load-bearing one: the panel's rows are the SAME scan +
// order the resolver folds, muted members included so a bypassed row can be re-enabled.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, __resetRegistryForTests } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import {
  buildAddConstraintOps,
  buildMoveConstraintOps,
  buildRemoveConstraintOps,
  buildToggleConstraintMuteOp,
  constraintStackEntries,
} from './constraintStack';
import { constraintStackForTarget } from './nodeConstraints';

const BOX_ID = 'n_box';

function apply(state: DagState, ops: Op[]): DagState {
  return ops.reduce((s, op) => applyOp(s, op).next, state);
}

/** Add `n` constraints to the box through the real op-builder. */
function withConstraints(n: number): { state: DagState; ids: string[] } {
  let state = buildDefaultDagState();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const res = buildAddConstraintOps(state, BOX_ID, 'TrackTo', `n_c${i}`)!;
    state = apply(state, res.ops);
    ids.push(res.constraintId);
  }
  return { state, ids };
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('constraintStack — add (edge-less)', () => {
  it('adds a constraint carrying the target, with NO wiring', () => {
    const { state, ids } = withConstraints(1);
    const node = state.nodes[ids[0]];
    expect(node.type).toBe('TrackTo');
    expect((node.params as { target: string }).target).toBe(BOX_ID);
    // The species is edge-less: adding a constraint dispatches exactly one op.
    const res = buildAddConstraintOps(state, BOX_ID, 'TrackTo');
    expect(res!.ops).toHaveLength(1);
    expect(res!.ops[0].type).toBe('addNode');
  });

  it('each new constraint lands on TOP of the stack', () => {
    const { state, ids } = withConstraints(3);
    const stack = constraintStackForTarget(state.nodes, BOX_ID);
    expect(stack.map((m) => m.nodeId)).toEqual(ids);
    expect(stack.map((m) => m.order)).toEqual([0, 1, 2]);
  });

  it('returns null for an unknown target', () => {
    expect(buildAddConstraintOps(buildDefaultDagState(), 'n_nope', 'TrackTo')).toBeNull();
  });
});

describe('constraintStack — mute', () => {
  it('toggles `mute`, and a muted member leaves the RESOLVED stack but stays a ROW', () => {
    const { state: s0, ids } = withConstraints(2);
    let state = apply(s0, [buildToggleConstraintMuteOp(s0, ids[0])!]);

    // The resolver skips it (a muted constraint contributes nothing to the fold)…
    expect(constraintStackForTarget(state.nodes, BOX_ID).map((m) => m.nodeId)).toEqual([ids[1]]);
    // …but the panel still shows it, flagged, so the user can re-enable it.
    const rows = constraintStackEntries(state, BOX_ID);
    expect(rows.map((r) => r.nodeId)).toEqual(ids);
    expect(rows.map((r) => r.muted)).toEqual([true, false]);

    // Un-mute restores it to the fold.
    state = apply(state, [buildToggleConstraintMuteOp(state, ids[0])!]);
    expect(constraintStackForTarget(state.nodes, BOX_ID)).toHaveLength(2);
  });

  it('refuses a node that is not a relational pose operator', () => {
    const state = buildDefaultDagState();
    expect(buildToggleConstraintMuteOp(state, BOX_ID)).toBeNull();
  });
});

describe('constraintStack — move (order swap, not re-wiring)', () => {
  it('moving up swaps order with the member above — and only writes `order`', () => {
    const { state, ids } = withConstraints(3); // orders 0,1,2
    const ops = buildMoveConstraintOps(state, ids[0], 'up')!;
    expect(ops.every((o) => o.type === 'setParam')).toBe(true); // no connect/disconnect
    const next = apply(state, ops);
    expect(constraintStackForTarget(next.nodes, BOX_ID).map((m) => m.nodeId)).toEqual([
      ids[1],
      ids[0],
      ids[2],
    ]);
  });

  it('moving down swaps with the member below', () => {
    const { state, ids } = withConstraints(3);
    const next = apply(state, buildMoveConstraintOps(state, ids[2], 'down')!);
    expect(constraintStackForTarget(next.nodes, BOX_ID).map((m) => m.nodeId)).toEqual([
      ids[0],
      ids[2],
      ids[1],
    ]);
  });

  it('is a no-op at the ends of the stack (the UI disables those buttons)', () => {
    const { state, ids } = withConstraints(2);
    expect(buildMoveConstraintOps(state, ids[1], 'up')).toBeNull(); // already top
    expect(buildMoveConstraintOps(state, ids[0], 'down')).toBeNull(); // already bottom
  });

  it('reorders EQUAL-order members (every pre-stack project is all-zero)', () => {
    // Two legacy constraints, both order 0 — a naive swap would be a no-op.
    let state = buildDefaultDagState();
    for (const id of ['n_leg0', 'n_leg1']) {
      state = apply(state, [
        { type: 'addNode', nodeId: id, nodeType: 'TrackTo', params: { target: BOX_ID } } as Op,
      ]);
    }
    expect(constraintStackForTarget(state.nodes, BOX_ID).map((m) => m.order)).toEqual([0, 0]);
    const next = apply(state, buildMoveConstraintOps(state, 'n_leg0', 'up')!);
    expect(constraintStackForTarget(next.nodes, BOX_ID).map((m) => m.nodeId)).toEqual([
      'n_leg1',
      'n_leg0',
    ]);
  });

  it('a muted member reorders like any other (what you see is what moves)', () => {
    const { state: s0, ids } = withConstraints(2);
    const state = apply(s0, [buildToggleConstraintMuteOp(s0, ids[1])!]); // mute the TOP
    const next = apply(state, buildMoveConstraintOps(state, ids[0], 'up')!);
    expect(constraintStackEntries(next, BOX_ID).map((r) => r.nodeId)).toEqual([ids[1], ids[0]]);
  });
});

describe('constraintStack — remove', () => {
  it('drops the node (nothing to unwire)', () => {
    const { state, ids } = withConstraints(2);
    const ops = buildRemoveConstraintOps(state, ids[0])!;
    expect(ops).toEqual([{ type: 'removeNode', nodeId: ids[0] }]);
    const next = apply(state, ops);
    expect(constraintStackForTarget(next.nodes, BOX_ID).map((m) => m.nodeId)).toEqual([ids[1]]);
  });
});

describe('constraintStack — rows match the fold', () => {
  it('the panel order IS the resolution order', () => {
    const { state: s0, ids } = withConstraints(3);
    const state = apply(s0, buildMoveConstraintOps(s0, ids[0], 'up')!);
    const rows = constraintStackEntries(state, BOX_ID).map((r) => r.nodeId);
    const resolved = constraintStackForTarget(state.nodes, BOX_ID).map((m) => m.nodeId);
    expect(rows).toEqual(resolved);
  });
});
