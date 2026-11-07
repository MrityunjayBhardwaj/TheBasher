// #1811 — objects that aim at each other, through the aim-target reference.
//
// Blender stores such a loop, warns, and answers from whatever was evaluated last, so a fresh file
// depends on creation order and on the version (measured, 4.5.9 and 5.1.1): in 5.1.1 the first
// evaluation leaves A unaimed. Once anything moves both versions settle on each object facing the
// other, and those are the rows below. A Track-To does not move its object, so that answer needs
// no history, and it is what Basher gives every time.

import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyOp, evaluate, __resetRegistryForTests } from '../core/dag';
import { createEvaluatorCache } from '../core/dag/evaluator';
import { referenceCycles } from '../core/dag/idRefSweep';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { withIds } from '../test-utils/curvePoints';
import { makeSplitCube } from '../test-utils/splitCube';

type Vec3 = [number, number, number];
const at = { time: { frame: 0, seconds: 0, normalized: 0 } };

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
const cube = (s: DagState, objectId: string, position: Vec3) =>
  makeSplitCube(s, {
    objectId,
    position,
    connectTo: { node: 'n_scene', socket: 'children' },
  }).state;
/** OwnWorld → Track-To → the object, aiming by reference. */
const aim = (object: string, step: string, aimNode: string) => [
  add(`own_${object}`, 'OwnWorld', { object }),
  add(step, 'TrackTo', { up: [0, 1, 0], aimNode }),
  wire(`own_${object}`, 'world', step, 'in'),
  wire(step, 'world', object, 'constraints'),
];
const world = (s: DagState, id: string, cache?: ReturnType<typeof createEvaluatorCache>) =>
  new THREE.Matrix4().fromArray(
    evaluate(s, id, { socket: 'world', ctx: at, cache }).value as number[],
  );
const facing = (m: THREE.Matrix4) => {
  const f = new THREE.Vector3().setFromMatrixColumn(m, 2).normalize().negate();
  return [f.x, f.y, f.z];
};
const position = (m: THREE.Matrix4) => {
  const p = new THREE.Vector3().setFromMatrixPosition(m);
  return [p.x, p.y, p.z];
};
const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 3));

describe('objects aiming at each other', () => {
  it('each faces the other, at Blender\x27s settled numbers', () => {
    let s = cube(cube(buildDefaultDagState(), 'a', [1, 0, 0]), 'b', [3, 3, 0]);
    s = run(s, [...aim('a', 'tta', 'b'), ...aim('b', 'ttb', 'a')]);
    close(facing(world(s, 'a')), [0.5547, 0.8321, 0]);
    close(facing(world(s, 'b')), [-0.5547, -0.8321, 0]);
    close(position(world(s, 'a')), [1, 0, 0]);
    close(position(world(s, 'b')), [3, 3, 0]);
  });

  it('the answer does not depend on which object is asked first', () => {
    let s = cube(cube(buildDefaultDagState(), 'a', [1, 0, 0]), 'b', [3, 3, 0]);
    s = run(s, [...aim('a', 'tta', 'b'), ...aim('b', 'ttb', 'a')]);
    const cacheAB = createEvaluatorCache();
    const a1 = world(s, 'a', cacheAB).toArray();
    const b1 = world(s, 'b', cacheAB).toArray();
    const cacheBA = createEvaluatorCache();
    const b2 = world(s, 'b', cacheBA).toArray();
    const a2 = world(s, 'a', cacheBA).toArray();
    expect(a1).toEqual(a2);
    expect(b1).toEqual(b2);
  });

  it('a ring of three all aim true, as Blender measures it', () => {
    let s = cube(
      cube(cube(buildDefaultDagState(), 'a', [0, 0, 0]), 'b', [3, 0, 0]),
      'c',
      [0, 3, 0],
    );
    s = run(s, [...aim('a', 'tta', 'b'), ...aim('b', 'ttb', 'c'), ...aim('c', 'ttc', 'a')]);
    close(facing(world(s, 'a')), [1, 0, 0]);
    close(facing(world(s, 'b')), [-0.7071, 0.7071, 0]);
    close(facing(world(s, 'c')), [0, -1, 0]);
  });

  it('an object moved by its chain is aimed at where the chain put it', () => {
    let s = cube(cube(buildDefaultDagState(), 'a', [0, 0, 0]), 'b', [3, 0, 0]);
    s = run(s, [
      ...aim('b', 'ttb', 'a'),
      add('own_a', 'OwnWorld', { object: 'a' }),
      add('cd', 'CurveData', {
        points: withIds([
          [0, 5, 0],
          [0, 6, 0],
        ]),
        closed: false,
        resolution: 32,
      }),
      add('c', 'Object'),
      wire('cd', 'out', 'c', 'data'),
      wire('c', 'out', 'n_scene', 'children'),
      add('fp', 'FollowPath', { evalTime: 0 }),
      add('tta', 'TrackTo', { up: [0, 1, 0], aimNode: 'b' }),
      wire('own_a', 'world', 'fp', 'in'),
      wire('c', 'world', 'fp', 'curve'),
      wire('fp', 'world', 'tta', 'in'),
      wire('tta', 'world', 'a', 'constraints'),
    ]);
    const p = position(world(s, 'a'));
    expect(p[1]).toBeGreaterThan(1);
    const toA = new THREE.Vector3(...(p as Vec3)).sub(new THREE.Vector3(3, 0, 0)).normalize();
    close(facing(world(s, 'b')), [toA.x, toA.y, toA.z]);
  });

  it('an influence blend inside the loop evaluates', () => {
    let s = cube(cube(buildDefaultDagState(), 'a', [1, 0, 0]), 'b', [3, 3, 0]);
    s = run(s, [
      ...aim('b', 'ttb', 'a'),
      add('own_a', 'OwnWorld', { object: 'a' }),
      add('tta', 'TrackTo', { up: [0, 1, 0], aimNode: 'b' }),
      add('mix', 'Mix', { dataType: 'Matrix', factor: 1 }),
      wire('own_a', 'world', 'tta', 'in'),
      wire('own_a', 'world', 'mix', 'aMatrix'),
      wire('tta', 'world', 'mix', 'bMatrix'),
      wire('mix', 'outMatrix', 'a', 'constraints'),
    ]);
    close(facing(world(s, 'a')), [0.5547, 0.8321, 0]);
    close(facing(world(s, 'b')), [-0.5547, -0.8321, 0]);
  });

  it('aiming at yourself leaves you as you were', () => {
    let s = cube(buildDefaultDagState(), 'a', [2, 0, 0]);
    s = run(s, aim('a', 'tta', 'a'));
    close(facing(world(s, 'a')), [0, 0, -1]);
  });

  it('aiming at your own child aims at where you hold it, and the child hangs from the aim', () => {
    let s = cube(cube(buildDefaultDagState(), 'p', [0, 0, 0]), 'k', [2, 0, 0]);
    s = run(s, [...aim('p', 'ttp', 'k'), wire('p', 'world', 'k', 'parent')]);
    close(facing(world(s, 'p')), [1, 0, 0]);
    close(position(world(s, 'k')), [0, 0, 2]);
  });

  it('is named by referenceCycles, the way the graph reports a loop', () => {
    let s = cube(cube(buildDefaultDagState(), 'a', [1, 0, 0]), 'b', [3, 3, 0]);
    s = run(s, [
      ...aim('a', 'tta', 'b'),
      ...aim('b', 'ttb', 'a'),
      { type: 'setParam', nodeId: 'tta', paramPath: 'target', value: 'a' },
      { type: 'setParam', nodeId: 'ttb', paramPath: 'target', value: 'b' },
    ]);
    expect(referenceCycles(s).flat()).toEqual(expect.arrayContaining(['tta', 'ttb']));
  });
});

