// #1811 — the wired constraint chain: what it reads, what it refuses, and that it agrees with the
// road it replaces. Blender's numbers are in `constraintChain.blender.test.ts`.

import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { evaluate, __resetRegistryForTests } from '../core/dag';
import { applyOp } from '../test-utils/committedApplyOp';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { withIds } from '../test-utils/curvePoints';
import { makeSplitCube } from '../test-utils/splitCube';
import { resolveConstraintRotation, resolveFollowedWorldPosition } from './nodeConstraints';
import { resolveWorldTransform } from './resolveWorldTransform';
import { characterAssetOf } from './characterParts';
import { inputsBelow } from '../core/dag/worldChildren';
import { layoutOf } from '../core/dag/layout';
import { buildExampleProject } from '../core/project/examples';

type Vec3 = [number, number, number];
const at = (seconds = 0) => ({ time: { frame: seconds * 24, seconds, normalized: 0 } });

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const run = (s: DagState, ops: object[]) => {
  for (const o of ops) s = applyOp(s, o as never).next;
  return s;
};
const wire = (from: string, socket: string, node: string, into: string) => ({
  type: 'connect',
  from: { node: from, socket },
  to: { node, socket: into },
});
const add = (nodeId: string, nodeType: string, params: object = {}) => ({
  type: 'addNode',
  nodeId,
  nodeType,
  params,
});

const cube = (s: DagState, objectId: string, position: Vec3, scale?: Vec3) =>
  makeSplitCube(s, {
    objectId,
    position,
    ...(scale ? { scale } : {}),
    connectTo: { node: 'n_scene', socket: 'children' },
  }).state;

/** OwnWorld → Track-To → the object. */
const aimOps = (object: string, id: string, params: object, aimAt?: string) => [
  add(`own_${object}`, 'OwnWorld', { object }),
  add(id, 'TrackTo', { up: [0, 1, 0], ...params }),
  wire(`own_${object}`, 'world', id, 'in'),
  ...(aimAt ? [wire(aimAt, 'world', id, 'aim')] : []),
  wire(id, 'world', object, 'constraints'),
];

const matrix = (s: DagState, id: string, seconds = 0) =>
  new THREE.Matrix4().fromArray(
    evaluate(s, id, { ctx: at(seconds), socket: 'world' }).value as number[],
  );
const positionOf = (m: THREE.Matrix4) => new THREE.Vector3().setFromMatrixPosition(m);
const forwardOf = (m: THREE.Matrix4) => {
  const q = new THREE.Quaternion();
  m.decompose(new THREE.Vector3(), q, new THREE.Vector3());
  return new THREE.Vector3(0, 0, -1).applyQuaternion(q);
};
const expectDir = (got: THREE.Vector3, want: Vec3) => {
  const w = new THREE.Vector3(...want).normalize();
  expect(got.distanceTo(w), `${got.toArray()} vs ${w.toArray()}`).toBeLessThan(1e-6);
};

const curveOps = [
  add('cd', 'CurveData', {
    points: withIds([
      [0, 0, 0],
      [10, 0, 0],
    ]),
    closed: false,
    resolution: 32,
  }),
  add('c', 'Object'),
  wire('cd', 'out', 'c', 'data'),
  wire('c', 'out', 'n_scene', 'children'),
];

describe('an object with no chain', () => {
  it('reads its own world, and OwnWorld reads the same', () => {
    const s = run(cube(buildDefaultDagState(), 'a', [1, 2, 3]), [
      add('own', 'OwnWorld', { object: 'a' }),
    ]);
    expect(matrix(s, 'a').toArray()).toEqual(matrix(s, 'own').toArray());
    expect(positionOf(matrix(s, 'a')).toArray()).toEqual([1, 2, 3]);
  });

  it('an OwnWorld naming nothing reads the identity', () => {
    const s = run(buildDefaultDagState(), [add('own', 'OwnWorld', { object: 'gone' })]);
    expect(matrix(s, 'own').toArray()).toEqual(new THREE.Matrix4().toArray());
  });
});

