// #1783 on the chain (#1811) — a constraint's influence is its step's blend: a Value feeds the three
// mixes, so the drawn result is the step's result mixed back toward what came up the chain, by
// slerp for the rotation and by lerp for the position (Blender 5.1.1's constraint Influence). The
// cases are the influence PR's, built here the chain's way: steps by `addStepOps`, influence by
// `setInfluenceOps`, keys on the blend's Value. Each editor's ops apply in order, as the chain
// editor's own tests apply them: its list already wires the step.

import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyOp, evaluate, __resetRegistryForTests } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { addStepOps, influenceOf, setInfluenceOps } from '../core/dag/chainEdit';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { withIds } from '../test-utils/curvePoints';
import { makeSplitCube } from '../test-utils/splitCube';
import { cameraFocusTargetDistance, resolveCameraPoseAt } from './activeCamera';

type Vec3 = [number, number, number];
const ctxAt = (seconds: number) => ({ time: { frame: seconds * 24, seconds, normalized: 0 } });

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const run = (s: DagState, ops: readonly object[] | null) => {
  expect(ops).not.toBeNull();
  for (const o of ops!) s = applyOp(s, o as never).next;
  return s;
};
const quatOf = (deg: readonly number[]) =>
  new THREE.Quaternion().setFromEuler(
    new THREE.Euler(...(deg.map((d) => THREE.MathUtils.degToRad(d)) as Vec3), 'XYZ'),
  );
/** |dot|: 1 when two quaternions are one rotation. */
const same = (a: THREE.Quaternion, b: THREE.Quaternion) => Math.abs(a.dot(b));
const worldOf = (s: DagState, id: string, t = 0) =>
  new THREE.Matrix4().fromArray(
    evaluate(s, id, { socket: 'world', ctx: ctxAt(t) }).value as number[],
  );
const drawnQ = (s: DagState, id: string, t = 0) => {
  const q = new THREE.Quaternion();
  worldOf(s, id, t).decompose(new THREE.Vector3(), q, new THREE.Vector3());
  return q;
};
const drawnP = (s: DagState, id: string, t = 0) =>
  new THREE.Vector3().setFromMatrixPosition(worldOf(s, id, t)).toArray();
const close = (got: number[], want: number[], digits = 6) =>
  want.forEach((v, i) => expect(got[i], `[${i}] of ${got}`).toBeCloseTo(v, digits));

const aimAt = (s: DagState, object: string, id: string, aimPoint: Vec3) =>
  run(s, addStepOps(s, object, id, 'TrackTo', { aimNode: '', aimPoint }));
const influence = (s: DagState, object: string, id: string, f: number, force = false) =>
  run(s, setInfluenceOps(s, object, id, f, force));

describe('Track-To influence on a chain (#1783)', () => {
  const OWN_ROT: Vec3 = [0, 30, 0];
  const A: Vec3 = [10, 0, 0];
  const B: Vec3 = [0, 4, -10];
  /** A top-level cube `f` at the origin turned by `OWN_ROT`. */
  const scene = () =>
    makeSplitCube(buildDefaultDagState(), {
      objectId: 'f',
      position: [0, 0, 0],
      rotation: OWN_ROT,
      connectTo: { node: 'n_scene', socket: 'children' },
    }).state;
  const qA = () => drawnQ(aimAt(scene(), 'f', 'ta', A), 'f');
  const qB = () => drawnQ(aimAt(scene(), 'f', 'tb', B), 'f');

  it('the premise: each aim turns the cube away from its own rotation', () => {
    expect(same(qA(), quatOf(OWN_ROT))).toBeLessThan(0.95);
    expect(same(qB(), qA())).toBeLessThan(0.95);
  });

  it('two stacked: B at 0.5 over A at 1 is slerp(A, B, 0.5); both at 0.5 slerp in order', () => {
    let s = aimAt(aimAt(scene(), 'f', 'ta', A), 'f', 'tb', B);
    s = influence(s, 'f', 'tb', 0.5);
    expect(same(drawnQ(s, 'f'), qA().slerp(qB(), 0.5))).toBeCloseTo(1, 9);

    let halves = aimAt(aimAt(scene(), 'f', 'ta', A), 'f', 'tb', B);
    halves = influence(influence(halves, 'f', 'ta', 0.5), 'f', 'tb', 0.5);
    const want = quatOf(OWN_ROT).slerp(qA(), 0.5).slerp(qB(), 0.5);
    expect(same(drawnQ(halves, 'f'), want)).toBeCloseTo(1, 9);
  });

  it('a keyed influence hands over from A to B over the shot', () => {
    let s = aimAt(aimAt(scene(), 'f', 'ta', A), 'f', 'tb', B);
    s = influence(s, 'f', 'tb', 0, true);
    const { nodeId } = influenceOf(s, 'f', 'tb') as { nodeId: string };
    s = run(s, [
      {
        type: 'addNode',
        nodeId: 'tb_infl',
        nodeType: 'KeyframeChannelNumber',
        params: {
          target: nodeId,
          paramPath: 'value',
          keyframes: [
            { time: 0, value: 0, easing: 'linear' },
            { time: 2, value: 1, easing: 'linear' },
          ],
        },
      },
    ]);
    expect(same(drawnQ(s, 'f', 0), qA())).toBeCloseTo(1, 9);
    expect(same(drawnQ(s, 'f', 1), qA().slerp(qB(), 0.5))).toBeCloseTo(1, 9);
    expect(same(drawnQ(s, 'f', 2), qB())).toBeCloseTo(1, 9);
  });
});

