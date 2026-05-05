// Tests for buildWalkToOps — the click-to-move macro.
//
// Acceptance #2: emits a Character → WalkPath chain via dispatchAtomic;
// one Cmd+Z reverts. The unit test verifies the OP CHAIN; the E2E spec
// verifies the dispatchAtomic + undo path.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetRegistryForTests,
  applyOp,
  emptyDagState,
  evaluate,
  type DagState,
} from '../../core/dag';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import type { CharacterValue } from '../../nodes/types';
import { buildWalkToOps } from './walkTo';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

function buildBaselineCharacter(): DagState {
  let state = emptyDagState();
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'time',
    nodeType: 'TimeSource',
    params: {},
  }).next;
  state = applyOp(state, { type: 'addNode', nodeId: 'sk', nodeType: 'Skeleton', params: {} }).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'clip',
    nodeType: 'AnimationClip',
    params: { name: 'walk', duration: 1, loop: true, keyframes: [] },
  }).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'nav',
    nodeType: 'Navmesh',
    params: { halfSize: [10, 10], obstacles: [] },
  }).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'loco',
    nodeType: 'LocomotionState',
    params: { speed: 1, loop: true },
  }).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'char',
    nodeType: 'Character',
    params: { name: 'alice' },
  }).next;
  // Wires (no path yet).
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'sk', socket: 'out' },
    to: { node: 'clip', socket: 'skeleton' },
  }).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'time', socket: 'out' },
    to: { node: 'clip', socket: 'time' },
  }).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'clip', socket: 'out' },
    to: { node: 'loco', socket: 'clip' },
  }).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'time', socket: 'out' },
    to: { node: 'loco', socket: 'time' },
  }).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'loco', socket: 'out' },
    to: { node: 'char', socket: 'locomotion' },
  }).next;
  return state;
}

function applyAll(
  state: DagState,
  ops: ReturnType<typeof buildWalkToOps> extends infer X
    ? X extends { ops: infer O }
      ? O
      : never
    : never,
): DagState {
  let s = state;
  for (const op of ops) s = applyOp(s, op).next;
  return s;
}

describe('buildWalkToOps', () => {
  it('emits a 2-op chain when no existing path is wired (addNode WalkPath, connect to loco.path)', () => {
    const state = buildBaselineCharacter();
    const result = buildWalkToOps(state, 'char', [3, 0, 1]);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.ops).toHaveLength(2);
    expect(result.ops[0].type).toBe('addNode');
    expect(result.ops[1].type).toBe('connect');
  });

  it('returns null when characterId is not a Character node', () => {
    const state = buildBaselineCharacter();
    expect(buildWalkToOps(state, 'sk', [1, 0, 0])).toBeNull();
  });

  it('returns null when no Navmesh exists in the DAG', () => {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'time',
      nodeType: 'TimeSource',
      params: {},
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'loco',
      nodeType: 'LocomotionState',
      params: { speed: 1, loop: true },
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'char',
      nodeType: 'Character',
      params: { name: 'a' },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'loco', socket: 'out' },
      to: { node: 'char', socket: 'locomotion' },
    }).next;
    expect(buildWalkToOps(state, 'char', [1, 0, 0])).toBeNull();
  });

  it('the new WalkPath is pre-wired to the navmesh on creation (no extra connect op needed)', () => {
    const state = buildBaselineCharacter();
    const result = buildWalkToOps(state, 'char', [3, 0, 1]);
    if (!result) throw new Error('expected ops');
    const addOp = result.ops[0];
    if (addOp.type !== 'addNode') throw new Error('expected addNode');
    expect(addOp.inputs?.navmesh).toEqual({ node: 'nav', socket: 'out' });
  });

  it('applying the chain produces a Character whose loco.path resolves to the new WalkPath', () => {
    const state = buildBaselineCharacter();
    const result = buildWalkToOps(state, 'char', [3, 0, 1]);
    if (!result) throw new Error('expected ops');
    const next = applyAll(state, result.ops);
    const char = evaluate(next, 'char', { ctx: { time: { frame: 0, seconds: 0, normalized: 0 } } })
      .value as CharacterValue;
    // At t=0 the character is at the start of the new path → from = [0,0,0]
    // (locomotion has no prior `to`, so `from` defaults to origin).
    expect(char.position[0]).toBeCloseTo(0, 5);
    expect(char.position[2]).toBeCloseTo(0, 5);
  });

  it('subsequent walkTo with an already-wired path emits 3 ops (disconnect old, addNode new, connect new)', () => {
    let state = buildBaselineCharacter();
    const first = buildWalkToOps(state, 'char', [3, 0, 0]);
    if (!first) throw new Error('expected first ops');
    state = applyAll(state, first.ops);
    const second = buildWalkToOps(state, 'char', [-3, 0, 0]);
    if (!second) throw new Error('expected second ops');
    expect(second.ops).toHaveLength(3);
    expect(second.ops[0].type).toBe('disconnect');
    expect(second.ops[1].type).toBe('addNode');
    expect(second.ops[2].type).toBe('connect');
  });

  it("second walkTo's `from` carries forward from the first walkTo's `to` (continuity)", () => {
    let state = buildBaselineCharacter();
    const first = buildWalkToOps(state, 'char', [3, 0, 0]);
    if (!first) throw new Error('expected first ops');
    state = applyAll(state, first.ops);
    const second = buildWalkToOps(state, 'char', [-3, 0, 0]);
    if (!second) throw new Error('expected second ops');
    const addNew = second.ops.find((o) => o.type === 'addNode');
    if (!addNew || addNew.type !== 'addNode') throw new Error('expected addNode op');
    const params = addNew.params as { from: [number, number, number] };
    expect(params.from).toEqual([3, 0, 0]);
  });
});
