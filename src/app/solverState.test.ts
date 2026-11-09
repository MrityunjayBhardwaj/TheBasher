// #1826 / #1828 — a Solver's state: every type it carries is stepped together, frame by frame,
// and kept in one history per Solver.
import { describe, expect, it } from 'vitest';
import { applyOps } from '../core/dag/ops';
import { emptyDagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { evaluate } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { registerAllNodes } from '../nodes/registerAll';
import type { ParamDriverParams } from '../nodes/ParamDriver';
import { makeStatefulDriverChannelValue } from './statefulOps';

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
    expect(at(both, 10 / 24)).toMatchObject({ out: 25, outVec: [25, 25, 25] });
    expect(at(both, 20 / 24)).toMatchObject({ out: 50, outVec: [50, 50, 50] });
  });
});

// ── #1826 — rotation and transform state ─────────────────────────────────────

/** A constant Vector3 (x,y,z) under `id`, from three constant Fits. */
const vec3 = (id: string, v: readonly number[]): Op[] => [
  { type: 'addNode', nodeId: id, nodeType: 'MakeVec3', params: {} },
  ...(['x', 'y', 'z'] as const).flatMap((axis, i): Op[] => [
    {
      type: 'addNode',
      nodeId: `${id}_${axis}`,
      nodeType: 'Fit',
      params: { outMin: v[i], outMax: v[i] },
    },
    {
      type: 'connect',
      from: { node: `${id}_${axis}`, socket: 'out' },
      to: { node: id, socket: axis },
    },
  ]),
];

/** Rotation state: each frame closes half the way from the previous rotation to 90° about Y
 *  (Mix in Rotation mode). The seed is no rotation (no controller), so frame n reads
 *  90·(1 − 0.5ⁿ) degrees. */
const rotationState: Op[] = [
  ...vec3('aim', [0, 90, 0]),
  { type: 'addNode', nodeId: 'q90', nodeType: 'EulerToRotation', params: {} },
  { type: 'connect', from: { node: 'aim', socket: 'out' }, to: { node: 'q90', socket: 'euler' } },
  {
    type: 'addNode',
    nodeId: 'pr',
    nodeType: 'BodyInputRotation',
    params: { input: 'prevRotation', slot: 0 },
  },
  { type: 'addNode', nodeId: 'half', nodeType: 'Mix', params: { dataType: 'Rotation' } },
  {
    type: 'connect',
    from: { node: 'pr', socket: 'out' },
    to: { node: 'half', socket: 'aRotation' },
  },
  {
    type: 'connect',
    from: { node: 'q90', socket: 'out' },
    to: { node: 'half', socket: 'bRotation' },
  },
  {
    type: 'connect',
    from: { node: 'half', socket: 'outRotation' },
    to: { node: 's', socket: 'bodiesRotation' },
  },
];

/** Transform state: each frame applies one more step of (1,0,0), so frame n is at x = n. */
const transformState: Op[] = [
  ...vec3('dx', [1, 0, 0]),
  { type: 'addNode', nodeId: 'stepXf', nodeType: 'CombineTransform', params: {} },
  {
    type: 'connect',
    from: { node: 'dx', socket: 'out' },
    to: { node: 'stepXf', socket: 'translation' },
  },
  {
    type: 'addNode',
    nodeId: 'px',
    nodeType: 'BodyInputTransform',
    params: { input: 'prevTransform', slot: 0 },
  },
  { type: 'addNode', nodeId: 'moved', nodeType: 'MultiplyTransforms', params: {} },
  { type: 'connect', from: { node: 'stepXf', socket: 'out' }, to: { node: 'moved', socket: 'a' } },
  { type: 'connect', from: { node: 'px', socket: 'out' }, to: { node: 'moved', socket: 'b' } },
  {
    type: 'connect',
    from: { node: 'moved', socket: 'out' },
    to: { node: 's', socket: 'bodiesTransform' },
  },
];

type Full = { out: number; outVec: number[]; outRotation: number[]; outTransform: number[] };
const full = (state: DagState, frame: number) => at(state, frame / 60) as unknown as Full;
/** Degrees about Y of a rotation about Y only. */
const yDegrees = (q: number[]) => (2 * Math.atan2(q[1], q[3]) * 180) / Math.PI;

