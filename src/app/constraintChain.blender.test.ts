// #1811 — a wired constraint chain against Blender 5.1.1's own numbers.
//
// Rows copied from the fixtures `ref/fixtures/blender-followpath-v5.1.1.json` (the 8 rows inside
// what Basher's Follow Path does: Follow Curve off, a fixed position, no radius, one constraint)
// and `ref/fixtures/blender-constraint-order-v5.1.1.json` (5 rows: Follow Path and Track-To on an
// empty at (0, 4, 0), in both orders). The path is a poly line from (0, 0, 0) to (10, 0, 0).
//
// Only the position is compared on the Follow Path rows: Blender also turns the follower by the
// curve object's rotation, which Basher doesn't do yet (#1796).
//
// Influence is the small nodes (Polar Split, Mix, Combine, Multiply) wired over the chain. A step
// fixed at influence 1 has none.

import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyOp, evaluate, __resetRegistryForTests } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { NodeRef } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { withIds } from '../test-utils/curvePoints';
import { makeSplitCube } from '../test-utils/splitCube';

type Vec3 = [number, number, number];
const ctx = { time: { frame: 0, seconds: 0, normalized: 0 } };

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const run = (s: DagState, ops: object[]) => {
  for (const o of ops) s = applyOp(s, o as never).next;
  return s;
};
const wire = (from: NodeRef, node: string, socket: string) => ({
  type: 'connect',
  from,
  to: { node, socket },
});
const world = (node: string): NodeRef => ({ node, socket: 'world' });

const curveOps = (params: object = {}) => [
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
  { type: 'addNode', nodeId: 'c', nodeType: 'Object', params },
  wire({ node: 'cd', socket: 'out' }, 'c', 'data'),
  wire({ node: 'c', socket: 'out' }, 'n_scene', 'children'),
];

/** `over` blended onto `under` by `factor`, in the small nodes. Returns what comes out. */
function blendOps(id: string, under: NodeRef, over: NodeRef, factor: number) {
  const n = (suffix: string) => `${id}_${suffix}`;
  const mix = (suffix: string, dataType: string) => ({
    type: 'addNode',
    nodeId: n(suffix),
    nodeType: 'Mix',
    params: { dataType, factor },
  });
  const ops: object[] = [
    { type: 'addNode', nodeId: n('a'), nodeType: 'PolarSplit', params: {} },
    { type: 'addNode', nodeId: n('b'), nodeType: 'PolarSplit', params: {} },
    wire(under, n('a'), 'transform'),
    wire(over, n('b'), 'transform'),
    mix('t', 'Vector'),
    mix('r', 'Rotation'),
    mix('s', 'Matrix'),
    { type: 'addNode', nodeId: n('place'), nodeType: 'CombineTransform', params: {} },
    { type: 'addNode', nodeId: n('out'), nodeType: 'MultiplyTransforms', params: {} },
  ];
  for (const [mixer, part, sockets] of [
    ['t', 'translation', ['aVector', 'bVector']],
    ['r', 'rotation', ['aRotation', 'bRotation']],
    ['s', 'stretch', ['aMatrix', 'bMatrix']],
  ] as const) {
    ops.push(wire({ node: n('a'), socket: part }, n(mixer), sockets[0]));
    ops.push(wire({ node: n('b'), socket: part }, n(mixer), sockets[1]));
  }
  ops.push(
    wire({ node: n('t'), socket: 'outVector' }, n('place'), 'translation'),
    wire({ node: n('r'), socket: 'outRotation' }, n('place'), 'rotation'),
    wire({ node: n('place'), socket: 'out' }, n('out'), 'a'),
    wire({ node: n('s'), socket: 'outMatrix' }, n('out'), 'b'),
  );
  return { ops, out: { node: n('out'), socket: 'out' } as NodeRef };
}

/** One object's chain from its steps, bottom first, each blended by its influence if not 1. */
function chainOps(
  object: string,
  steps: readonly { id: string; influence?: number; wires: (below: NodeRef) => object[] }[],
) {
  const ops: object[] = [
    { type: 'addNode', nodeId: `own_${object}`, nodeType: 'OwnWorld', params: { object } },
  ];
  let below = world(`own_${object}`);
  for (const step of steps) {
    ops.push(...step.wires(below));
    if (step.influence === undefined || step.influence === 1) below = world(step.id);
    else {
      const blend = blendOps(`blend_${step.id}`, below, world(step.id), step.influence);
      ops.push(...blend.ops);
      below = blend.out;
    }
  }
  ops.push(wire(below, object, 'constraints'));
  return ops;
}

