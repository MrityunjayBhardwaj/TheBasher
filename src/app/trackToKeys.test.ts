// #1767 — a Track-To's settings honour keys like any param: its aim point, up and roll fold their
// channels on every road that resolves it. Measured before the fix: the default box with its
// Track-To's aim point keyed from (0, 0, -10) to (10, 0, 0) still read [0, 0, 0] at 1 s.

import { beforeAll, describe, expect, it } from 'vitest';
import { buildDefaultDagState } from '../core/project/default';
import { type DagState } from '../core/dag';
import { applyOp } from '../test-utils/committedApplyOp';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitCamera } from '../test-utils/splitCamera';
import { resolveConstraintRotation } from './nodeConstraints';
import { resolveActiveCameraPoseAt } from './activeCamera';

beforeAll(() => registerAllNodes());

const ctx = (t: number) => ({ time: { frame: t * 60, seconds: t, normalized: 0 } });
const run = (s: DagState, ops: object[]) => {
  for (const op of ops) s = applyOp(s, op as never).next;
  return s;
};
const keys = (a: unknown, b: unknown) => [
  { time: 0, value: a, easing: 'linear' },
  { time: 1, value: b, easing: 'linear' },
];
const rot = (s: DagState, t: number) =>
  resolveConstraintRotation(s, 'n_box', ctx(t))!.map((v) => Math.round(v * 1000) / 1000 + 0);

const boxTracked = (extra: object[]) =>
  run(buildDefaultDagState(), [
    {
      type: 'addNode',
      nodeId: 'tt',
      nodeType: 'TrackTo',
      params: { target: 'n_box', aimPoint: [0, 0, -10] },
    },
    ...extra,
  ]);

describe('#1767 — a Track-To’s keys are honoured', () => {
  it('a keyed aim point turns the object', () => {
    const s = boxTracked([
      {
        type: 'addNode',
        nodeId: 'ch',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'aimPoint',
          target: 'tt',
          paramPath: 'aimPoint',
          keyframes: keys([0, 0, -10], [10, 0, 0]),
        },
      },
    ]);
    expect(rot(s, 0)).toEqual([0, 0, 0]);
    expect(rot(s, 1)).toEqual([0, -90, 0]);
  });

  it('a keyed roll rolls it', () => {
    const s = boxTracked([
      {
        type: 'addNode',
        nodeId: 'ch',
        nodeType: 'KeyframeChannelNumber',
        params: { name: 'roll', target: 'tt', paramPath: 'roll', keyframes: keys(0, 40) },
      },
    ]);
    expect(rot(s, 0)).toEqual([0, 0, 0]);
    // Aiming down -Z, a roll about the aim axis is a turn about Z.
    expect(Math.abs(rot(s, 1)[2])).toBeCloseTo(40, 3);
  });

  it('a keyed up vector tilts the roll reference', () => {
    const s = boxTracked([
      {
        type: 'addNode',
        nodeId: 'ch',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'up',
          target: 'tt',
          paramPath: 'up',
          keyframes: keys([0, 1, 0], [1, 0, 0]),
        },
      },
    ]);
    expect(rot(s, 0)).toEqual([0, 0, 0]);
    expect(Math.abs(rot(s, 1)[2])).toBeCloseTo(90, 3);
  });

  it('a camera aimed by a Track-To follows its keyed aim point, and its keyed roll', () => {
    let s = makeSplitCamera(buildDefaultDagState(), {
      objectId: 'cam',
      position: [0, 0, 5],
      lens: { lookAt: [0, 0, 0] },
    }).state;
    s = run(s, [
      {
        type: 'connect',
        from: { node: 'cam', socket: 'out' },
        to: { node: 'n_scene', socket: 'camera' },
        replace: true,
      },
      {
        type: 'addNode',
        nodeId: 'tt',
        nodeType: 'TrackTo',
        params: { target: 'cam', aimPoint: [0, 0, 0] },
      },
      {
        type: 'addNode',
        nodeId: 'ch',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'aimPoint',
          target: 'tt',
          paramPath: 'aimPoint',
          keyframes: keys([0, 0, 0], [4, 0, 5]),
        },
      },
      {
        type: 'addNode',
        nodeId: 'chr',
        nodeType: 'KeyframeChannelNumber',
        params: { name: 'roll', target: 'tt', paramPath: 'roll', keyframes: keys(0, 15) },
      },
    ]);
    expect(resolveActiveCameraPoseAt(s, 0).lookAt).toEqual([0, 0, 0]);
    const at1 = resolveActiveCameraPoseAt(s, 1);
    at1.lookAt.forEach((v, i) => expect(v).toBeCloseTo([4, 0, 5][i], 6));
    expect(at1.roll).toBeCloseTo(15, 6);
  });
});