describe('#1826 — a Solver carries a rotation or a whole transform', () => {
  it('rotation state closes half the gap to 90° each frame', () => {
    const s = build(rotationState);
    for (const [frame, deg] of [
      [0, 0],
      [1, 45],
      [2, 67.5],
      [3, 78.75],
    ] as const) {
      expect(yDegrees(full(s, frame).outRotation)).toBeCloseTo(deg, 9);
    }
  });

  it('transform state moves one step along x each frame', () => {
    const s = build(transformState);
    expect(full(s, 0).outTransform[12]).toBe(0);
    expect(full(s, 7).outTransform[12]).toBeCloseTo(7, 12);
    expect(full(s, 7).outTransform.slice(13, 15)).toEqual([0, 0]);
  });

  it('every kind wired at once: each keeps its own state, read in any order', () => {
    const s = build(numberState, vectorState, rotationState, transformState);
    const late = full(s, 9);
    const early = full(s, 3);
    expect(early.out).toBe(3);
    expect(early.outVec).toEqual([3, 3, 3]);
    expect(yDegrees(early.outRotation)).toBeCloseTo(78.75, 9);
    expect(early.outTransform[12]).toBeCloseTo(3, 12);
    expect(late.out).toBe(9);
    expect(late.outTransform[12]).toBeCloseTo(9, 12);
  });

  it('CONTROL: unwired, the rotation and transform outputs read no rotation and the identity', () => {
    const s = build(numberState);
    const v = full(s, 5);
    expect(v.outRotation).toEqual([0, 0, 0, 1]);
    expect(v.outTransform).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });
});

describe('#1826 — a driver reading a Solver’s rotation drives a rotation as Euler degrees', () => {
  it('outRotation folds as degrees, the conversion a Quaternion→Vector3 wire makes', () => {
    const s = build(rotationState);
    const params = {
      target: 'n_box',
      paramPath: 'rotation',
      blendMode: 'replace',
      order: 0,
    } as unknown as ParamDriverParams;
    const solverNode = s.nodes.s;
    const rot = makeStatefulDriverChannelValue(s, params, solverNode, undefined, 'outRotation');
    const v = rot.sample(2 / 60) as number[];
    expect(v[0]).toBeCloseTo(0, 9);
    expect(v[1]).toBeCloseTo(67.5, 9);
    expect(v[2]).toBeCloseTo(0, 9);
  });
});

describe('#1826 — rotation and transform state start on the controller', () => {
  it('slot 0 seeds from the controller’s rotation and whole transform', () => {
    // A step that keeps what it had, so the value at any frame is the seed.
    const s = applyOps(buildDefaultDagState(), [
      {
        type: 'addNode',
        nodeId: 'ctl',
        nodeType: 'Null',
        params: { position: [1, 2, 3], rotation: [0, 90, 0], scale: [1, 1, 1] },
      },
      {
        type: 'connect',
        from: { node: 'ctl', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
      {
        type: 'addNode',
        nodeId: 's',
        nodeType: 'Solver',
        params: { sourceTransformVec: { node: 'ctl' } },
      },
      {
        type: 'addNode',
        nodeId: 'pr',
        nodeType: 'BodyInputRotation',
        params: { input: 'prevRotation', slot: 0 },
      },
      {
        type: 'connect',
        from: { node: 'pr', socket: 'out' },
        to: { node: 's', socket: 'bodiesRotation' },
      },
      {
        type: 'addNode',
        nodeId: 'px',
        nodeType: 'BodyInputTransform',
        params: { input: 'prevTransform', slot: 0 },
      },
      {
        type: 'connect',
        from: { node: 'px', socket: 'out' },
        to: { node: 's', socket: 'bodiesTransform' },
      },
    ]).next;
    const v = full(s, 4);
    expect(yDegrees(v.outRotation)).toBeCloseTo(90, 9);
    expect(v.outTransform.slice(12, 15).map((x) => +x.toFixed(9))).toEqual([1, 2, 3]);
    // The rotated basis: x maps to -z for 90° about Y.
    expect(v.outTransform[2]).toBeCloseTo(-1, 9);
  });

  it('CONTROL: without a controller they start on no rotation and the identity', () => {
    const s = build(rotationState);
    expect(full(s, 0).outRotation).toEqual([0, 0, 0, 1]);
  });
});
