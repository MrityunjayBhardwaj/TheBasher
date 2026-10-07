// #1581 — a loop is a loop however many nodes it runs through.
//
// The walk that asks "would this wire close a loop?" stopped 32 nodes from where it started, so
// a loop through 34 or more was not seen: `connect` applied the wire and the evaluator threw
// `cycle detected` on the next read. Three doors ask that question (`connect`, binding a driver,
// building a spring) and each is run here against loops of several lengths, with a chain of the
// same length that closes nothing as the control.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import { requireNodeType } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';
import { emptyDagState, wouldCreateCycle } from '../core/dag/state';
import type { Node, Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { buildBindDriverOps, type DriverSource } from './driverBind';
import { buildSpringOps } from './solverBind';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

// For `connect`, 33 was the longest loop the old walk could see and 34 the shortest it could
// not. The two bind doors gave up a hop or two earlier.
const LENGTHS = [5, 33, 34, 200, 1000];

const apply = (state: DagState, ops: readonly Op[]): DagState =>
  ops.reduce((s, op) => applyOp(s, op).next, state);

/** `count` nodes of `nodeType`, each reading the one before it through `socket`. */
function chain(prefix: string, nodeType: string, socket: string, count: number): Op[] {
  const params = requireNodeType(nodeType).paramSchema.parse({});
  const ops: Op[] = [];
  for (let i = 0; i < count; i++) {
    ops.push({ type: 'addNode', nodeId: `${prefix}${i}`, nodeType, params });
    if (i > 0) {
      ops.push({
        type: 'connect',
        from: { node: `${prefix}${i - 1}`, socket: 'out' },
        to: { node: `${prefix}${i}`, socket },
      });
    }
  }
  return ops;
}

const outSource = (node: string): DriverSource => ({
  kind: 'output',
  id: `out:${node}:out`,
  label: node,
  ref: { node, socket: 'out' },
});

describe('#1581 — connect refuses a wire that closes a loop of any length', () => {
  for (const length of LENGTHS) {
    it(`through ${length} nodes`, () => {
      const state = apply(emptyDagState(), chain('m', 'Math', 'a', length));
      const closing: Op = {
        type: 'connect',
        from: { node: `m${length - 1}`, socket: 'out' },
        to: { node: 'm0', socket: 'a' },
      };
      expect(() => applyOp(state, closing)).toThrow(
        `connect: would create a cycle (m${length - 1} → m0)`,
      );
      // Control: the same wire into a node that is not on the chain closes nothing.
      const aside = apply(state, [
        { type: 'addNode', nodeId: 'aside', nodeType: 'Math', params: state.nodes.m0.params },
      ]);
      expect(() =>
        applyOp(aside, { ...closing, to: { node: 'aside', socket: 'a' } }),
      ).not.toThrow();
    });
  }
});

describe('#1581 — binding a driver refuses a loop of any length', () => {
  for (const length of LENGTHS) {
    it(`through ${length} nodes`, () => {
      // c0 → c1 → … → c(length-1), wired. Driving c0 from the last one closes the loop.
      const state = apply(buildDefaultDagState(), chain('c', 'Clamp', 'in', length));
      const closing = buildBindDriverOps(state, {
        targetId: 'c0',
        paramPath: 'min',
        source: outSource(`c${length - 1}`),
        driverId: 'drv',
      });
      expect(closing).toEqual({ ok: false, reason: 'binding would create a driver cycle' });
      // Control: the other direction is a driver reading upstream, which closes nothing.
      const open = buildBindDriverOps(state, {
        targetId: `c${length - 1}`,
        paramPath: 'min',
        source: outSource('c0'),
        driverId: 'drv',
      });
      expect(open.ok).toBe(true);
    });
  }
});

describe('#1581 — building a spring refuses a loop of any length', () => {
  /** `count` Nulls; each one's position is driven by the one before, the first by `from`. */
  function drivenNulls(from: string, count: number): Op[] {
    const params = requireNodeType('Null').paramSchema.parse({});
    const ops: Op[] = [];
    for (let i = 0; i < count; i++) {
      ops.push({ type: 'addNode', nodeId: `ctl${i}`, nodeType: 'Null', params });
      ops.push({
        type: 'addNode',
        nodeId: `follow${i}`,
        nodeType: 'ParamDriver',
        params: {
          target: `ctl${i}`,
          paramPath: 'position',
          blendMode: 'replace',
          order: 0,
          sourceTransformVec: { node: i === 0 ? from : `ctl${i - 1}` },
        },
      });
    }
    return ops;
  }

  for (const length of LENGTHS) {
    it(`through ${length} nodes`, () => {
      const base = buildDefaultDagState();
      // The box drives ctl0, which drives ctl1, … A spring from the last back onto the box
      // closes the loop.
      const looped = apply(base, drivenNulls('n_box', length - 1));
      const controllerId = length > 1 ? `ctl${length - 2}` : 'n_box';
      expect(
        buildSpringOps(looped, {
          targetId: 'n_box',
          controllerId,
          idFor: (key) => `sp_${key}`,
        }),
      ).toEqual({ ok: false, reason: 'spring would create a driver cycle' });
      // Control: the same chain hanging off a Null of its own leaves the box free to follow.
      const free = apply(base, [
        { type: 'addNode', nodeId: 'root', nodeType: 'Null', params: looped.nodes.ctl0.params },
        ...drivenNulls('root', length - 1),
      ]);
      expect(
        buildSpringOps(free, { targetId: 'n_box', controllerId, idFor: (key) => `sp_${key}` }).ok,
      ).toBe(true);
    });
  }
});

describe('#1581 — the walk itself', () => {
  it('ends on a chain of 20,000 nodes without a depth to stop at', () => {
    const nodes: Record<string, Node> = {};
    for (let i = 0; i < 20_000; i++) {
      nodes[`n${i}`] = {
        id: `n${i}`,
        type: 'Math',
        version: 1,
        params: {},
        inputs: i > 0 ? { a: { node: `n${i - 1}`, socket: 'out' } } : {},
      };
    }
    const state: DagState = { ...emptyDagState(), nodes };
    expect(wouldCreateCycle(state, 'n19999', 'n0')).toBe(true);
    expect(wouldCreateCycle(state, 'n0', 'n19999')).toBe(false);
  });
});