describe('Track-To on a chain', () => {
  it('keeps the position and scale it receives and turns toward the point', () => {
    const s = run(cube(buildDefaultDagState(), 'a', [0, 0, 0], [2, 3, 4]), [
      ...aimOps('a', 'tt', { aimPoint: [5, 0, 0] }),
    ]);
    const m = matrix(s, 'a');
    expectDir(forwardOf(m), [1, 0, 0]);
    const scale = new THREE.Vector3();
    m.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
    expect(scale.x).toBeCloseTo(2, 9);
    expect(scale.y).toBeCloseTo(3, 9);
    expect(scale.z).toBeCloseTo(4, 9);
  });

  it('muted, it hands on what it received', () => {
    const s = run(cube(buildDefaultDagState(), 'a', [1, 0, 0]), [
      ...aimOps('a', 'tt', { aimPoint: [5, 0, 0], mute: true }),
    ]);
    expect(matrix(s, 'a').toArray()).toEqual(matrix(s, 'own_a').toArray());
  });

  it('standing on its target, it keeps the rotation it received', () => {
    const s = run(cube(buildDefaultDagState(), 'a', [5, 0, 0]), [
      ...aimOps('a', 'tt', { aimPoint: [5, 0, 0] }),
    ]);
    expect(matrix(s, 'a').toArray()).toEqual(matrix(s, 'own_a').toArray());
  });

  it('reads its target after that target has its own chain (Blender 4.5.9 and 5.1.1)', () => {
    let s = cube(buildDefaultDagState(), 'target', [0, 0, -3]);
    s = cube(s, 'follower', [0, 0, 0]);
    // The target rides a path from the origin to (10, 0, 0), at its end, keeping (0, 0, -3).
    s = run(s, [
      ...curveOps,
      add('own_target', 'OwnWorld', { object: 'target' }),
      add('fp', 'FollowPath', { evalTime: 1, offset: 0 }),
      wire('own_target', 'world', 'fp', 'in'),
      wire('c', 'world', 'fp', 'curve'),
      wire('fp', 'world', 'target', 'constraints'),
      ...aimOps('follower', 'tt', {}, 'target'),
    ]);
    expectDir(forwardOf(matrix(s, 'follower')), [10, 0, -3]);
  });

  it('reads its target after the aim of what the target hangs from', () => {
    let s = cube(buildDefaultDagState(), 'parent', [0, 0, 0]);
    s = cube(s, 'child', [0, 0, -3]);
    s = cube(s, 'follower', [0, 5, 0]);
    s = run(s, [
      wire('parent', 'world', 'child', 'parent'),
      ...aimOps('parent', 'ttp', { aimPoint: [5, 0, 0] }),
      ...aimOps('follower', 'ttf', {}, 'child'),
    ]);
    // The parent's aim turned the child's (0, 0, -3) to (3, 0, 0).
    const child = positionOf(matrix(s, 'child'));
    expect(child.distanceTo(new THREE.Vector3(3, 0, 0))).toBeLessThan(1e-6);
    expectDir(forwardOf(matrix(s, 'follower')), [3, -5, 0]);
  });

  it('a child of an aimed object hangs from where the parent ends up', () => {
    let s = cube(buildDefaultDagState(), 'parent', [1, 0, 0]);
    s = cube(s, 'child', [0, 0, -2]);
    s = run(s, [
      ...aimOps('parent', 'tt', { aimPoint: [1, 5, 0], up: [0, 0, 1] }),
      wire('parent', 'world', 'child', 'parent'),
    ]);
    expect(positionOf(matrix(s, 'child')).distanceTo(new THREE.Vector3(1, 2, 0))).toBeLessThan(
      1e-6,
    );
  });

  it('reads a keyed aim point at the time asked', () => {
    let s = cube(buildDefaultDagState(), 'a', [0, 0, 0]);
    s = run(s, [
      ...aimOps('a', 'tt', { aimPoint: [0, 0, -1] }),
      add('ch', 'KeyframeChannelVec3', {
        target: 'tt',
        paramPath: 'aimPoint',
        keyframes: [
          { time: 0, value: [1, 0, 0] },
          { time: 1, value: [0, 0, 1] },
        ],
      }),
    ]);
    expectDir(forwardOf(matrix(s, 'a', 0)), [1, 0, 0]);
    expectDir(forwardOf(matrix(s, 'a', 1)), [0, 0, 1]);
  });
});

