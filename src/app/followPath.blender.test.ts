// #1791 / #1783 — Follow Path against Blender 5.1.1's own numbers, for every fixture row inside
// what Basher's Follow Path does today: Follow Curve off, a fixed position (`offset_factor`, Basher's
// `evalTime`), no curve radius, one constraint. Values copied from the fixture
// `ref/fixtures/blender-followpath-v5.1.1.json` (33 rows, each a fresh factory scene with its
// inputs read back from Blender; 8 are in scope). The path is a poly line from (0, 0, 0) to
// (10, 0, 0) in the curve object's space.
//
// Only the position is compared. Blender also turns the follower by the curve object's rotation
// (`curve_rotated` → 120° about Z, `influence_0.5` → 45°), which Basher's Follow Path doesn't do
// yet (#1796).

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, __resetRegistryForTests } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { withIds } from '../test-utils/curvePoints';
import { makeSplitCube } from '../test-utils/splitCube';
import { resolveFollowedWorldPosition } from './nodeConstraints';

type Vec3 = [number, number, number];
interface Row {
  name: string;
  curve: { position: Vec3; rotation: Vec3; scale: Vec3 };
  own: { position: Vec3; rotation: Vec3 };
  factor: number;
  influence: number;
  want: Vec3;
}

const BLENDER: Row[] = [
  {
    name: 'fixed_0',
    curve: { position: [0.0, 0.0, 0.0], rotation: [0.0, 0.0, 0.0], scale: [1.0, 1.0, 1.0] },
    own: { position: [0.0, 0.0, 0.0], rotation: [0.0, 0.0, 0.0] },
    factor: 0.0,
    influence: 1.0,
    want: [0.0, 0.0, 0.0],
  },
  {
    name: 'fixed_0.5',
    curve: { position: [0.0, 0.0, 0.0], rotation: [0.0, 0.0, 0.0], scale: [1.0, 1.0, 1.0] },
    own: { position: [0.0, 0.0, 0.0], rotation: [0.0, 0.0, 0.0] },
    factor: 0.5,
    influence: 1.0,
    want: [5.0, 0.0, 0.0],
  },
  {
    name: 'fixed_1',
    curve: { position: [0.0, 0.0, 0.0], rotation: [0.0, 0.0, 0.0], scale: [1.0, 1.0, 1.0] },
    own: { position: [0.0, 0.0, 0.0], rotation: [0.0, 0.0, 0.0] },
    factor: 1.0,
    influence: 1.0,
    want: [10.0, 0.0, 0.0],
  },
  {
    name: 'own_location',
    curve: { position: [0.0, 0.0, 0.0], rotation: [0.0, 0.0, 0.0], scale: [1.0, 1.0, 1.0] },
    own: { position: [0.0, 4.0, 0.0], rotation: [0.0, 0.0, 0.0] },
    factor: 1.0,
    influence: 1.0,
    want: [10.0, 4.0, 0.0],
  },
  {
    name: 'own_rotation',
    curve: { position: [0.0, 0.0, 0.0], rotation: [0.0, 0.0, 0.0], scale: [1.0, 1.0, 1.0] },
    own: { position: [0.0, 4.0, 0.0], rotation: [0.0, 0.0, 30.0] },
    factor: 1.0,
    influence: 1.0,
    want: [10.0, 4.0, 0.0],
  },
  {
    name: 'curve_rotated',
    curve: { position: [0.0, 0.0, 0.0], rotation: [0.0, 0.0, 90.0], scale: [1.0, 1.0, 1.0] },
    own: { position: [0.0, 4.0, 0.0], rotation: [0.0, 0.0, 30.0] },
    factor: 1.0,
    influence: 1.0,
    want: [-4.0, 10.0, 0.0],
  },
  {
    name: 'curve_translated',
    curve: { position: [1.0, 2.0, 3.0], rotation: [0.0, 0.0, 0.0], scale: [1.0, 1.0, 1.0] },
    own: { position: [0.0, 4.0, 0.0], rotation: [0.0, 0.0, 0.0] },
    factor: 1.0,
    influence: 1.0,
    want: [11.0, 6.0, 3.0],
  },
  {
    name: 'influence_0.5',
    curve: { position: [0.0, 0.0, 0.0], rotation: [0.0, 0.0, 90.0], scale: [1.0, 1.0, 1.0] },
    own: { position: [0.0, 4.0, 0.0], rotation: [0.0, 0.0, 0.0] },
    factor: 1.0,
    influence: 0.5,
    want: [-2.0, 7.0, 0.0],
  },
];

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

function scene(r: Row): DagState {
  let s = makeSplitCube(buildDefaultDagState(), {
    objectId: 'f',
    position: r.own.position,
    rotation: r.own.rotation,
    connectTo: { node: 'n_scene', socket: 'children' },
  }).state;
  for (const op of [
    {
      type: 'addNode',
      nodeId: 'cd',
      nodeType: 'CurveData',
      params: {
        points: withIds([
          [0, 0, 0],
          [10, 0, 0],
        ]),
        closed: false,
        resolution: 32,
      },
    },
    { type: 'addNode', nodeId: 'c', nodeType: 'Object', params: r.curve },
    { type: 'connect', from: { node: 'cd', socket: 'out' }, to: { node: 'c', socket: 'data' } },
    {
      type: 'connect',
      from: { node: 'c', socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    },
    {
      type: 'addNode',
      nodeId: 'fp',
      nodeType: 'FollowPath',
      params: { target: 'f', curve: 'c', evalTime: r.factor, offset: 0, influence: r.influence },
    },
  ])
    s = applyOp(s, op as never).next;
  return s;
}

describe('Follow Path matches Blender 5.1.1, row by row (the fixture rows in scope)', () => {
  for (const r of BLENDER)
    it(`${r.name}: drawn at (${r.want.join(', ')})`, () => {
      const got = resolveFollowedWorldPosition(scene(r), 'f', {
        time: { frame: 0, seconds: 0, normalized: 0 },
      });
      expect(got).not.toBeNull();
      r.want.forEach((v, i) => expect(got![i], `[${i}]`).toBeCloseTo(v, 6));
    });
});
