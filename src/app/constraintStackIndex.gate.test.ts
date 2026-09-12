// #990 — RESOLVING EVERY OBJECT'S CONSTRAINT STACK ENUMERATES THE NODE TABLE ONCE.
//
// `relationalPoseStackForTarget` used to answer "who constrains me?" with a scan of the
// whole node table, and every band goes through it. The render band recomputes every
// constrained object whenever `state` changes, so one scan per object over all objects is
// O(n²): measured at 20 µs per object at 10 objects and 51 µs at 200 — 20× the objects
// costing 51× the time, ~10 ms for a 200-object scene on one edit.
//
// ⚠️ THIS GATE DOES NOT TIME ANYTHING, ON PURPOSE. A wall-clock threshold on a shared
// machine either flakes or gets loosened until it means nothing, and neither failure
// looks like a failure. The property that actually changed is how many times the table is
// ENUMERATED, and that is exactly countable: a Proxy's `ownKeys` trap fires once per
// `Object.entries`. Before the index the count was one per target; now it is one per
// TABLE, no matter how many targets are asked about.
//
// REF: src/app/nodeConstraints.ts (`poseStackIndex`); src/core/dag/evaluator.ts
//      (`paramsHashMemo` — the same derive-once-per-table shape); issue #990.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, __resetRegistryForTests } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { constraintStackForTarget, relationalPoseStackForTarget } from './nodeConstraints';

const N = 40;

function constrainedScene(): { state: DagState; targets: string[] } {
  let state = buildDefaultDagState();
  const targets: string[] = [];
  const ops: Op[] = [];
  for (let i = 0; i < N; i++) {
    const objId = `n_obj_${i}`;
    targets.push(objId);
    ops.push({ type: 'addNode', nodeId: objId, nodeType: 'Object', params: {} });
    ops.push({ type: 'addNode', nodeId: `n_aim_${i}`, nodeType: 'Object', params: {} });
    ops.push({
      type: 'addNode',
      nodeId: `n_tt_${i}`,
      nodeType: 'TrackTo',
      params: { target: objId, aimNode: `n_aim_${i}`, order: 0 },
    });
  }
  for (const op of ops) state = applyOp(state, op).next;
  return { state, targets };
}

/** `nodes`, wrapped so every enumeration of its keys is counted. */
function counting<T extends object>(nodes: T): { proxy: T; count: () => number } {
  let n = 0;
  const proxy = new Proxy(nodes, {
    ownKeys(t) {
      n++;
      return Reflect.ownKeys(t);
    },
  });
  return { proxy, count: () => n };
}

describe('#990 — one enumeration per node table, not one per target', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  it('enumerates the table once while resolving every target', () => {
    const { state, targets } = constrainedScene();
    const { proxy, count } = counting(state.nodes);

    const found = targets.map((id) => constraintStackForTarget(proxy, id).length);

    // THE DENOMINATOR, FIRST. A resolve that found nothing would enumerate once and pass
    // this gate while measuring an empty scene — the shape of a green that means nothing.
    expect(found).toEqual(Array(N).fill(1));
    expect(targets.length).toBe(N);

    // The property. Before the index this was N.
    expect(count(), `enumerated the node table ${count()}× for ${N} targets`).toBe(1);
  });

  it('re-derives after an edit rebuilds the table, and only then', () => {
    const { state, targets } = constrainedScene();
    const first = counting(state.nodes);
    for (const id of targets) constraintStackForTarget(first.proxy, id);
    expect(first.count()).toBe(1);

    // A new table is a new derivation — the identity IS the change signal, so this must
    // NOT reuse the previous index. Asserting it stays stale would pass on a broken memo.
    const edited = applyOp(state, {
      type: 'setParam',
      nodeId: 'n_obj_0',
      paramPath: 'position',
      value: [1, 0, 0],
    }).next;
    expect(edited.nodes).not.toBe(state.nodes);

    const second = counting(edited.nodes);
    for (const id of targets) constraintStackForTarget(second.proxy, id);
    expect(second.count()).toBe(1);
  });

  it('sees a constraint added after the index was derived', () => {
    // The staleness direction, stated as behaviour rather than as a count: if the memo
    // ever outlived its table, this is the row that goes wrong in a director's hands.
    const { state } = constrainedScene();
    expect(relationalPoseStackForTarget(state.nodes, 'n_obj_0', true)).toHaveLength(1);

    const withSecond = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_tt_extra',
      nodeType: 'TrackTo',
      params: { target: 'n_obj_0', aimNode: 'n_aim_1', order: 5 },
    }).next;
    const stack = relationalPoseStackForTarget(withSecond.nodes, 'n_obj_0', true);
    expect(stack.map((m) => m.nodeId)).toEqual(['n_tt_0', 'n_tt_extra']);
  });

  it('hands every caller its own array — the index is never handed out', () => {
    const { state } = constrainedScene();
    const a = relationalPoseStackForTarget(state.nodes, 'n_obj_0', true);
    expect(a).toHaveLength(1); // denominator: there IS something to mutate
    a.push({ nodeId: 'intruder', type: 'TrackTo', order: 99, muted: false, params: {} });

    const b = relationalPoseStackForTarget(state.nodes, 'n_obj_0', true);
    expect(b.map((m) => m.nodeId)).toEqual(['n_tt_0']);
  });
});