describe('Follow Path on a chain', () => {
  it('reads a keyed evalTime at the time asked', () => {
    let s = cube(buildDefaultDagState(), 'a', [0, 4, 0]);
    s = run(s, [
      ...curveOps,
      add('own', 'OwnWorld', { object: 'a' }),
      add('fp', 'FollowPath', {}),
      wire('own', 'world', 'fp', 'in'),
      wire('c', 'world', 'fp', 'curve'),
      wire('fp', 'world', 'a', 'constraints'),
      add('ch', 'KeyframeChannelNumber', {
        target: 'fp',
        paramPath: 'evalTime',
        keyframes: [
          { time: 0, value: 0 },
          { time: 1, value: 1 },
        ],
      }),
    ]);
    expect(positionOf(matrix(s, 'a', 0)).toArray()).toEqual([0, 4, 0]);
    expect(positionOf(matrix(s, 'a', 1)).toArray()).toEqual([10, 4, 0]);
  });

  it('with no curve wired, it hands on what it received', () => {
    const s = run(cube(buildDefaultDagState(), 'a', [1, 2, 3]), [
      add('own', 'OwnWorld', { object: 'a' }),
      add('fp', 'FollowPath', { evalTime: 1 }),
      wire('own', 'world', 'fp', 'in'),
      wire('fp', 'world', 'a', 'constraints'),
    ]);
    expect(positionOf(matrix(s, 'a')).toArray()).toEqual([1, 2, 3]);
  });

  it('follows the curve object where its own chain puts it', () => {
    let s = cube(buildDefaultDagState(), 'a', [0, 0, 0]);
    s = cube(s, 'other', [0, 0, 0]);
    s = run(s, [
      ...curveOps,
      // The curve object itself follows a second path to (10, 0, 0), keeping its own position.
      add('cd2', 'CurveData', {
        points: withIds([
          [0, 0, 0],
          [0, 0, 7],
        ]),
        closed: false,
        resolution: 32,
      }),
      add('c2', 'Object'),
      wire('cd2', 'out', 'c2', 'data'),
      wire('c2', 'out', 'n_scene', 'children'),
      add('own_c', 'OwnWorld', { object: 'c' }),
      add('fpc', 'FollowPath', { evalTime: 1 }),
      wire('own_c', 'world', 'fpc', 'in'),
      wire('c2', 'world', 'fpc', 'curve'),
      wire('fpc', 'world', 'c', 'constraints'),
      add('own', 'OwnWorld', { object: 'a' }),
      add('fp', 'FollowPath', { evalTime: 1 }),
      wire('own', 'world', 'fp', 'in'),
      wire('c', 'world', 'fp', 'curve'),
      wire('fp', 'world', 'a', 'constraints'),
    ]);
    expect(positionOf(matrix(s, 'a')).distanceTo(new THREE.Vector3(10, 0, 7))).toBeLessThan(1e-6);
  });
});

