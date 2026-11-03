// #1770 — a Track-To's "up" follows its aim space, for a camera and a mesh alike. Blender 5.1.1,
// measured: a camera under a parent rotated (40°, 0°, 25°), Track To on a target — in World space
// its up keeps WORLD up (1.000 against 0.967 for the parent's), in Local space the PARENT's up
// (1.000 against 0.979). Before: a camera always kept the parent's up and a mesh always kept the
// world's, so each was wrong in one of the two spaces.

import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyOp, type DagState } from '../core/dag';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitCamera } from '../test-utils/splitCamera';
import { makeSplitCube } from '../test-utils/splitCube';
import { resolveCameraPoseAt } from './activeCamera';
import { resolveConstraintRotation } from './nodeConstraints';
import { resolveParentWorldMatrix } from './resolveWorldTransform';
import { clockedCtx } from './subjectClock';

beforeAll(() => registerAllNodes());

const PARENT_ROT: [number, number, number] = [40, 0, 25];
const CTX = clockedCtx(0, 0);

/** A tilted Group holding a camera `cam` and a cube `box2`, each aimed by a Track-To in `space`
 *  at a top-level target `tgt`. */
function rig(space: 'world' | 'parent'): DagState {
  let s = buildDefaultDagState();
  for (const op of [
    {
      type: 'addNode',
      nodeId: 'grp',
      nodeType: 'Group',
      params: { position: [1, 2, 0], rotation: PARENT_ROT },
    },
    {
      type: 'connect',
      from: { node: 'grp', socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    },
  ])
    s = applyOp(s, op as never).next;
  s = makeSplitCube(s, { objectId: 'tgt', position: [5, 1, -3] }).state;
  s = makeSplitCamera(s, {
    objectId: 'cam',
    position: [0, 0, 4],
    connectTo: { node: 'grp', socket: 'children' },
  }).state;
  s = makeSplitCube(s, {
    objectId: 'box2',
    position: [0, 0, 4],
    connectTo: { node: 'grp', socket: 'children' },
  }).state;
  for (const target of ['cam', 'box2'])
    s = applyOp(s, {
      type: 'addNode',
      nodeId: `tt_${target}`,
      nodeType: 'TrackTo',
      params: { target, aimNode: 'tgt', aimSpace: space, up: [0, 1, 0] },
    } as never).next;
  return s;
}

const parentQuat = (s: DagState, id: string) => {
  const q = new THREE.Quaternion();
  resolveParentWorldMatrix(s, id, CTX)!.decompose(new THREE.Vector3(), q, new THREE.Vector3());
  return q;
};

/** How well the object's up lines up with `ref`, both projected onto the plane facing the aim. */
function upAgreement(world: THREE.Quaternion, ref: THREE.Vector3): number {
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(world);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(world);
  const r = ref.clone().addScaledVector(dir, -ref.dot(dir)).normalize();
  return up.dot(r);
}

function orientations(space: 'world' | 'parent') {
  const s = rig(space);
  const pq = parentQuat(s, 'cam');
  const [x, y, z, w] = resolveCameraPoseAt(s, 'cam', 0).quaternion;
  const cam = new THREE.Quaternion(x, y, z, w);
  const local = resolveConstraintRotation(s, 'box2', CTX)!;
  const [ex, ey, ez] = local.map((d) => THREE.MathUtils.degToRad(d));
  const e = new THREE.Euler(ex, ey, ez, 'XYZ');
  const box = pq.clone().multiply(new THREE.Quaternion().setFromEuler(e));
  return {
    cam,
    box,
    worldUp: new THREE.Vector3(0, 1, 0),
    parentUp: new THREE.Vector3(0, 1, 0).applyQuaternion(pq),
  };
}

describe('#1770 — a Track-To’s up follows its aim space, as in Blender', () => {
  it('world space: camera and mesh keep WORLD up', () => {
    const o = orientations('world');
    for (const [name, q] of [
      ['camera', o.cam],
      ['mesh', o.box],
    ] as const) {
      expect(upAgreement(q, o.worldUp), `${name} vs world up`).toBeCloseTo(1, 9);
      // Control: the fixture's parent is tilted enough that the other reference disagrees.
      expect(upAgreement(q, o.parentUp), `${name} vs parent up`).toBeLessThan(0.999);
    }
  });

  it('parent space: camera and mesh keep the PARENT’s up', () => {
    const o = orientations('parent');
    for (const [name, q] of [
      ['camera', o.cam],
      ['mesh', o.box],
    ] as const) {
      expect(upAgreement(q, o.parentUp), `${name} vs parent up`).toBeCloseTo(1, 9);
      expect(upAgreement(q, o.worldUp), `${name} vs world up`).toBeLessThan(0.999);
    }
  });

  it('camera and mesh, aimed alike, face alike in both spaces', () => {
    for (const space of ['world', 'parent'] as const) {
      const o = orientations(space);
      expect(Math.abs(o.cam.dot(o.box)), space).toBeCloseTo(1, 9);
    }
  });
});
