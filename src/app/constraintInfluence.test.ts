// #1783 — constraints blend by a keyable influence, as Blender 5.1.1's constraint Influence does.
// Measured in 5.1.1 (headless): a Track-To at influence f turns the object to
// slerp(rotation below, its full aim, f) to 6 places, 0.25 and 0.5 alike, own rotation or not; two
// stacked Track-Tos slerp in order (the second at 0.5 over the first at 1 is slerp(A, B, 0.5)); a
// Follow Path at f lerps the position: an empty at (0, 4, 0) at influence 0.5 on a path from the
// origin to (10, 0, 0) draws at (5, 4, 0); a second Follow Path (to (0, 0, 6)) at 0.5 over it,
// (10, 4, 3). Blender's world is Z-up and Basher's Y-up, so the rotation cases pin the relation
// Blender showed, not its raw numbers; the position ones carry over as they are.

import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyOp, __resetRegistryForTests } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { withIds } from '../test-utils/curvePoints';
import { makeSplitCube } from '../test-utils/splitCube';
import { resolveConstraintRotation, resolveFollowedWorldPosition } from './nodeConstraints';
import { cameraFocusTargetDistance, resolveCameraPoseAt } from './activeCamera';

type Vec3 = [number, number, number];
const ctxAt = (seconds: number) => ({ time: { frame: seconds * 24, seconds, normalized: 0 } });
const OWN_ROT: Vec3 = [0, 30, 0];

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const run = (s: DagState, ops: object[]) => {
  for (const o of ops) s = applyOp(s, o as never).next;
  return s;
};
const quatOf = (deg: readonly number[]) =>
  new THREE.Quaternion().setFromEuler(
    new THREE.Euler(...(deg.map((d) => THREE.MathUtils.degToRad(d)) as Vec3), 'XYZ'),
  );
/** |dot|: 1 when two quaternions are one rotation. */
const same = (a: THREE.Quaternion, b: THREE.Quaternion) => Math.abs(a.dot(b));

/** A top-level cube `f` at the origin turned by `OWN_ROT`, with aim targets A (+X) and B (+Y side). */
function scene(): DagState {
  return makeSplitCube(buildDefaultDagState(), {
    objectId: 'f',
    position: [0, 0, 0],
    rotation: OWN_ROT,
    connectTo: { node: 'n_scene', socket: 'children' },
  }).state;
}
const trackTo = (
  id: string,
  aimPoint: Vec3,
  order: number,
  extra: Record<string, unknown> = {},
) => ({
  type: 'addNode',
  nodeId: id,
  nodeType: 'TrackTo',
  params: { target: 'f', aimNode: '', aimPoint, order, ...extra },
});
const A: Vec3 = [10, 0, 0];
const B: Vec3 = [0, 4, -10];
const drawnQ = (s: DagState, t = 0) => {
  const r = resolveConstraintRotation(s, 'f', ctxAt(t));
  return r ? quatOf(r) : quatOf(OWN_ROT);
};

describe('Track-To influence (#1783)', () => {
  it('influence 0.5: halfway by slerp from the own rotation to the full aim', () => {
    const full = drawnQ(run(scene(), [trackTo('ta', A, 0)]));
    const half = drawnQ(run(scene(), [trackTo('ta', A, 0, { influence: 0.5 })]));
    // The case discriminates: the full aim is far from the own rotation.
    expect(same(full, quatOf(OWN_ROT))).toBeLessThan(0.95);
    expect(same(half, quatOf(OWN_ROT).slerp(full, 0.5))).toBeCloseTo(1, 9);
    const quarter = drawnQ(run(scene(), [trackTo('ta', A, 0, { influence: 0.25 })]));
    expect(same(quarter, quatOf(OWN_ROT).slerp(full, 0.25))).toBeCloseTo(1, 9);
  });

  it('influence 0 is the same as muted: the own rotation, and no constraint result at all', () => {
    const s = run(scene(), [trackTo('ta', A, 0, { influence: 0 })]);
    expect(resolveConstraintRotation(s, 'f', ctxAt(0))).toBeNull();
  });

  it('influence 1 is exactly the aim it always was, byte for byte', () => {
    const before = resolveConstraintRotation(run(scene(), [trackTo('ta', A, 0)]), 'f', ctxAt(0));
    const one = resolveConstraintRotation(
      run(scene(), [trackTo('ta', A, 0, { influence: 1 })]),
      'f',
      ctxAt(0),
    );
    expect(one).toEqual(before);
  });

  it('two stacked: B at 0.5 over A at 1 is slerp(A, B, 0.5); both at 0.5 slerp in order', () => {
    const qA = drawnQ(run(scene(), [trackTo('ta', A, 0)]));
    const qB = drawnQ(run(scene(), [trackTo('tb', B, 0)]));
    const stacked = drawnQ(
      run(scene(), [trackTo('ta', A, 0), trackTo('tb', B, 1, { influence: 0.5 })]),
    );
    expect(same(stacked, qA.clone().slerp(qB, 0.5))).toBeCloseTo(1, 9);
    const halves = drawnQ(
      run(scene(), [
        trackTo('ta', A, 0, { influence: 0.5 }),
        trackTo('tb', B, 1, { influence: 0.5 }),
      ]),
    );
    const want = quatOf(OWN_ROT).slerp(qA, 0.5).slerp(qB, 0.5);
    expect(same(halves, want)).toBeCloseTo(1, 9);
  });

  it('a keyed influence hands over from A to B over the shot', () => {
    const s = run(scene(), [
      trackTo('ta', A, 0),
      trackTo('tb', B, 1, { influence: 0 }),
      {
        type: 'addNode',
        nodeId: 'tb_infl',
        nodeType: 'KeyframeChannelNumber',
        params: {
          name: 'influence',
          target: 'tb',
          paramPath: 'influence',
          keyframes: [
            { time: 0, value: 0, easing: 'linear' },
            { time: 2, value: 1, easing: 'linear' },
          ],
        },
      },
    ]);
    const qA = drawnQ(run(scene(), [trackTo('ta', A, 0)]));
    const qB = drawnQ(run(scene(), [trackTo('tb', B, 0)]));
    expect(same(drawnQ(s, 0), qA)).toBeCloseTo(1, 9);
    expect(same(drawnQ(s, 1), qA.clone().slerp(qB, 0.5))).toBeCloseTo(1, 9);
    expect(same(drawnQ(s, 2), qB)).toBeCloseTo(1, 9);
  });

  it('a camera blends the same way: halfway from its own rotation to its aim', () => {
    const cam = (extra: Record<string, unknown>) =>
      run(buildDefaultDagState(), [
        {
          type: 'addNode',
          nodeId: 'tc',
          nodeType: 'TrackTo',
          params: { target: 'n_camera', aimNode: '', aimPoint: [-6, 0, 2], ...extra },
        },
      ]);
    const own = new THREE.Quaternion(
      ...resolveCameraPoseAt(buildDefaultDagState(), 'n_camera', 0).quaternion,
    );
    const full = new THREE.Quaternion(...resolveCameraPoseAt(cam({}), 'n_camera', 0).quaternion);
    const half = new THREE.Quaternion(
      ...resolveCameraPoseAt(cam({ influence: 0.5 }), 'n_camera', 0).quaternion,
    );
    expect(same(full, own)).toBeLessThan(0.95);
    expect(same(half, own.clone().slerp(full, 0.5))).toBeCloseTo(1, 9);
    // At full influence the camera still looks AT its aim point.
    expect(resolveCameraPoseAt(cam({}), 'n_camera', 0).lookAt).toEqual([-6, 0, 2]);
  });
});