describe('what the graph refuses', () => {
  it('two objects aiming at each other: the wire that closes it is refused', () => {
    let s = cube(buildDefaultDagState(), 'a', [0, 0, 0]);
    s = cube(s, 'b', [1, 0, 0]);
    s = run(s, [...aimOps('a', 'tta', {}, 'b'), ...aimOps('b', 'ttb', {})]);
    expect(() => run(s, [wire('a', 'world', 'ttb', 'aim')])).toThrow(/cycle/);
  });

  it('aiming at your own child is refused: the child hangs from your aim', () => {
    let s = cube(buildDefaultDagState(), 'a', [0, 0, 0]);
    s = cube(s, 'kid', [1, 0, 0]);
    s = run(s, [...aimOps('a', 'tt', {}), wire('a', 'world', 'kid', 'parent')]);
    expect(() => run(s, [wire('kid', 'world', 'tt', 'aim')])).toThrow(/cycle/);
  });

  it("an object's own world into what it hangs from is refused, though no wire names it", () => {
    let s = cube(buildDefaultDagState(), 'a', [0, 0, 0]);
    s = cube(s, 'p', [1, 0, 0]);
    s = run(s, [add('own', 'OwnWorld', { object: 'a' }), wire('p', 'world', 'a', 'parent')]);
    expect(() => run(s, [wire('own', 'world', 'p', 'parent')])).toThrow(/cycle/);
  });

  it('the chain from an object up to itself is not a loop', () => {
    const s = cube(buildDefaultDagState(), 'a', [0, 0, 0]);
    expect(() => run(s, aimOps('a', 'tt', { aimPoint: [1, 0, 0] }))).not.toThrow();
  });

  it('a loop written straight into a file throws, naming a node, and does not hang', () => {
    let s = cube(buildDefaultDagState(), 'a', [0, 0, 0]);
    s = cube(s, 'b', [1, 0, 0]);
    s = run(s, [...aimOps('a', 'tta', {}, 'b'), ...aimOps('b', 'ttb', {})]);
    const nodes = {
      ...s.nodes,
      ttb: {
        ...s.nodes.ttb,
        inputs: { ...s.nodes.ttb.inputs, aim: { node: 'a', socket: 'world' } },
      },
    };
    expect(() => matrix({ ...s, nodes }, 'a')).toThrow(/cycle detected/);
  });
});

describe("the chain agrees with today's road", () => {
  /** A tilted, keyed group holding a cube, an aimed cube and a follower. */
  function tiltedRig(groupScale: Vec3): DagState {
    let s = run(buildDefaultDagState(), [
      add('g', 'Group', { position: [1, 2, 3], rotation: [40, 0, 25], scale: groupScale }),
      wire('g', 'out', 'n_scene', 'children'),
      add('gk', 'KeyframeChannelVec3', {
        target: 'g',
        paramPath: 'rotation',
        keyframes: [
          { time: 0, value: [40, 0, 25] },
          { time: 2, value: [40, 90, 25] },
        ],
      }),
    ]);
    s = cube(s, 'hero', [4, 0, 0]);
    for (const id of ['aimed', 'plain']) {
      s = makeSplitCube(s, {
        objectId: id,
        position: [0, 1, 0],
        connectTo: { node: 'g', socket: 'children' },
      }).state;
    }
    return run(s, [
      add('old', 'TrackTo', { target: 'aimed', aimNode: 'hero', up: [0, 1, 0] }),
      // The same aim on a chain, on a twin of `aimed`, parent input from the group.
      add('own_g', 'OwnWorld', { object: 'g' }),
      add('twin', 'Object', { position: [0, 1, 0] }),
      wire('g', 'world', 'twin', 'parent'),
      add('own_twin', 'OwnWorld', { object: 'twin' }),
      add('tt', 'TrackTo', { up: [0, 1, 0] }),
      wire('own_twin', 'world', 'tt', 'in'),
      wire('hero', 'world', 'tt', 'aim'),
      wire('g', 'world', 'tt', 'parent'),
      wire('tt', 'world', 'twin', 'constraints'),
    ]);
  }

  for (const seconds of [0, 0.7, 2]) {
    it(`an aimed object under a tilted, keyed group, at ${seconds} s`, () => {
      const s = tiltedRig([1, 1, 1]);
      const ctx = at(seconds);
      const parent = resolveWorldTransform(s, 'g', ctx)!;
      const local = resolveConstraintRotation(s, 'aimed', ctx)!;
      const today = new THREE.Matrix4()
        .fromArray(parent.matrix)
        .multiply(
          new THREE.Matrix4().compose(
            new THREE.Vector3(0, 1, 0),
            new THREE.Quaternion().setFromEuler(
              new THREE.Euler(...(local.map((d) => THREE.MathUtils.degToRad(d)) as Vec3), 'XYZ'),
            ),
            new THREE.Vector3(1, 1, 1),
          ),
        );
      const got = matrix(s, 'twin', seconds).toArray();
      today.toArray().forEach((v, i) => expect(got[i], `[${i}]`).toBeCloseTo(v, 9));
    });
  }

  it('a follower at its own origin stands where today puts it', () => {
    let s = cube(buildDefaultDagState(), 'a', [0, 0, 0]);
    s = cube(s, 'b', [0, 0, 0]);
    s = run(s, [
      ...curveOps,
      add('old', 'FollowPath', { target: 'a', curve: 'c', evalTime: 0.25, offset: 0.25 }),
      add('own', 'OwnWorld', { object: 'b' }),
      add('fp', 'FollowPath', { evalTime: 0.25, offset: 0.25 }),
      wire('own', 'world', 'fp', 'in'),
      wire('c', 'world', 'fp', 'curve'),
      wire('fp', 'world', 'b', 'constraints'),
    ]);
    expect(positionOf(matrix(s, 'b')).toArray()).toEqual(
      resolveFollowedWorldPosition(s, 'a', at()),
    );
  });
});

