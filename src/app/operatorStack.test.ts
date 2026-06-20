// operatorStack — the OperatorStack wiring helper (epic #201, #209, V58). Proves
// the stack-as-sub-chain contract: add inserts a modifier at the TOP (re-wires
// base→mod→consumer); the stack enumerates bottom→top; remove splices the chain
// closed; mute toggles the bypass param; reorder swaps adjacent modifiers by pure
// re-wiring. All over the real DAG (applyOp), starting from the default Box wired
// into Scene.children.
//
// REF: src/app/operatorStack.ts; src/nodes/ArrayModifier.ts; vyapti V58.

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
} from './operatorStack';

const BOX = 'n_box';

function applyOps(state: DagState, ops: Op[]): DagState {
  return ops.reduce((s, op) => applyOp(s, op).next, state);
}

function addMod(state: DagState, base: string, params: Record<string, unknown> = {}): { state: DagState; id: string } {
  const res = buildAddModifierOps(state, base, 'ArrayModifier', { count: 3, offset: [2, 0, 0], ...params });
  expect(res).not.toBeNull();
  return { state: applyOps(state, res!.ops), id: res!.modifierId };
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('operatorStack', () => {
  it('a fresh mesh has an empty stack', () => {
    const state = buildDefaultDagState();
    expect(enumerateModifierStack(state, BOX)).toEqual([]);
  });

  it('add inserts a modifier BETWEEN the base and its consumer (Scene.children)', () => {
    const state0 = buildDefaultDagState();
    // The box feeds Scene.children before any modifier.
    const before = findConsumer(state0, BOX);
    expect(before?.socket).toBe('children');

    const { state, id } = addMod(state0, BOX);
    // The box now feeds the modifier's target; the modifier feeds the old consumer.
    expect(findConsumer(state, BOX)).toEqual({ node: id, socket: 'target' });
    expect(findConsumer(state, id)).toEqual(before);

    const stack = enumerateModifierStack(state, BOX);
    expect(stack.map((m) => m.nodeId)).toEqual([id]);
    expect(stack[0].type).toBe('ArrayModifier');
    expect(stack[0].muted).toBe(false);
  });

  it('a second add stacks on TOP (base → m1 → m2 → consumer), bottom-to-top order', () => {
    const r1 = addMod(buildDefaultDagState(), BOX);
    const m1 = r1.id;
    let state = r1.state;
    const consumerBefore = findConsumer(state, m1); // m1 → Scene.children
    const r2 = addMod(state, BOX);
    state = r2.state;
    const m2 = r2.id;

    expect(enumerateModifierStack(state, BOX).map((m) => m.nodeId)).toEqual([m1, m2]);
    // m1 now feeds m2; m2 feeds the original consumer.
    expect(findConsumer(state, m1)).toEqual({ node: m2, socket: 'target' });
    expect(findConsumer(state, m2)).toEqual(consumerBefore);
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
    expect(enumerateModifierStack(state, BOX).map((m) => m.nodeId)).toEqual([m2]);
    expect(findConsumer(state, BOX)).toEqual({ node: m2, socket: 'target' });
    expect(findConsumer(state, m2)).toEqual(consumer);
  });

  it('removing the only modifier re-wires the base straight back to its consumer', () => {
    const state0 = buildDefaultDagState();
    const consumer = findConsumer(state0, BOX);
    const { state: s1, id } = addMod(state0, BOX);
    const s2 = applyOps(s1, buildRemoveModifierOps(s1, id)!);
    expect(enumerateModifierStack(s2, BOX)).toEqual([]);
    expect(findConsumer(s2, BOX)).toEqual(consumer); // back to the original edge
  });

  it('mute toggles the bypass param (keyframeable setParam)', () => {
    const { state, id } = addMod(buildDefaultDagState(), BOX);
    const op = buildToggleModifierMuteOp(state, id);
    expect(op).toMatchObject({ type: 'setParam', nodeId: id, paramPath: 'muted', value: true });
    const s2 = applyOp(state, op!).next;
    expect(enumerateModifierStack(s2, BOX)[0].muted).toBe(true);
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
    expect(enumerateModifierStack(state, BOX).map((m) => m.nodeId)).toEqual([m1, m2]);

    // Move m1 UP (toward the consumer) — it swaps with m2.
    const ops = buildMoveModifierOps(state, m1, 'up');
    expect(ops).not.toBeNull();
    state = applyOps(state, ops!);

    expect(enumerateModifierStack(state, BOX).map((m) => m.nodeId)).toEqual([m2, m1]);
    expect(findConsumer(state, BOX)).toEqual({ node: m2, socket: 'target' });
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
