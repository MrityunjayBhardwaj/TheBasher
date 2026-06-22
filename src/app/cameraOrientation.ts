// cameraOrientation — the ONE pure mapping between a camera's authored aim
// params (position + lookAt point + roll°) and its world-space orientation
// quaternion, plus the inverse. (#229)
//
// Basher cameras aim via a lookAt POINT (not an Euler rotation, V56), with roll
// banking the otherwise-implicit world-+Y up about the view axis. EVERY surface
// that turns a camera pose into an oriented camera — the viewport look-through
// (`EditorViewCamera.applyView`), the frustum helper (`CameraHelpers`), the
// still + animation render (`renderToImage.buildRenderCamera`), and the camera
// world-transform seam (`resolveWorldTransform.cameraWorldMatrix`) — derives that
// orientation HERE, so render == viewport == helper at any roll (the V37/V56 one
// band). The gizmo (#229) manipulates the camera in world orientation and writes
// back authored lookAt+roll through the INVERSE (`lookAtRollFromQuat`) — the V68
// "manipulate in render space, store authored params" round-trip for cameras.
//
// Pure (THREE math only, no DAG / React / store) → unit-testable, and a leaf
// module so resolveWorldTransform can import it without the activeCamera cycle.
//
// REF: vyapti V56 (camera pose authority), V68 (manipulator round-trip), V37/H40
// (one band). Issue #229.

import * as THREE from 'three';

const LOCAL_FORWARD = new THREE.Vector3(0, 0, -1); // three.js camera looks down -Z
const LOCAL_UP = new THREE.Vector3(0, 1, 0);
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Forward direction (unit) from position → lookAt, defaulting to -Z when the
 *  two coincide (degenerate aim) so callers never divide by zero. */
function aimDir(
  position: readonly [number, number, number],
  lookAt: readonly [number, number, number],
): THREE.Vector3 {
  const dir = new THREE.Vector3(
    lookAt[0] - position[0],
    lookAt[1] - position[1],
    lookAt[2] - position[2],
  );
  if (dir.lengthSq() === 0) dir.set(0, 0, -1);
  return dir.normalize();
}

/**
 * The camera's world orientation quaternion: its local -Z points along
 * (position → lookAt) with up derived from world +Y (three's `Matrix4.lookAt`
 * camera convention), then rolled by `rollDeg` about the view axis. Pure.
 */
export function cameraOrientationQuat(
  position: readonly [number, number, number],
  lookAt: readonly [number, number, number],
  rollDeg: number,
): THREE.Quaternion {
  const eye = new THREE.Vector3(position[0], position[1], position[2]);
  const target = new THREE.Vector3(lookAt[0], lookAt[1], lookAt[2]);
  // Matrix4.lookAt(eye, target, up) orients -Z toward target — the camera path of
  // Object3D.lookAt. setFromUnitVectors (the pre-#229 frustum math) gave a
  // twist-free arc whose up drifted from the rendered view; this matches it.
  const m = new THREE.Matrix4().lookAt(eye, target, WORLD_UP);
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  // Finite-guard: a partial/legacy pose may carry an undefined/NaN roll — treat
  // it as no-roll rather than poisoning the whole quaternion with NaN.
  if (Number.isFinite(rollDeg) && rollDeg !== 0) {
    const dir = aimDir(position, lookAt);
    // Roll about the WORLD view axis == roll about the camera's local -Z, so
    // premultiply rotates the whole basis about `dir`.
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(dir, THREE.MathUtils.degToRad(rollDeg)));
  }
  return q;
}

/**
 * Inverse of `cameraOrientationQuat`: recover the (lookAt point, roll°) a world
 * orientation quaternion implies, given the camera position and the aim distance
 * to keep (so the lookAt stays the same distance away). Used by the gizmo rotate
 * path — a drag yields a new world orientation, which becomes authored lookAt+roll.
 */
export function lookAtRollFromQuat(
  quat: THREE.Quaternion,
  position: readonly [number, number, number],
  distance: number,
): { lookAt: [number, number, number]; roll: number } {
  const forward = LOCAL_FORWARD.clone().applyQuaternion(quat).normalize();
  const dist = distance > 0 ? distance : 1;
  const lookAt: [number, number, number] = [
    position[0] + forward.x * dist,
    position[1] + forward.y * dist,
    position[2] + forward.z * dist,
  ];
  // roll = signed angle from the no-roll up to the quat's actual up, about forward.
  const noRollUp = LOCAL_UP.clone().applyQuaternion(cameraOrientationQuat(position, lookAt, 0));
  const actualUp = LOCAL_UP.clone().applyQuaternion(quat);
  let roll = THREE.MathUtils.radToDeg(noRollUp.angleTo(actualUp));
  if (new THREE.Vector3().crossVectors(noRollUp, actualUp).dot(forward) < 0) roll = -roll;
  return { lookAt, roll };
}