describe('a chain and the walks that read the graph', () => {
  it('a walk down from an object does not follow its chain to what it aims at', () => {
    let s = cube(buildDefaultDagState(), 'a', [0, 0, 0]);
    s = cube(s, 'hero', [1, 0, 0]);
    s = run(s, aimOps('a', 'tt', {}, 'hero'));
    const below = inputsBelow(s, 'a', s.nodes.a);
    expect(Object.keys(below)).not.toContain('constraints');
    expect(Object.keys(below)).toContain('data');
  });

  it('aiming at a character does not make the aimer stand for that character', () => {
    const s = run(buildDefaultDagState(), [
      add('asset', 'GltfAsset', { assetRef: 'assets/x.glb' }),
      add('g', 'Group'),
      wire('asset', 'out', 'g', 'children'),
      add('a', 'Null'),
      ...aimOps('a', 'tt_a', {}, 'g'),
    ]);
    expect(characterAssetOf(s, 'g')).toBe('asset');
    expect(characterAssetOf(s, 'a')).toBeNull();
  });

  it('the node layout places every node of a chain', () => {
    let s = cube(buildDefaultDagState(), 'a', [0, 0, 0]);
    s = cube(s, 'hero', [1, 0, 0]);
    s = run(s, aimOps('a', 'tt', {}, 'hero'));
    const positions = layoutOf(s);
    for (const id of ['a', 'own_a', 'tt', 'hero']) expect(positions.get(id), id).toBeDefined();
  });
});

describe('Track-To aiming at a bone of what is wired in', () => {
  const towards = (m: THREE.Matrix4, point: Vec3) =>
    new THREE.Vector3(...point).sub(positionOf(m)).normalize();
  const rig = async (aimBone: string) => {
    const { state } = await buildExampleProject('example_camera_path_ai_walk');
    const group = Object.values(state.nodes).find((n) => n.type === 'Group')!.id;
    return run(state, [
      add('a', 'Null', { position: [5, 5, 5] }),
      ...aimOps('a', 'tt_a', { aimBone }, group),
    ]);
  };

  // The drawn Hips, as `gltfNodeWorld.test.ts` reads them off the skeleton in the browser.
  for (const [t, hips] of [
    [0, [-2.019, 0.604, -1.99]],
    [7.5, [1.349, 0.603, 0.261]],
  ] as [number, Vec3][]) {
    it(`follows the walking Hips at ${t} s`, async () => {
      const m = matrix(await rig('mixamorig_Hips'), 'a', t);
      expect(forwardOf(m).distanceTo(towards(m, hips))).toBeLessThan(0.005);
    });
  }

  it('a bone that does not resolve aims at the object', async () => {
    const m = matrix(await rig('no_such_bone'), 'a', 1);
    expect(forwardOf(m).distanceTo(towards(m, [-2, 0, -2]))).toBeLessThan(1e-6);
  });
});