describe('Follow Path influence on a chain (#1783)', () => {
  const path = (id: string, to: Vec3) => [
    {
      type: 'addNode',
      nodeId: `${id}_data`,
      nodeType: 'CurveData',
      params: { points: withIds([[0, 0, 0], to]), closed: false, resolution: 32 },
    },
    { type: 'addNode', nodeId: id, nodeType: 'Object', params: {} },
    {
      type: 'connect',
      from: { node: `${id}_data`, socket: 'out' },
      to: { node: id, socket: 'data' },
    },
    {
      type: 'connect',
      from: { node: id, socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    },
  ];
  const follower = () =>
    makeSplitCube(buildDefaultDagState(), {
      objectId: 'f',
      position: [0, 4, 0],
      connectTo: { node: 'n_scene', socket: 'children' },
    }).state;
  const follow = (s: DagState, id: string, curve: string) =>
    run(s, addStepOps(s, 'f', id, 'FollowPath', { curve, evalTime: 1, offset: 0 }));

  it('a second path at 0.5 over the first composes, then lerps: (10, 4, 3)', () => {
    let s = run(follower(), [...path('c1', [10, 0, 0]), ...path('c2', [0, 0, 6])]);
    s = follow(follow(s, 'fp1', 'c1'), 'fp2', 'c2');
    s = influence(s, 'f', 'fp2', 0.5);
    close(drawnP(s, 'f'), [10, 4, 3]);
  });
});

describe('a camera below full influence (#1783)', () => {
  const AIM: Vec3 = [10, 4, -20];
  const aimed = (f: number) => {
    const s = aimAt(buildDefaultDagState(), 'n_camera', 'tc', AIM);
    return f === 1 ? s : influence(s, 'n_camera', 'tc', f);
  };
  const toAim = (s: DagState) => {
    const p = resolveCameraPoseAt(s, 'n_camera', 0).position;
    return Math.hypot(AIM[0] - p[0], AIM[1] - p[1], AIM[2] - p[2]);
  };

  it('blends halfway from its own rotation to its aim', () => {
    const own = new THREE.Quaternion(
      ...resolveCameraPoseAt(buildDefaultDagState(), 'n_camera', 0).quaternion,
    );
    const full = new THREE.Quaternion(...resolveCameraPoseAt(aimed(1), 'n_camera', 0).quaternion);
    const half = new THREE.Quaternion(...resolveCameraPoseAt(aimed(0.5), 'n_camera', 0).quaternion);
    expect(same(full, own)).toBeLessThan(0.95);
    expect(same(half, own.clone().slerp(full, 0.5))).toBeCloseTo(1, 6);
  });

  it('focus-on-target measures to the aim point at 0.5 as at 1, with no jump just below 1', () => {
    for (const f of [1, 0.999, 0.5]) {
      const s = aimed(f);
      expect(cameraFocusTargetDistance(s, 'n_camera', 0), `influence ${f}`).toBeCloseTo(
        toAim(s),
        6,
      );
    }
  });

  it('the pose looks at the aim point (the reticle sits there) while its orientation is the blend', () => {
    const half = resolveCameraPoseAt(aimed(0.5), 'n_camera', 0);
    close(half.lookAt as number[], AIM);
    const full = resolveCameraPoseAt(aimed(1), 'n_camera', 0);
    expect(
      Math.abs(
        new THREE.Quaternion(...half.quaternion).dot(new THREE.Quaternion(...full.quaternion)),
      ),
    ).toBeLessThan(0.999);
  });
});

describe('a light blends by its Track-To influence (#1783, #1765)', () => {
  const OWN: Vec3 = [-30, 20, 0];
  /** The default scene with the sun's own rotation `OWN` and its Track-To at `f`. */
  const sun = (f?: number) => {
    const s = run(buildDefaultDagState(), [
      { type: 'setParam', nodeId: 'n_light', paramPath: 'rotation', value: OWN },
    ]);
    return f === undefined ? s : influence(s, 'n_light', 'n_light_aim', f);
  };
  const drawn = (s: DagState) => drawnQ(s, 'n_light');

  it('the premise: the default sun is aimed by a Track-To on its chain, away from its own rotation', () => {
    expect(sun().nodes.n_light_aim?.type).toBe('TrackTo');
    expect(sun().nodes.n_light_aim?.inputs.in).toBeDefined();
    expect(same(drawn(sun()), quatOf(OWN))).toBeLessThan(0.95);
  });

  it('influence 0: the sun shines down its own rotation', () => {
    expect(same(drawn(sun(0)), quatOf(OWN))).toBeCloseTo(1, 9);
  });

  it('influence 0.5: halfway from its own rotation to the aim, by slerp', () => {
    expect(same(drawn(sun(0.5)), quatOf(OWN).slerp(drawn(sun()), 0.5))).toBeCloseTo(1, 9);
  });

  it('influence 1 is exactly the aim it always was', () => {
    expect(drawn(sun(1)).toArray()).toEqual(drawn(sun()).toArray());
  });
});