describe('a camera below full influence still names its target (review)', () => {
  const aimed = (influence: number) =>
    run(buildDefaultDagState(), [
      {
        type: 'addNode',
        nodeId: 'tc',
        nodeType: 'TrackTo',
        params: { target: 'n_camera', aimNode: '', aimPoint: [10, 4, -20], influence },
      },
    ]);
  const toAim = (s: DagState) => {
    const p = resolveCameraPoseAt(s, 'n_camera', 0).position;
    return Math.hypot(10 - p[0], 4 - p[1], -20 - p[2]);
  };

  it('focus-on-target measures to the aim point at 0.5 as at 1, with no jump just below 1', () => {
    for (const f of [1, 0.999, 0.5]) {
      const s = aimed(f);
      expect(cameraFocusTargetDistance(s, 'n_camera', 0), `influence ${f}`).toBeCloseTo(
        toAim(s),
        9,
      );
    }
  });

  it('the pose looks at the aim point (the reticle sits there) while its orientation is the blend', () => {
    const half = resolveCameraPoseAt(aimed(0.5), 'n_camera', 0);
    expect(half.lookAt).toEqual([10, 4, -20]);
    const full = resolveCameraPoseAt(aimed(1), 'n_camera', 0);
    expect(
      Math.abs(
        new THREE.Quaternion(...half.quaternion).dot(new THREE.Quaternion(...full.quaternion)),
      ),
    ).toBeLessThan(0.999);
  });
});

describe('Follow Path influence (#1783)', () => {
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
  const fp = (id: string, curve: string, order: number, influence?: number) => ({
    type: 'addNode',
    nodeId: id,
    nodeType: 'FollowPath',
    params: {
      target: 'f',
      curve,
      evalTime: 1,
      offset: 0,
      order,
      ...(influence === undefined ? {} : { influence }),
    },
  });
  const at = (s: DagState) => resolveFollowedWorldPosition(s, 'f', ctxAt(0));

  it('influence 0.5: halfway from the own position to the path, (5, 4, 0)', () => {
    const got = at(run(follower(), [...path('c1', [10, 0, 0]), fp('fp1', 'c1', 0, 0.5)]))!;
    [5, 4, 0].forEach((v, i) => expect(got[i]).toBeCloseTo(v, 9));
  });

  it('a second path at 0.5 over the first composes, then lerps: (10, 4, 3)', () => {
    const got = at(
      run(follower(), [
        ...path('c1', [10, 0, 0]),
        ...path('c2', [0, 0, 6]),
        fp('fp1', 'c1', 0),
        fp('fp2', 'c2', 1, 0.5),
      ]),
    )!;
    [10, 4, 3].forEach((v, i) => expect(got[i]).toBeCloseTo(v, 9));
  });

  it('influence 0: no constraint result; influence 1: the path result exactly', () => {
    expect(at(run(follower(), [...path('c1', [10, 0, 0]), fp('fp1', 'c1', 0, 0)]))).toBeNull();
    const absent = at(run(follower(), [...path('c1', [10, 0, 0]), fp('fp1', 'c1', 0)]));
    const one = at(run(follower(), [...path('c1', [10, 0, 0]), fp('fp1', 'c1', 0, 1)]));
    expect(one).toEqual(absent);
  });
});
