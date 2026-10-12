// #1583 — adding a wire does not read the whole graph to ask the sub-network rules.
//
// Every wire used to re-check both rules over every node, twice. An import of a 5,019-node file
// spent 6.4 s of its 14.3 s there, on a graph with no Solver or Rig in it.
//
// Cost is pinned by COUNTING, not by a clock: how many times a node's type is looked up while
// one wire is applied. The rules find the owners by looking up every node's type, so a count
// that grows with the graph is the walk coming back. And the shortcut is pinned against the
// rules it skips: over random graphs, every operation gets the answer the full check gives.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const lookups = { count: 0 };
vi.mock('./registry', async (original) => {
  const real = await original<typeof import('./registry')>();
  return {
    ...real,
    getNodeType: (type: string) => {
      lookups.count++;
      return real.getNodeType(type);
    },
  };
});

import { registerAllNodes } from '../../nodes/registerAll';
import { __resetRegistryForTests, applyOp } from './index';
import type { DagState } from './state';
import { emptyDagState } from './state';
import {
  newStatefulLeafRead,
  newSubnetworkViolation,
  reachesSubnetwork,
  subnetworkOwnersOf,
} from './subnetworks';
import type { Op } from './types';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

type AddNode = Extract<Op, { type: 'addNode' }>;
type Connect = Extract<Op, { type: 'connect' }>;
const node = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}): AddNode => ({
  type: 'addNode',
  nodeId,
  nodeType,
  params,
});
const wire = (from: string, to: string, socket: string): Connect => ({
  type: 'connect',
  from: { node: from, socket: 'out' },
  to: { node: to, socket },
});
const apply = (state: DagState, ops: readonly Op[]): DagState =>
  ops.reduce((s, op) => applyOp(s, op).next, state);

/** `count` Math nodes wired in pairs, nothing to do with any sub-network. */
function unrelated(state: DagState, count: number): DagState {
  const ops: Op[] = [];
  for (let i = 0; i < count; i++) ops.push(node(`u${i}`, 'Math'));
  for (let i = 1; i < count; i += 2) ops.push(wire(`u${i - 1}`, `u${i}`, 'a'));
  return apply(state, ops);
}

/** A Solver over `Math { a ← prev, b ← input }`. */
const SOLVER: readonly Op[] = [
  node('p1', 'BodyInput', { input: 'prev' }),
  node('i1', 'BodyInput', { input: 'input' }),
  node('m1', 'Math', { op: 'add' }),
  wire('p1', 'm1', 'a'),
  wire('i1', 'm1', 'b'),
  node('s1', 'Solver'),
  wire('m1', 's1', 'body'),
];

/** Type lookups made while `op` is applied to `state`. */
function lookupsFor(state: DagState, op: Op): number {
  lookups.count = 0;
  applyOp(state, op);
  return lookups.count;
}

/** The graph as a project just loaded holds it: nothing known about it yet. */
const fresh = (state: DagState): DagState => ({ ...state, nodes: { ...state.nodes } });

describe('#1583 — the cost of a wire does not grow with the graph', () => {
  it('the instrument: asking a graph nobody has asked before looks up every node', () => {
    const small = fresh(unrelated(emptyDagState(), 100));
    const large = fresh(unrelated(emptyDagState(), 2000));
    const op = wire('u0', 'u3', 'b');
    expect(lookupsFor(large, op) - lookupsFor(small, op)).toBe(1900);
  });

  it('a wire in a graph with no sub-network: the same count at 100 nodes and at 2,000', () => {
    const op = wire('u0', 'u3', 'b');
    const small = lookupsFor(unrelated(emptyDagState(), 100), op);
    const large = lookupsFor(unrelated(emptyDagState(), 2000), op);
    expect(large).toBe(small);
  });

  it('a node added with a wire: the same count at 100 nodes and at 2,000', () => {
    const op: AddNode = { ...node('late', 'Math'), inputs: { a: { node: 'u0', socket: 'out' } } };
    const small = lookupsFor(unrelated(emptyDagState(), 100), op);
    const large = lookupsFor(unrelated(emptyDagState(), 2000), op);
    expect(large).toBe(small);
  });

  it('a wire away from a Solver that is in the graph: the same count at 100 and 2,000', () => {
    const op = wire('u0', 'u3', 'b');
    const small = lookupsFor(unrelated(apply(emptyDagState(), SOLVER), 100), op);
    const large = lookupsFor(unrelated(apply(emptyDagState(), SOLVER), 2000), op);
    expect(large).toBe(small);
  });

  it('the owners follow the graph through every kind of operation in between', () => {
    let state = unrelated(apply(emptyDagState(), SOLVER), 50);
    const steps: Op[] = [
      { type: 'setMeta', nodeId: 'u0', name: 'renamed' },
      { type: 'setParam', nodeId: 'u1', paramPath: 'op', value: 'mul' },
      { type: 'disconnect', from: { node: 'u0', socket: 'out' }, to: { node: 'u1', socket: 'a' } },
      node('r1', 'Rig'),
      node('gone', 'Solver'),
      { type: 'removeNode', nodeId: 'gone' },
      { type: 'removeNode', nodeId: 'u49' },
    ];
    for (const op of steps) {
      state = applyOp(state, op).next;
      lookups.count = 0;
      const carried = subnetworkOwnersOf(state);
      expect(lookups.count, `${op.type} lost the owners`).toBe(0);
      expect([...carried].sort()).toEqual([...subnetworkOwnersOf(fresh(state))].sort());
    }
    expect([...subnetworkOwnersOf(state)].sort()).toEqual(['r1', 's1']);
  });

  it('a type registered later is seen: what was known under the old definitions is dropped', () => {
    const state = unrelated(emptyDagState(), 4);
    expect(subnetworkOwnersOf(state)).toEqual([]);
    __resetRegistryForTests();
    registerAllNodes();
    lookups.count = 0;
    subnetworkOwnersOf(state);
    expect(lookups.count).toBe(4);
  });
});

