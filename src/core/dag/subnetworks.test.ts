// #1547 — a sub-network has one owner: nothing inside a Solver's body closure may feed
// anything outside it except that Solver's body sockets.
import { beforeEach, describe, expect, it } from 'vitest';
import { registerAllNodes } from '../../nodes/registerAll';
import { __resetRegistryForTests, applyOp, applyOps } from './index';
import type { DagState } from './state';
import { emptyDagState } from './state';
import {
  bindBodyInputs,
  bodyInputChoicesOf,
  bodyInputLeavesOf,
  bodyInputOwnerOf,
  subnetworkOf,
  subnetworkViolations,
} from './subnetworks';
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

/** Solver S1 whose body is `Math m1 { a ← prev p1, b ← input i1 }`. */
function oneSolver(): DagState {
  return apply(emptyDagState(), [
    node('p1', 'BodyInput', { input: 'prev' }),
    node('i1', 'BodyInput', { input: 'input' }),
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
      node('p', 'BodyInput', { input: 'prev' }),
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

describe('#1623 — a batch is judged on the graph it ends in', () => {
  // The undo of deleting m1: m1 comes back reading p1 and i1 before the wire into s1's body
  // that puts it back inside. For that one operation p1 and i1 feed a node outside.
  const deleted = () => {
    const s = oneSolver();
    return apply(s, [
      {
        type: 'disconnect',
        from: { node: 'm1', socket: 'out' },
        to: { node: 's1', socket: 'body' },
      } as Op,
      { type: 'removeNode', nodeId: 'm1' },
    ]);
  };
  const restore: Op[] = [
    {
      type: 'addNode',
      nodeId: 'm1',
      nodeType: 'Math',
      params: { op: 'add' },
      inputs: { a: { node: 'p1', socket: 'out' }, b: { node: 'i1', socket: 'out' } },
    } as Op,
    wire('m1', 's1', 'body'),
  ];

  it('CONTROL: the first operation alone is refused, as before', () => {
    // After the delete p1 and i1 are in no sub-network; put one back inside first.
    const s = apply(deleted(), [
      node('m0', 'Math'),
      wire('p1', 'm0', 'a'),
      wire('m0', 's1', 'body'),
    ]);
    expect(() => applyOp(s, restore[0])).toThrow(/addNode: "p1" is inside the sub-network/);
  });

  it('a batch that passes through a broken graph and ends whole is accepted', () => {
    const s = apply(deleted(), [
      node('m0', 'Math'),
      wire('p1', 'm0', 'a'),
      wire('m0', 's1', 'body'),
    ]);
    const { next } = applyOps(s, [
      restore[0], // p1 is inside s1 through m0, and now also feeds m1, outside: broken
      {
        type: 'disconnect',
        from: { node: 'm0', socket: 'out' },
        to: { node: 's1', socket: 'body' },
      } as Op,
      restore[1], // m1 inside, but m0 is now outside and still reads p1: still broken
      { type: 'removeNode', nodeId: 'm0' }, // whole again
    ]);
    expect(subnetworkViolations(next)).toEqual([]);
    expect([...subnetworkOf(next, 's1')].sort()).toEqual(['i1', 'm1', 'p1']);
  });

  it('a batch that ends with a node in two sub-networks is still refused', () => {
    const s = apply(oneSolver(), [node('s2', 'Solver')]);
    expect(() =>
      applyOps(s, [node('x', 'Clamp'), wire('m1', 's2', 'body'), wire('m1', 'x', 'in')]),
    ).toThrow(
      /^connect: "m1" is inside the sub-network of Solver "s1", so it can't also feed "s2"/,
    );
  });

  it('a refused batch leaves the graph it was given untouched', () => {
    const s = apply(oneSolver(), [node('s2', 'Solver')]);
    const before = structuredClone(s.nodes);
    expect(() => applyOps(s, [wire('m1', 's2', 'body')])).toThrow(/inside the sub-network/);
    expect(s.nodes).toEqual(before);
  });

  it('only what the batch introduced is refused: a project that already broke the rule still edits', () => {
    const broken = apply(oneSolver(), [node('s2', 'Solver')]);
    const s = {
      ...broken,
      nodes: {
        ...broken.nodes,
        s2: { ...broken.nodes.s2, inputs: { body: { node: 'm1', socket: 'out' } } },
      },
    };
    expect(subnetworkViolations(s).length).toBeGreaterThan(0);
    expect(() => applyOps(s, [node('m9', 'Math'), wire('m9', 'm1', 'a')])).not.toThrow();
  });
});

describe("#1548 — a sub-network reads its owner's inputs by name", () => {
  it('finds the leaves reading a declared input, with their slot', () => {
    const leaves = bodyInputLeavesOf(oneSolver(), 's1');
    expect(leaves.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'i1', input: 'input', slot: 0 },
      { id: 'p1', input: 'prev', slot: 0 },
    ]);
  });

  it('leaves out a name the owner does not declare, and a leaf of the wrong type', () => {
    const s = apply(emptyDagState(), [
      node('typo', 'BodyInput', { input: 'prevv' }),
      node('vec', 'BodyInputVec', { input: 'prev' }), // `prev` is a Number input
      node('m', 'Math', { op: 'add' }),
      wire('typo', 'm', 'a'),
      node('br', 'VecBreak3'),
      wire('vec', 'br', 'v'),
      node('m2', 'Math', { op: 'add' }),
      wire('m', 'm2', 'a'),
      wire('br', 'm2', 'b', 'x'),
      node('s', 'Solver'),
      wire('m2', 's', 'body'),
    ]);
    expect(bodyInputLeavesOf(s, 's')).toEqual([]);
  });

  it("leaves a nested owner's leaves to that owner", () => {
    const s = apply(emptyDagState(), [
      node('inner', 'BodyInput', { input: 'prev' }),
      node('s0', 'Solver'),
      wire('inner', 's0', 'body'),
      node('outer', 'BodyInput', { input: 'prev' }),
      node('mix', 'Mix'),
      wire('s0', 'mix', 'a'),
      wire('outer', 'mix', 'b'),
      node('s', 'Solver'),
      wire('mix', 's', 'body'),
    ]);
    expect(bodyInputLeavesOf(s, 's').map((l) => l.id)).toEqual(['outer']);
    expect(bodyInputLeavesOf(s, 's0').map((l) => l.id)).toEqual(['inner']);
  });

  it('binds a single input whole and a list input by slot; anything unbound reads its default', () => {
    const s = apply(emptyDagState(), [
      node('in', 'BodyInputVec', { input: 'inputVec' }),
      node('p0', 'BodyInputVec', { input: 'prevVec', slot: 0 }),
      node('p1', 'BodyInputVec', { input: 'prevVec', slot: 1 }),
      node('p5', 'BodyInputVec', { input: 'prevVec', slot: 5 }),
      node('a', 'Vec3Math', { op: 'add' }),
      wire('in', 'a', 'a'),
      wire('p0', 'a', 'b'),
      node('b', 'Vec3Math', { op: 'add' }),
      wire('p1', 'b', 'a'),
      wire('p5', 'b', 'b'),
      node('s', 'Solver'),
      wire('a', 's', 'bodies'),
      wire('b', 's', 'bodies'),
    ]);
    const leaves = bodyInputLeavesOf(s, 's');
    const bound = bindBodyInputs(s, 's', leaves, {
      inputVec: [9, 9, 9],
      prevVec: [
        [1, 0, 0],
        [0, 1, 0],
      ],
    });
    expect(Object.fromEntries(bound)).toEqual({
      in: [9, 9, 9],
      p0: [1, 0, 0],
      p1: [0, 1, 0],
    });
    // Slot 5 is past the end of a two-element list: unbound, so the leaf reads its default.
    expect(bound.has('p5')).toBe(false);
    expect(bindBodyInputs(s, 's', leaves, {}).size).toBe(0);
  });
});

describe('#1569 — a leaf is offered the inputs its owner declares, and told when it has none', () => {
  /** The typo, the wrong-type leaf, a nested owner and a stray leaf, in one graph. */
  function mixed(): DagState {
    return apply(emptyDagState(), [
      node('typo', 'BodyInput', { input: 'prve' }),
      node('vec', 'BodyInputVec', { input: 'prev' }), // `prev` is a Number input
      node('br', 'VecBreak3'),
      wire('vec', 'br', 'v'),
      node('inner', 'BodyInput', { input: 'prev' }),
      node('s0', 'Solver'),
      wire('inner', 's0', 'body'),
      node('m', 'Math', { op: 'add' }),
      wire('typo', 'm', 'a'),
      wire('br', 'm', 'b', 'x'),
      node('mix', 'Mix'),
      wire('m', 'mix', 'a'),
      wire('s0', 'mix', 'b'),
      node('s', 'Solver'),
      wire('mix', 's', 'body'),
      node('stray', 'BodyInput', { input: 'prev' }),
    ]);
  }

  it('names the owner, and the inputs it declares for the leaf’s own type', () => {
    const s = mixed();
    expect(bodyInputChoicesOf(s, 'typo')).toEqual({ owners: ['s'], names: ['prev', 'input'] });
    expect(bodyInputChoicesOf(s, 'vec')).toEqual({ owners: ['s'], names: ['prevVec', 'inputVec'] });
  });

  it('a leaf inside a nested owner reads that owner, not the one around it', () => {
    // #1645 — both hold it, nearest first; the nearest one that declares its name binds it.
    expect(bodyInputChoicesOf(mixed(), 'inner').owners).toEqual(['s0', 's']);
    expect(bodyInputOwnerOf(mixed(), 'inner')).toBe('s0');
  });

  it('a leaf in no sub-network has no owner and no choices', () => {
    expect(bodyInputChoicesOf(mixed(), 'stray')).toEqual({ owners: [], names: [] });
    expect(bodyInputChoicesOf(mixed(), 'no_such_node')).toEqual({ owners: [], names: [] });
  });

  it('every offered name binds the leaf once written, and no other name does', () => {
    // Through the function the cook reads (`bodyInputLeavesOf`), both ways: an offered name
    // that binds nothing is a picker that lies; a binding name left out cannot be picked.
    const s = mixed();
    let offered = 0;
    for (const leaf of ['typo', 'vec', 'inner']) {
      const { owners, names } = bodyInputChoicesOf(s, leaf);
      const everyName = ['prev', 'input', 'prevVec', 'inputVec', 'prve', 'nope'];
      for (const name of everyName) {
        const written = apply(s, [
          { type: 'setParam', nodeId: leaf, paramPath: 'input', value: name },
        ]);
        const bound = owners.some((o) => bodyInputLeavesOf(written, o).some((l) => l.id === leaf));
        expect({ leaf, name, bound }).toEqual({ leaf, name, bound: names.includes(name) });
        if (names.includes(name)) offered++;
      }
    }
    expect(offered).toBe(6);
  });
});
