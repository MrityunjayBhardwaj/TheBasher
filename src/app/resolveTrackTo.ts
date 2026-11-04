// resolveTrackTo — the ONE pure aim resolver (epic #201, slice #204). Given an
// object's WORLD position and a target WORLD position, return the Euler rotation
// (DEGREES, the DAG storage unit) that orients the object's -Z axis toward the
// target with +Y up. This is the Track-To constraint's math core and the
// generalization of the camera's intrinsic `lookAt` ([[V56]]) — the camera
// migrates onto this in a follow-on increment (the dogfood proof).
//
// WHY a -Z/+Y default: three.js `Matrix4.lookAt(eye, target, up)` builds a basis
// whose -Z column points from eye toward target (the camera convention), so using
// it as an object's rotation makes -Z face the target — identical to the camera's
// `Object3D.lookAt` and to Blender's Track-To default (Track: -Z, Up: Y). Keeping
// ONE convention lets the same resolver drive meshes, lights, AND the camera
// (the camera migration is byte-compatible). A per-axis Track/Up enum is a v1+
// follow-up (north star ≠ v1 scope, [[V58]]).
//
// PURE: a function of (objPos, targetPos, up). THREE is used only as matrix math
// (no scene-graph read, no React). The relationship is DERIVED from positions
// every call — never a stored/baked rotation kept in sync ([[V58]]).
//
// REF: epic #201, docs/OPERATORS-AND-LIGHTING-DESIGN.md §4.1; vyapti V58/V56/V37.

import * as THREE from 'three';

type Vec3 = [number, number, number];

const DEFAULT_UP: Vec3 = [0, 1, 0];
/** Below this object↔target distance the aim is undefined (the basis degenerates);
 *  return null so the caller keeps the object's authored rotation. */
const DEGENERATE_EPS = 1e-6;

const _eye = new THREE.Vector3();
const _target = new THREE.Vector3();
const _up = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _e = new THREE.Euler();
const _dir = new THREE.Vector3();
const _roll = new THREE.Quaternion();

/**
 * #1760 — the aim as a quaternion: the orientation turning an object at `objPos` so its -Z faces
 * `targetPos` with `up` as the roll reference, then rolled `rollDeg` about the aim. Null when the
 * two coincide. {@link resolveTrackTo} is this as XYZ euler degrees; a camera, which carries its
 * orientation as a quaternion, takes it as is. The returned quaternion is a fresh object.
 */
export function trackToQuaternion(
  objPos: Vec3,
  targetPos: Vec3,
  up: Vec3 = DEFAULT_UP,
  rollDeg = 0,
): THREE.Quaternion | null {
  _eye.set(objPos[0], objPos[1], objPos[2]);
  _target.set(targetPos[0], targetPos[1], targetPos[2]);
  if (_eye.distanceToSquared(_target) < DEGENERATE_EPS * DEGENERATE_EPS) return null;
  _up.set(up[0], up[1], up[2]);
  // Matrix4.lookAt builds a rotation whose -Z column points eye→target (camera
  // convention) → using it as the object's rotation aims -Z at the target.
  _m.lookAt(_eye, _target, _up);
  const q = new THREE.Quaternion().setFromRotationMatrix(_m);
  // #1759 — roll about the aim axis, the way a camera rolls (`cameraOrientationQuat`): rotating
  // the whole basis about eye → target. No roll leaves the aim untouched.
  if (rollDeg !== 0 && Number.isFinite(rollDeg)) {
    _dir.subVectors(_target, _eye).normalize();
    q.premultiply(_roll.setFromAxisAngle(_dir, THREE.MathUtils.degToRad(rollDeg)));
  }
  return q;
}

const _pq = new THREE.Quaternion();
const _pp = new THREE.Vector3();
const _ps = new THREE.Vector3();

/**
 * #1770 — a Track-To's `up`, in the frame an aim is computed in. The up vector is read in the
 * Track-To's own space, as Blender reads it (5.1.1, measured: World space keeps world up, Local
 * space the parent's): `aimSpace` 'world' → the world's +Y, 'parent' → the parent's. A road that
 * aims in the world (`frame` 'world', the mesh fold) lifts a parent-space up by the parent's
 * rotation; one that aims in the parent's frame (`frame` 'parent', the camera) brings a world-space
 * up down into it. No parent (`parentWorld` null), or the two frames already the same → `up`.
 * The ONE rule both roads take, so a camera and a mesh aimed alike are banked alike.
 */
export function trackToUpIn(
  up: Vec3,
  aimSpace: 'world' | 'parent',
  frame: 'world' | 'parent',
  parentWorld: THREE.Matrix4 | null,
): Vec3 {
  if (!parentWorld || aimSpace === frame) return up;
  parentWorld.decompose(_pp, _pq, _ps);
  if (frame === 'parent') _pq.invert();
  const v = new THREE.Vector3(up[0], up[1], up[2]).applyQuaternion(_pq);
  return [v.x, v.y, v.z];
}

/**
 * The aim rotation (Euler XYZ, DEGREES) orienting an object at `objPos` so its
 * -Z faces `targetPos`, with `up` (default +Y) as the roll reference. Returns
 * null when object and target coincide (aim undefined) — the caller falls back to
 * the object's authored rotation.
 *
 * 'XYZ' Euler order matches the renderer's `rotation={degVec3ToRad(...)}` (three's
 * Object3D default), so the degrees this returns compose into the SAME world
 * matrix `resolveWorldTransform` / the render produce — render==read parity (V37).
 */
export function resolveTrackTo(
  objPos: Vec3,
  targetPos: Vec3,
  up: Vec3 = DEFAULT_UP,
  rollDeg = 0,
): Vec3 | null {
  const q = trackToQuaternion(objPos, targetPos, up, rollDeg);
  return q ? aimEulerDeg(q) : null;
}

/** An aim quaternion as the Euler XYZ degrees `resolveTrackTo` returns — the one conversion, so a
 *  blended aim (#1783) and an unblended one are written the same way. */
export function aimEulerDeg(q: THREE.Quaternion): Vec3 {
  _e.setFromQuaternion(q, 'XYZ');
  return [
    THREE.MathUtils.radToDeg(_e.x),
    THREE.MathUtils.radToDeg(_e.y),
    THREE.MathUtils.radToDeg(_e.z),
  ];
}