// ── the shortcut gives the answer the full check gives ──────────────────────────

/** A small deterministic generator, so a failure names a seed that reproduces it. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NUMBER_SOCKETS: Readonly<Record<string, readonly string[]>> = {
  Math: ['a', 'b'],
  Lag: ['in'],
  Solver: ['body'],
};
const TYPES = ['Math', 'Math', 'Math', 'BodyInput', 'Lag', 'Solver'] as const;
const LEAF_NAMES = ['prev', 'input', 'other'] as const;

/** What the two rules say of `before → after` asked in full, of graphs nothing is known about. */
function fullAnswer(before: DagState, after: DagState): string | null {
  const b = fresh(before);
  const a = fresh(after);
  return newSubnetworkViolation(b, a) ?? newStatefulLeafRead(b, a);
}

interface Step {
  readonly before: DagState;
  /** The graph after, or null when the operation was refused. */
  readonly after: DagState | null;
  readonly op: Op;
  readonly refused: string | null;
}

/** 90 random operations on each of `graphs` graphs: nodes (some with a wire), wires, and a
 *  leaf renamed. An operation refused for another reason (a loop) is a step like any other. */
function walk(graphs: number, visit: (step: Step, seed: number) => void): void {
  for (let seed = 1; seed <= graphs; seed++) {
    const next = rng(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
    let state = emptyDagState();
    const ids: string[] = [];
    // Every other graph starts one wire short of the second rule: a Lag inside a Solver, and
    // that Solver's leaf beside it. Left to chance the first rule refuses nearly everything.
    if (seed % 2 === 0) {
      state = apply(state, [
        node('leaf', 'BodyInput', { input: 'prev' }),
        node('lag', 'Lag'),
        node('mix', 'Math'),
        wire('lag', 'mix', 'a'),
        wire('leaf', 'mix', 'b'),
        node('solver', 'Solver'),
        wire('mix', 'solver', 'body'),
      ]);
      ids.push('leaf', 'lag', 'mix', 'solver');
    }
    for (let step = 0; step < 90; step++) {
      let op: Op;
      const roll = next();
      if (ids.length < 4 || roll < 0.3) {
        const type = pick(TYPES);
        const added = node(
          `n${seed}_${step}`,
          type,
          type === 'BodyInput' ? { input: pick(LEAF_NAMES) } : {},
        );
        const wired = ids.length > 0 && type !== 'BodyInput' && next() < 0.4;
        op = wired
          ? {
              ...added,
              inputs: { [pick(NUMBER_SOCKETS[type])]: { node: pick(ids), socket: 'out' } },
            }
          : added;
      } else if (roll < 0.9) {
        const to = pick(ids);
        const sockets = NUMBER_SOCKETS[state.nodes[to].type];
        if (!sockets) continue;
        op = wire(pick(ids), to, pick(sockets));
      } else {
        const leaves = ids.filter((id) => state.nodes[id].type === 'BodyInput');
        if (leaves.length === 0) continue;
        op = {
          type: 'setParam',
          nodeId: pick(leaves),
          paramPath: 'input',
          value: pick(LEAF_NAMES),
        };
      }
      let after: DagState | null = null;
      let refused: string | null = null;
      try {
        after = applyOp(state, op).next;
      } catch (e) {
        refused = (e as Error).message;
      }
      visit({ before: state, after, op, refused }, seed);
      if (after) {
        if (op.type === 'addNode') ids.push(op.nodeId);
        state = after;
      }
    }
  }
}

describe('#1583 — a wire that is not asked could not have been refused', () => {
  it('the generator reaches both rules, and wires on both sides of the shortcut', () => {
    // Without this the comparison below could pass by never coming near a refusal.
    const seen = { owner: 0, leafRead: 0, asked: 0, skipped: 0 };
    walk(60, ({ after, op, refused }) => {
      if (refused?.includes('belongs to one sub-network')) seen.owner++;
      if (refused?.includes('keeps a history of its own')) seen.leafRead++;
      if (!after || op.type !== 'connect') return;
      if (reachesSubnetwork(after, [op.from.node])) seen.asked++;
      else seen.skipped++;
    });
    expect(seen.owner).toBeGreaterThan(20);
    expect(seen.leafRead).toBeGreaterThan(20);
    expect(seen.asked).toBeGreaterThan(100);
    expect(seen.skipped).toBeGreaterThan(100);
  });

  it('every operation applied over 60 random graphs is one the full check allows', () => {
    // The shortcut can only be wrong one way: by letting through what the rules refuse.
    let applied = 0;
    walk(60, ({ before, after, op }, seed) => {
      if (!after) return;
      expect(fullAnswer(before, after), `seed ${seed}: ${JSON.stringify(op)}`).toBeNull();
      applied++;
    });
    expect(applied).toBeGreaterThan(1500);
  });
});
