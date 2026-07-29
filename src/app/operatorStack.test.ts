// operatorStack — the OperatorStack wiring helper (epic #201, #209, V58). Proves
// the stack-as-sub-chain contract: add inserts a modifier at the TOP (re-wires
// base→mod→consumer); the stack enumerates bottom→top; remove splices the chain
// closed; mute toggles the bypass param; reorder swaps adjacent modifiers by pure
// re-wiring. All over the real DAG (applyOp), starting from the default split Box.
//
// #415 MOVED THE STACK ONTO THE DATA LANE, and this file had to be re-aimed twice over
// because it had conflated two nodes that are now distinct:
//
//   before:  n_box (Object) ──▶ mod ──▶ Scene.children
//   after:   n_box_data ──▶ mod ──▶ n_box (Object) ──▶ Scene.children
//
//   1. THE BASE IS THE DATA NODE. Every `findConsumer(state, BOX)` here meant "the edge
//      the stack splices into", and that edge now leaves the DATA node. It is resolved
//      through `resolveStackBase` rather than hardcoded, so these cases also pin the
//      production path the panel takes from a selected Object down to its data.
//
//   2. THE OBJECT'S EDGE TO THE SCENE IS NOW AN INVARIANT — which is exactly the shape
//      that goes vacuous if you are not watching for it ([[H218]]). Pre-flip, `n_box →
//      Scene.children` was the edge that MOVED when a modifier was added, so asserting
//      it proved the splice happened. Post-flip it never moves at all: the Object stays
//      the scene object no matter how many operators sit on its data. So it is asserted
//      here DELIBERATELY and by name, as an invariant across add/remove/reorder, rather
//      than left in place looking like the check it used to be.
//
// REF: src/app/operatorStack.ts; src/nodes/ArrayModifier.ts; vyapti V58; issue #415.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { buildDefaultDagState } from '../core/project/default';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import {
  buildAddModifierOps,
  buildMoveModifierOps,
  buildRemoveModifierOps,
  buildToggleModifierMuteOp,
  enumerateModifierStack,
  findConsumer,
  resolveStackBase,
} from './operatorStack';

/** The OBJECT — what a user selects, and what stays the scene object throughout. */
const BOX = 'n_box';
/** The mesh DATA — where the stack actually lives after #415. */
const BOX_DATA = 'n_box_data';

function applyOps(state: DagState, ops: Op[]): DagState {
  return ops.reduce((s, op) => applyOp(s, op).next, state);
}

/** Add a modifier the way the panel does: from the SELECTED node, through
 *  `resolveStackBase`. Passing the base directly would skip the one step #415 changed. */
function addMod(
  state: DagState,
  selected: string,
  params: Record<string, unknown> = {},
): { state: DagState; id: string } {
  const res = buildAddModifierOps(state, resolveStackBase(state, selected), 'ArrayModifier', {
    count: 3,
    offset: [2, 0, 0],
    ...params,
  });
  expect(res).not.toBeNull();
  return { state: applyOps(state, res!.ops), id: res!.modifierId };
}

/** The Object's edge into the scene — an INVARIANT post-#415, asserted by name so it
 *  cannot be mistaken for the moving part it used to be. */
