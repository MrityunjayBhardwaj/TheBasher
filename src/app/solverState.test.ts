// #1826 / #1828 — a Solver's state: every type it carries is stepped together, frame by frame,
// and kept in one history per Solver.
import { describe, expect, it } from 'vitest';
import { applyOps } from '../core/dag/ops';
import { emptyDagState } from '../core/dag/state';
import { evaluate } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { registerAllNodes } from '../nodes/registerAll';

registerAllNodes();

const at = (state: DagState, seconds: number) =>
  evaluate(state, 's', {
    ctx: { time: { frame: Math.round(seconds * 24), seconds, normalized: 0 } },
  }).value as { out: number; outVec: number[] };

const solver: Op = { type: 'addNode', nodeId: 's', nodeType: 'Solver', params: {} };
const one: Op = {
  type: 'addNode',
  nodeId: 'one',
  nodeType: 'Fit',
  params: { outMin: 1, outMax: 1 },
};

/** Number state: prev + 1 each frame. */
const numberState: Op[] = [
  { type: 'addNode', nodeId: 'p', nodeType: 'BodyInput', params: { input: 'prev' } },
  { type: 'addNode', nodeId: 'inc', nodeType: 'Math', params: { op: 'add' } },
  { type: 'connect', from: { node: 'p', socket: 'out' }, to: { node: 'inc', socket: 'a' } },
  { type: 'connect', from: { node: 'one', socket: 'out' }, to: { node: 'inc', socket: 'b' } },
  { type: 'connect', from: { node: 'inc', socket: 'out' }, to: { node: 's', socket: 'body' } },
];

/** Vector state: prevVec[0] + (1,1,1) each frame (a Number arriving at a Vector3 fills every axis). */
const vectorState: Op[] = [
  {
    type: 'addNode',
    nodeId: 'pv',
    nodeType: 'BodyInputVec',
    params: { input: 'prevVec', slot: 0 },
  },
  { type: 'addNode', nodeId: 'incv', nodeType: 'Vec3Math', params: { op: 'add' } },
  { type: 'connect', from: { node: 'pv', socket: 'out' }, to: { node: 'incv', socket: 'a' } },
  { type: 'connect', from: { node: 'one', socket: 'out' }, to: { node: 'incv', socket: 'b' } },
  { type: 'connect', from: { node: 'incv', socket: 'out' }, to: { node: 's', socket: 'bodies' } },
];

const build = (...parts: Op[][]) => applyOps(emptyDagState(), [solver, one, ...parts.flat()]).next;

describe('#1828 — a Solver carrying a number and a vector steps both', () => {
  // 10/24 s is replay frame 25 (the replay counts frames at its own rate).
  it('CONTROL: each alone counts up', () => {
    expect(at(build(numberState), 10 / 24).out).toBe(25);
    expect(at(build(vectorState), 10 / 24).outVec).toEqual([25, 25, 25]);
  });

  it('both wired, each keeps its own count, asked in either order', () => {
    const both = build(numberState, vectorState);
    expect(at(both, 10 / 24)).toEqual({ out: 25, outVec: [25, 25, 25] });
    expect(at(both, 20 / 24)).toEqual({ out: 50, outVec: [50, 50, 50] });
  });
});
