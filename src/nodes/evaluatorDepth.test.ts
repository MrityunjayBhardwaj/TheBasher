// #1576 — how deep one walk may go.
//
// The evaluator refused any walk deeper than 32 nodes. A pose chain is one node per layer, so
// the cap was a ceiling on how many layers a character could have in a row (31 evaluated, 32
// threw). It is now a guard on the JS stack only, set from a measurement, and it says where it
// was hit. A cycle is a different failure, caught exactly at any depth, and stays one.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, evaluate } from '../core/dag';
import { DEPTH_LIMIT, topoSort } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import { emptyDagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { registerAllNodes } from './registerAll';
import type { BoneSpec, PosedSkeletonValue } from './types';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const BONES: BoneSpec[] = [
  { name: 'root', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
  { name: 'tip', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
];

const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);
const node = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}): Op =>
  ({ type: 'addNode', nodeId, nodeType, params }) as Op;
const wire = (from: string, to: string, socket: string, fromSocket = 'out'): Op => ({
  type: 'connect',
  from: { node: from, socket: fromSocket },
  to: { node: to, socket },
});

/** A skeleton with `layers` idle pose layers in a row above it, worn by an armature Object
 *  `obj`: the shape a character has, and the one the old cap was measured on. */
function poseChain(layers: number): { state: DagState; top: string } {
  const ops: Op[] = [node('sk', 'Skeleton', { bones: BONES })];
  let at = 'sk';
  for (let i = 0; i < layers; i++) {
    ops.push(node(`l${i}`, 'PoseLayer', { name: `l${i}` }));
    ops.push(wire(at, `l${i}`, 'pose', i === 0 ? 'pose' : 'out'));
    at = `l${i}`;
  }
  ops.push(node('obj', 'Object'), wire(at, 'obj', 'pose'));
  return { state: apply(emptyDagState(), ops), top: at };
}

/** `count` Math nodes in a row, built by hand: `m0` feeds `m1` feeds … `m{count-1}`. */
function mathChain(count: number): DagState {
  const nodes: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    nodes[`m${i}`] = {
      id: `m${i}`,
      type: 'Math',
      version: 1,
      params: { op: 'add' },
      inputs: i === 0 ? {} : { a: { node: `m${i - 1}`, socket: 'out' } },
    };
  }
  return { nodes, outputs: {} } as unknown as DagState;
}

describe('a long chain evaluates (#1576)', () => {
  it('an Object over 32 pose layers in a row, which used to throw', () => {
    const { state } = poseChain(32);
    const drawn = evaluate(state, 'obj').value as { pose?: PosedSkeletonValue };
    expect(drawn.pose?.skeleton.bones).toHaveLength(BONES.length);
  });

  it('an Object over 100 pose layers in a row', () => {
    const { state, top } = poseChain(100);
    const drawn = evaluate(state, 'obj').value as { pose?: PosedSkeletonValue };
    expect(drawn.pose?.skeleton.bones).toHaveLength(BONES.length);
    const pose = evaluate(state, top).value as PosedSkeletonValue;
    expect(pose.skeleton.bones).toHaveLength(BONES.length);
    expect(pose.sample(0)).toHaveLength(BONES.length);
  });

  it('a chain exactly as long as the limit allows', () => {
    // The root is at depth 0, so DEPTH_LIMIT + 1 nodes reach depth DEPTH_LIMIT.
    const state = mathChain(DEPTH_LIMIT + 1);
    expect(evaluate(state, `m${DEPTH_LIMIT}`).value).toBe(0);
    expect(topoSort(state, `m${DEPTH_LIMIT}`)).toHaveLength(DEPTH_LIMIT + 1);
  });
});

describe('a chain that is too long says where (#1576)', () => {
  it('names the node asked for and the node it stopped at', () => {
    const state = mathChain(DEPTH_LIMIT + 2);
    const root = `m${DEPTH_LIMIT + 1}`;
    expect(() => evaluate(state, root)).toThrow(
      `Evaluator: "${root}" is fed by more than ${DEPTH_LIMIT} nodes in a row (reached "m0")`,
    );
    expect(() => topoSort(state, root)).toThrow(
      `topoSort: "${root}" is fed by more than ${DEPTH_LIMIT} nodes in a row (reached "m0")`,
    );
  });

  it('the limit is far below where the walk would run out of stack', () => {
    // Twice the limit must still fail with the message above, never a RangeError.
    const state = mathChain(DEPTH_LIMIT * 2);
    let caught: unknown;
    try {
      evaluate(state, `m${DEPTH_LIMIT * 2 - 1}`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(RangeError);
    expect((caught as Error).message).toMatch(/nodes in a row/);
  });

  it('a cycle is reported as a cycle, at any depth, not as a long chain', () => {
    // Minted by hand: `connect` refuses the wire that closes a loop.
    const state = mathChain(4);
    const loop = {
      ...state,
      nodes: {
        ...state.nodes,
        m0: { ...state.nodes['m0'], inputs: { a: { node: 'm3', socket: 'out' } } },
      },
    } as unknown as DagState;
    expect(() => evaluate(loop, 'm3')).toThrow('Evaluator: cycle detected at m3');
    expect(() => topoSort(loop, 'm3')).toThrow(/topoSort: cycle detected at/);
  });
});
