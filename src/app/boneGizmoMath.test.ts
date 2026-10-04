import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { boneDragLocal, boneGizmoSeed, memberDegrees } from './boneGizmoMath';
import type { PoseComponent } from './animate/poseTargetForBone';
import type { EulerOrder } from '../nodes/bonePose';

/** The drawn value of `component` in a member's units: what an override at weight 1 stores. */
function boneDragValue(
  component: PoseComponent,
  bone0: THREE.Matrix4,
  proxy0: THREE.Matrix4,
  proxy: THREE.Matrix4,
  parent: THREE.Matrix4,
  order: EulerOrder,
): readonly number[] {
  const local = boneDragLocal(bone0, proxy0, proxy, parent);
  return component === 'rotation' ? memberDegrees(local.quaternion, order) : local[component];
}
import { quatFromEuler } from '../nodes/bonePose';

const DEG = Math.PI / 180;
const trs = (p: number[], q: THREE.Quaternion, s = [1, 1, 1]) =>
  new THREE.Matrix4().compose(new THREE.Vector3(...p), q, new THREE.Vector3(...s));
const rot = (axis: number[], deg: number) =>
  new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis).normalize(), deg * DEG);

// A parent standing at (2, 0, 0), turned 90° about Z; the bone 1 along the parent's Y, turned 20°
// about its own X. Nothing is axis-aligned with the world, so a world/local mix-up shows.
const parent = trs([2, 0, 0], rot([0, 0, 1], 90));
const localQ = rot([1, 0, 0], 20);
const bone = parent.clone().multiply(trs([0, 1, 0], localQ));
const seed = boneGizmoSeed(bone);

describe('#1336 — the bone gizmo writes the bone’s local transform under its posed parent', () => {
  it('sits at the bone’s head, with the bone’s world rotation', () => {
    const p = new THREE.Vector3().setFromMatrixPosition(seed);
    expect([p.x, p.y, p.z].map((c) => +c.toFixed(9) + 0)).toEqual([1, 0, 0]);
  });

  it('a drag that has not moved writes what the bone already has', () => {
    expect(
      boneDragValue('position', bone, seed, seed, parent, 'ZYX').map((c) => +c.toFixed(9) + 0),
    ).toEqual([0, 1, 0]);
    expect(boneDragValue('rotation', bone, seed, seed, parent, 'ZYX')[0]).toBeCloseTo(20, 9);
    expect(
      boneDragValue('scale', bone, seed, seed, parent, 'ZYX').map((c) => +c.toFixed(9)),
    ).toEqual([1, 1, 1]);
  });

  it('a world rotation of the gizmo turns the bone about its head by exactly that, in its parent’s frame', () => {
    const delta = rot([0, 1, 1], 35);
    const proxy = trs(
      new THREE.Vector3().setFromMatrixPosition(seed).toArray(),
      delta.clone().multiply(new THREE.Quaternion().setFromRotationMatrix(seed)),
    );
    const v = boneDragValue('rotation', bone, seed, proxy, parent, 'ZYX');
    const q = quatFromEuler([v[0] * DEG, v[1] * DEG, v[2] * DEG], 'ZYX');
    const parentQ = rot([0, 0, 1], 90);
    const expected = parentQ.clone().invert().multiply(delta).multiply(parentQ).multiply(localQ);
    expect(Math.abs(new THREE.Quaternion(...q).dot(expected))).toBeCloseTo(1, 9);
    // The head does not move under a rotation.
    expect(
      boneDragValue('position', bone, seed, proxy, parent, 'ZYX').map((c) => +c.toFixed(9) + 0),
    ).toEqual([0, 1, 0]);
  });

  it('a world translation moves the head by that, read in the parent’s frame', () => {
    const proxy = seed.clone().premultiply(new THREE.Matrix4().makeTranslation(0, 0.5, 0));
    // The parent is turned +90° about Z, which takes its X onto world +Y: world +Y is its +X.
    expect(
      boneDragValue('position', bone, seed, proxy, parent, 'ZYX').map((c) => +c.toFixed(9) + 0),
    ).toEqual([0.5, 1, 0]);
  });

  it('a scale of the gizmo along its own Y scales the bone along the bone’s Y', () => {
    const proxy = seed.clone().multiply(new THREE.Matrix4().makeScale(1, 2, 1));
    expect(
      boneDragValue('scale', bone, seed, proxy, parent, 'ZYX').map((c) => +c.toFixed(9)),
    ).toEqual([1, 2, 1]);
  });
});
