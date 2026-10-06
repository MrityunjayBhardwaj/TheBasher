// #1547 — a sub-network has one owner: nothing inside a Solver's body closure may feed
// anything outside it except that Solver's body sockets.
import { beforeEach, describe, expect, it } from 'vitest';
import { registerAllNodes } from '../../nodes/registerAll';
import { __resetRegistryForTests, applyOp } from './index';
import type { DagState } from './state';
import { emptyDagState } from './state';
import { subnetworkOf, subnetworkViolations } from './subnetworks';
import type { Op } from './types';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);
const node = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}): Op =>
  ({ type: 'addNode', nodeId, nodeType, params }) as Op;
const wire = (from: string, to: string, socket: string, fromSocket = 'out'): Op => ({
  type: 'connect',
  from: { node: from, socket: fromSocket },
  to: { node: to, socket },
});

/** Solver S1 whose body is `Math m1 { a ← PrevFrame p1, b ← SolverInput i1 }`. */
function oneSolver(): DagState {
  return apply(emptyDagState(), [
    node('p1', 'PrevFrame'),
    node('i1', 'SolverInput'),
    node('m1', 'Math', { op: 'add' }),
    wire('p1', 'm1', 'a'),
    wire('i1', 'm1', 'b'),
    node('s1', 'Solver'),
    wire('m1', 's1', 'body'),
  ]);
}

describe('#1547 — a sub-network has one owner', () => {
  it('the premise: the closure behind the body socket is the sub-network', () => {
    const s = oneSolver();
    expect([...subnetworkOf(s, 's1')].sort()).toEqual(['i1', 'm1', 'p1']);
    expect(subnetworkViolations(s)).toEqual([]);
  });

  it('refuses a node inside feeding a node outside', () => {
    const s = apply(oneSolver(), [node('outside', 'Clamp')]);
    expect(() => applyOp(s, wire('m1', 'outside', 'in'))).toThrow(
      /"m1" is inside the sub-network of Solver "s1"/,
    );
    // A leaf deeper inside is just as owned.
    expect(() => applyOp(s, wire('p1', 'outside', 'in'))).toThrow(/"p1" is inside/);
  });

  it('refuses sharing a sub-network node with a second Solver', () => {
    const s = apply(oneSolver(), [node('s2', 'Solver')]);
    expect(() => applyOp(s, wire('m1', 's2', 'body'))).toThrow(
      /"m1" is inside the sub-network of Solver "s1", so it can't also feed "s2"/,
    );
  });

  it('refuses pulling a node already used outside into a body', () => {
    const s = apply(emptyDagState(), [
      node('m', 'Math'),
      node('elsewhere', 'Clamp'),
      wire('m', 'elsewhere', 'in'),
      node('s', 'Solver'),
    ]);
    expect(() => applyOp(s, wire('m', 's', 'body'))).toThrow(
      /"m" is inside the sub-network of Solver "s", so it can't also feed "elsewhere"/,
    );
  });

  it('refuses the same through addNode carrying its own wires', () => {
    const s = oneSolver();
    const op = {
      type: 'addNode',
      nodeId: 'outside',
      nodeType: 'Clamp',
      params: {},
      inputs: { in: { node: 'm1', socket: 'out' } },
    } as Op;
    expect(() => applyOp(s, op)).toThrow(/addNode: "m1" is inside/);
  });

  it("the owner's own outputs leaving to the world are not edges out of its sub-network", () => {
    const s = apply(oneSolver(), [node('use', 'Clamp'), wire('s1', 'use', 'in')]);
    expect(subnetworkViolations(s)).toEqual([]);
  });

  it('allows one node feeding two body sockets of the SAME owner (a spring)', () => {
    const s = apply(emptyDagState(), [
      node('nv', 'Vec3Math', { op: 'add' }),
      node('np', 'Vec3Math', { op: 'add' }),
      wire('nv', 'np', 'b'),
      node('s', 'Solver'),
      wire('np', 's', 'bodies'),
      wire('nv', 's', 'bodies'),
    ]);
    expect(subnetworkViolations(s)).toEqual([]);
  });

  it('allows a sub-network nested inside another', () => {
    // An inner Solver s0 with body m0, read by a Mix that is the outer Solver's body.
    const s = apply(emptyDagState(), [
      node('m0', 'Math'),
      node('s0', 'Solver'),
      wire('m0', 's0', 'body'),
      node('p', 'PrevFrame'),
      node('mix', 'Mix'),
      wire('s0', 'mix', 'a'),
      wire('p', 'mix', 'b'),
      node('s', 'Solver'),
      wire('mix', 's', 'body'),
    ]);
    expect([...subnetworkOf(s, 's')].sort()).toEqual(['m0', 'mix', 'p', 's0']);
    expect([...subnetworkOf(s, 's0')]).toEqual(['m0']);
    expect(subnetworkViolations(s)).toEqual([]);
  });

  it('does not refuse an edit to a project that already broke the rule', () => {
    // A project saved before the rule: the violation is in the state, not in this op.
    const s = oneSolver();
    const broken: DagState = {
      ...s,
      nodes: {
        ...s.nodes,
        outside: {
          id: 'outside',
          type: 'Clamp',
          version: 1,
          params: { min: 0, max: 1 },
          inputs: { in: { node: 'm1', socket: 'out' } },
        },
      },
    };
    expect(subnetworkViolations(broken)).toHaveLength(1);
    // An unrelated edge still applies, and the old violation is still there after it.
    const next = apply(broken, [node('free', 'Math'), node('other', 'Clamp')]);
    const after = applyOp(next, wire('free', 'other', 'in')).next;
    expect(subnetworkViolations(after)).toHaveLength(1);
  });
});
