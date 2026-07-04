// #228 Slice D — "Set Origin to Geometry" math (Blender origin.rst, Origin to
// Geometry). A Group's origin is its `pivot`; the renderer applies
// T(position)·R·S·T(-pivot). Moving the origin to the geometry's centre WITHOUT
// moving the geometry means: put the new origin (which renders at `position`) at
// the centre, and compensate `pivot` so the content stays exactly where it was.
//
//   content_world = position + R·S·(c − pivot)            (top-level group)
//   keep it fixed while position → worldCentre:
//     newPivot = oldPivot + (R·S)⁻¹·(worldCentre − oldPosition)
//     newPosition = worldCentre
//
// Pure (deterministic from inputs) + unit-testable. THREE is used only for the
// rotation/scale inverse. v1 limit: correct for a top-level group (identity
// parent); a nested group's params are parent-local while the centre is world —
// a non-identity parent makes this approximate (#228 follow-up).

import * as THREE from 'three';
import { degVec3ToRad } from '../viewport/rotation';

type Vec3 = [number, number, number];

export interface GroupOriginParams {
  position: Vec3;
  rotation: Vec3; // degrees
  scale: Vec3;
  pivot: Vec3;
}

/** Given a group's current TRS+pivot and the world-space centre of its geometry,
 *  return the `position` + `pivot` that move the origin to that centre while
 *  leaving the geometry in place. */
export function originToGeometry(
  params: GroupOriginParams,
  worldCentre: Vec3,
): { position: Vec3; pivot: Vec3 } {
  const oldPos = new THREE.Vector3(...params.position);
  const oldPivot = new THREE.Vector3(...params.pivot);
  const [rx, ry, rz] = degVec3ToRad(params.rotation);
  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ'));
  const rs = new THREE.Matrix4().compose(
    new THREE.Vector3(0, 0, 0),
    quat,
    new THREE.Vector3(...params.scale),
  );
  // localDelta = (R·S)⁻¹ · (worldCentre − oldPosition). rs has zero translation,
  // so applyMatrix4 is the pure linear map.
  const localDelta = new THREE.Vector3(...worldCentre)
    .sub(oldPos)
    .applyMatrix4(rs.clone().invert());
  const newPivot = oldPivot.clone().add(localDelta);
  return {
    position: [worldCentre[0], worldCentre[1], worldCentre[2]],
    pivot: [newPivot.x, newPivot.y, newPivot.z],
  };
}