describe('an aim with no loop is untouched', () => {
  it('a reference aims like a wire, through the parent\x27s aim', () => {
    let s = cube(
      cube(cube(buildDefaultDagState(), 'p', [0, 0, 0]), 'k', [2, 0, 0]),
      'o',
      [0, 0, 5],
    );
    // p aims along +X by reference, so its child at +X local swings. o aims at the child where it
    // really is, which a read passing p's aim through would get wrong.
    s = cube(s, 'x', [5, 0, 0]);
    s = run(s, [
      ...aim('p', 'ttp', 'x'),
      wire('p', 'world', 'k', 'parent'),
      ...aim('o', 'tto', 'k'),
    ]);
    const viaRef = world(s, 'o').toArray();
    const kid = new THREE.Vector3().setFromMatrixPosition(world(s, 'k'));
    close(position(world(s, 'k')), [0, 0, 2]);
    expect(kid.z).toBeCloseTo(2, 3);
    close(facing(world(s, 'o')), [0, 0, -1]);
    // The same aim by wire gives the same matrix.
    const wired = run(s, [
      { type: 'setParam', nodeId: 'tto', paramPath: 'aimNode', value: '' },
      wire('k', 'world', 'tto', 'aim'),
    ]);
    expect(world(wired, 'o').toArray()).toEqual(viaRef);
  });

  it('a wire on the aim wins over the reference', () => {
    let s = cube(
      cube(cube(buildDefaultDagState(), 'a', [0, 0, 0]), 'b', [3, 0, 0]),
      'c',
      [0, 3, 0],
    );
    s = run(s, [...aim('a', 'tta', 'b'), wire('c', 'world', 'tta', 'aim')]);
    close(facing(world(s, 'a')), [0, 1, 0]);
  });

  it('a loop of wires alone stays refused, and the refusal names the picker', () => {
    let s = cube(cube(buildDefaultDagState(), 'a', [0, 0, 0]), 'b', [1, 0, 0]);
    s = run(s, [...aim('a', 'tta', ''), ...aim('b', 'ttb', ''), wire('b', 'world', 'tta', 'aim')]);
    expect(() => run(s, [wire('a', 'world', 'ttb', 'aim')])).toThrow(/aim target/);
  });
});