function sceneEdgeOf(state: DagState) {
  return findConsumer(state, BOX);
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('operatorStack', () => {
  it('a fresh mesh has an empty stack', () => {
    const state = buildDefaultDagState();
    expect(enumerateModifierStack(state, BOX_DATA)).toEqual([]);
  });

  // #415 POSSESSION — the base of a selected Object's stack is the DATA it poses, not
  // the Object. Stated once, up front, because every case below routes through it: if
  // this hop were wrong they would all fail for the same reason and none would say why.
  it('the stack base of a selected Object is its data node (the data lane)', () => {
    const state = buildDefaultDagState();
    expect(resolveStackBase(state, BOX)).toBe(BOX_DATA);
    // …and from a data node or a modifier it is still itself / the chain bottom.
    expect(resolveStackBase(state, BOX_DATA)).toBe(BOX_DATA);
    const { state: withMod, id } = addMod(state, BOX);
    expect(resolveStackBase(withMod, id)).toBe(BOX_DATA);
  });

  it('add inserts a modifier BETWEEN the data and the Object that poses it', () => {
    const state0 = buildDefaultDagState();
    // The DATA feeds the Object's `data` socket before any modifier — that is the edge
    // the stack splices into now.
    const before = findConsumer(state0, BOX_DATA);
    expect(before).toEqual({ node: BOX, socket: 'data' });
    const sceneEdge = sceneEdgeOf(state0);
    expect(sceneEdge?.socket).toBe('children');

    const { state, id } = addMod(state0, BOX);
    // The data now feeds the modifier's target; the modifier feeds the Object's data.
    expect(findConsumer(state, BOX_DATA)).toEqual({ node: id, socket: 'target' });
    expect(findConsumer(state, id)).toEqual(before);
    // INVARIANT (H218): the Object's edge to the scene did NOT move. Pre-#415 this was
    // the edge that got re-routed; now it is the thing that must not.
    expect(sceneEdgeOf(state)).toEqual(sceneEdge);

    const stack = enumerateModifierStack(state, BOX_DATA);
    expect(stack.map((m) => m.nodeId)).toEqual([id]);
    expect(stack[0].type).toBe('ArrayModifier');
    expect(stack[0].muted).toBe(false);
  });

  it('a second add stacks on TOP (base → m1 → m2 → consumer), bottom-to-top order', () => {
    const r1 = addMod(buildDefaultDagState(), BOX);
    const m1 = r1.id;
    let state = r1.state;
    const consumerBefore = findConsumer(state, m1); // m1 → the Object's `data`
    const r2 = addMod(state, BOX);
    state = r2.state;
    const m2 = r2.id;

    expect(enumerateModifierStack(state, BOX_DATA).map((m) => m.nodeId)).toEqual([m1, m2]);
    // m1 now feeds m2; m2 feeds the original consumer (the Object's `data`).
    expect(findConsumer(state, m1)).toEqual({ node: m2, socket: 'target' });
    expect(findConsumer(state, m2)).toEqual(consumerBefore);
    // …and two operators deep, the Object is still the scene object (H218 invariant).
    expect(sceneEdgeOf(state)?.socket).toBe('children');
  });

  it('remove splices the chain closed (base → m2 → consumer)', () => {
    const r1 = addMod(buildDefaultDagState(), BOX);
    const m1 = r1.id;
    let state = r1.state;
    const consumer = findConsumer(state, m1);
    const r2 = addMod(state, BOX);
    state = r2.state;
    const m2 = r2.id;

    // Remove the BOTTOM modifier (m1) — the base should re-wire straight to m2.
    const ops = buildRemoveModifierOps(state, m1);
    expect(ops).not.toBeNull();
    state = applyOps(state, ops!);

    expect(state.nodes[m1]).toBeUndefined(); // gone
    expect(enumerateModifierStack(state, BOX_DATA).map((m) => m.nodeId)).toEqual([m2]);
    expect(findConsumer(state, BOX_DATA)).toEqual({ node: m2, socket: 'target' });
    expect(findConsumer(state, m2)).toEqual(consumer);
  });

  it('removing the only modifier re-wires the base straight back to its consumer', () => {
    const state0 = buildDefaultDagState();
    const consumer = findConsumer(state0, BOX_DATA); // the data → Object.data edge
    const { state: s1, id } = addMod(state0, BOX);
    const s2 = applyOps(s1, buildRemoveModifierOps(s1, id)!);
    expect(enumerateModifierStack(s2, BOX_DATA)).toEqual([]);
    expect(findConsumer(s2, BOX_DATA)).toEqual(consumer); // back to the original edge
  });

  it('mute toggles the bypass param (keyframeable setParam)', () => {
    const { state, id } = addMod(buildDefaultDagState(), BOX);
    const op = buildToggleModifierMuteOp(state, id);
    expect(op).toMatchObject({ type: 'setParam', nodeId: id, paramPath: 'muted', value: true });
    const s2 = applyOp(state, op!).next;
    expect(enumerateModifierStack(s2, BOX_DATA)[0].muted).toBe(true);
    // toggling again clears it
    expect(buildToggleModifierMuteOp(s2, id)).toMatchObject({ value: false });
  });

  it('reorder swaps two adjacent modifiers by pure re-wiring (base → m2 → m1 → consumer)', () => {
    const r1 = addMod(buildDefaultDagState(), BOX);
    const m1 = r1.id;
    let state = r1.state;
    const consumer = findConsumer(state, m1);
    const r2 = addMod(state, BOX);
    state = r2.state;
    const m2 = r2.id;
    expect(enumerateModifierStack(state, BOX_DATA).map((m) => m.nodeId)).toEqual([m1, m2]);

    // Move m1 UP (toward the consumer) — it swaps with m2.
    const ops = buildMoveModifierOps(state, m1, 'up');
    expect(ops).not.toBeNull();
    state = applyOps(state, ops!);

    expect(enumerateModifierStack(state, BOX_DATA).map((m) => m.nodeId)).toEqual([m2, m1]);
    expect(findConsumer(state, BOX_DATA)).toEqual({ node: m2, socket: 'target' });
    expect(findConsumer(state, m2)).toEqual({ node: m1, socket: 'target' });
    expect(findConsumer(state, m1)).toEqual(consumer);
  });

  it('reorder past the end is a no-op (null)', () => {
    const { state, id } = addMod(buildDefaultDagState(), BOX);
    expect(buildMoveModifierOps(state, id, 'up')).toBeNull(); // only one — can't go up
    expect(buildMoveModifierOps(state, id, 'down')).toBeNull(); // nor down
  });

  it('the builders reject a non-modifier node', () => {
    const state = buildDefaultDagState();
    expect(buildRemoveModifierOps(state, BOX)).toBeNull();
    expect(buildToggleModifierMuteOp(state, BOX)).toBeNull();
    expect(buildMoveModifierOps(state, BOX, 'up')).toBeNull();
  });
});