const followStep = (id: string, evalTime: number, influence = 1) => ({
  id,
  influence,
  wires: (below: NodeRef) => [
    { type: 'addNode', nodeId: id, nodeType: 'FollowPath', params: { evalTime, offset: 0 } },
    wire(below, id, 'in'),
    wire(world('c'), id, 'curve'),
  ],
});
const aimStep = (id: string, aimPoint: Vec3, influence = 1) => ({
  id,
  influence,
  wires: (below: NodeRef) => [
    { type: 'addNode', nodeId: id, nodeType: 'TrackTo', params: { aimPoint, up: [0, 0, 1] } },
    wire(below, id, 'in'),
  ],
});

const worldOf = (s: DagState, id: string) => {
  const m = evaluate(s, id, { ctx, socket: 'world' }).value as number[];
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  new THREE.Matrix4().fromArray(m).decompose(position, rotation, new THREE.Vector3());
  return { position, rotation };
};
const close = (got: { toArray(): number[] }, want: readonly number[]) => {
  const a = got.toArray();
  want.forEach((v, i) => expect(a[i], `[${i}]`).toBeCloseTo(v, 4));
};

const cubeAt = (position: Vec3, rotation: Vec3 = [0, 0, 0]) =>
  makeSplitCube(buildDefaultDagState(), {
    objectId: 'f',
    position,
    rotation,
    connectTo: { node: 'n_scene', socket: 'children' },
  }).state;

interface PathRow {
  name: string;
  curve: { position: Vec3; rotation: Vec3 };
  own: { position: Vec3; rotation: Vec3 };
  factor: number;
  influence: number;
  want: Vec3;
}
const O: Vec3 = [0, 0, 0];
const PATH_ROWS: PathRow[] = [
  {
    name: 'fixed_0',
    curve: { position: O, rotation: O },
    own: { position: O, rotation: O },
    factor: 0,
    influence: 1,
    want: [0, 0, 0],
  },
  {
    name: 'fixed_0.5',
    curve: { position: O, rotation: O },
    own: { position: O, rotation: O },
    factor: 0.5,
    influence: 1,
    want: [5, 0, 0],
  },
  {
    name: 'fixed_1',
    curve: { position: O, rotation: O },
    own: { position: O, rotation: O },
    factor: 1,
    influence: 1,
    want: [10, 0, 0],
  },
  {
    name: 'own_location',
    curve: { position: O, rotation: O },
    own: { position: [0, 4, 0], rotation: O },
    factor: 1,
    influence: 1,
    want: [10, 4, 0],
  },
  {
    name: 'own_rotation',
    curve: { position: O, rotation: O },
    own: { position: [0, 4, 0], rotation: [0, 0, 30] },
    factor: 1,
    influence: 1,
    want: [10, 4, 0],
  },
  {
    name: 'curve_rotated',
    curve: { position: O, rotation: [0, 0, 90] },
    own: { position: [0, 4, 0], rotation: [0, 0, 30] },
    factor: 1,
    influence: 1,
    want: [-4, 10, 0],
  },
  {
    name: 'curve_translated',
    curve: { position: [1, 2, 3], rotation: O },
    own: { position: [0, 4, 0], rotation: O },
    factor: 1,
    influence: 1,
    want: [11, 6, 3],
  },
  {
    name: 'influence_0.5',
    curve: { position: O, rotation: [0, 0, 90] },
    own: { position: [0, 4, 0], rotation: O },
    factor: 1,
    influence: 0.5,
    want: [-2, 7, 0],
  },
];

describe('Follow Path on a chain matches Blender 5.1.1, row by row', () => {
  for (const r of PATH_ROWS)
    it(`${r.name}: at (${r.want.join(', ')})`, () => {
      const s = run(cubeAt(r.own.position, r.own.rotation), [
        ...curveOps(r.curve),
        ...chainOps('f', [followStep('fp', r.factor, r.influence)]),
      ]);
      close(worldOf(s, 'f').position, r.want);
    });
});

type Kind = 'FP' | 'TT';
const ORDER_ROWS: {
  name: string;
  order: Kind[];
  fp: number;
  tt: number;
  position: Vec3;
  forward: Vec3;
}[] = [
  {
    name: 'fp_then_tt',
    order: ['FP', 'TT'],
    fp: 1,
    tt: 1,
    position: [10, 4, 0],
    forward: [0, 1, 0],
  },
  {
    name: 'tt_then_fp',
    order: ['TT', 'FP'],
    fp: 1,
    tt: 1,
    position: [10, 4, 0],
    forward: [0.85749, 0.5145, 0],
  },
  {
    name: 'fp_half_then_tt',
    order: ['FP', 'TT'],
    fp: 0.5,
    tt: 1,
    position: [5, 4, 0],
    forward: [0.64018, 0.76822, 0],
  },
  {
    name: 'tt_then_fp_half',
    order: ['TT', 'FP'],
    fp: 0.5,
    tt: 1,
    position: [5, 4, 0],
    forward: [0.85749, 0.5145, 0],
  },
  {
    name: 'fp_then_tt_half',
    order: ['FP', 'TT'],
    fp: 1,
    tt: 0.5,
    position: [10, 4, 0],
    forward: [0, 0.70711, -0.70711],
  },
];

describe('both constraint orders on a chain match Blender 5.1.1', () => {
  const steps = (row: (typeof ORDER_ROWS)[number]) =>
    row.order.map((k) =>
      k === 'FP' ? followStep('fp', 1, row.fp) : aimStep('tt', [10, 10, 0], row.tt),
    );
  const check = (s: DagState, id: string, row: (typeof ORDER_ROWS)[number]) => {
    const { position, rotation } = worldOf(s, id);
    close(position, row.position);
    close(new THREE.Vector3(0, 0, -1).applyQuaternion(rotation), row.forward);
  };
  for (const row of ORDER_ROWS) {
    it(`${row.name}: a cube`, () => {
      const s = run(cubeAt([0, 4, 0]), [...curveOps(), ...chainOps('f', steps(row))]);
      check(s, 'f', row);
    });
    it(`${row.name}: the camera`, () => {
      const s = run(buildDefaultDagState(), [
        { type: 'setParam', nodeId: 'n_camera', paramPath: 'position', value: [0, 4, 0] },
        { type: 'setParam', nodeId: 'n_camera', paramPath: 'rotation', value: [0, 0, 0] },
        ...curveOps(),
        ...chainOps('n_camera', steps(row)),
      ]);
      check(s, 'n_camera', row);
    });
  }
});

// Measured in 4.5.9 and 5.1.1 (identical): an empty at (0, 1, 0) under an empty at (1, 2, 3), turned
// (40, 0, 25) in Blender's ZYX mode (Basher's XYZ), Track-To at (4, 0, 0), track -Z, up Y. Rows of
// the world matrix. An aim keeps the length of each axis: no shear, and a mirror below it is lost.
const UNDER_PARENT: { name: string; scale: Vec3; want: number[][] }[] = [
  {
    name: 'uneven',
    scale: [1, 2, 3],
    want: [
      [-0.66115, 0.94633, -1.74671, 0.15476],
      [-0.75026, -0.83394, 1.53925, 3.38854],
      [0, 1.5521, 1.89202, 4.16513],
    ],
  },
  {
    name: 'mirror',
    scale: [-1, 2, 3],
    want: [
      [-0.66115, 0.94633, -1.74671, 0.15476],
      [-0.75026, -0.83394, 1.53925, 3.38854],
      [0, 1.5521, 1.89202, 4.16513],
    ],
  },
  {
    name: 'uniform',
    scale: [2, 2, 2],
    want: [
      [-1.3223, 0.94633, -1.16447, 0.15476],
      [-1.50051, -0.83394, 1.02617, 3.38854],
      [0, 1.5521, 1.26134, 4.16513],
    ],
  },
];

describe('an aim under a scaled parent matches Blender', () => {
  for (const row of UNDER_PARENT)
    it(row.name, () => {
      const s = run(buildDefaultDagState(), [
        {
          type: 'addNode',
          nodeId: 'g',
          nodeType: 'Group',
          params: { position: [1, 2, 3], rotation: [40, 0, 25], scale: row.scale },
        },
        { type: 'addNode', nodeId: 'h', nodeType: 'Object', params: { position: [4, 0, 0] } },
        { type: 'addNode', nodeId: 'a', nodeType: 'Object', params: { position: [0, 1, 0] } },
        wire(world('g'), 'a', 'parent'),
        ...chainOps('a', [
          {
            id: 'tt',
            wires: (below) => [
              { type: 'addNode', nodeId: 'tt', nodeType: 'TrackTo', params: { up: [0, 0, 1] } },
              wire(below, 'tt', 'in'),
              wire(world('h'), 'tt', 'aim'),
            ],
          },
        ]),
      ]);
      const m = evaluate(s, 'a', { ctx, socket: 'world' }).value as number[];
      row.want.forEach((cells, r) =>
        cells.forEach((v, c) => expect(m[c * 4 + r], `row ${r} col ${c}`).toBeCloseTo(v, 4)),
      );
    });
});
