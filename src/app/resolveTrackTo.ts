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
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

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
export function resolveTrackTo(objPos: Vec3, targetPos: Vec3, up: Vec3 = DEFAULT_UP): Vec3 | null {
  _eye.set(objPos[0], objPos[1], objPos[2]);
  _target.set(targetPos[0], targetPos[1], targetPos[2]);
  if (_eye.distanceToSquared(_target) < DEGENERATE_EPS * DEGENERATE_EPS) return null;
  _up.set(up[0], up[1], up[2]);
  // Matrix4.lookAt builds a rotation whose -Z column points eye→target (camera
  // convention) → using it as the object's rotation aims -Z at the target.
  _m.lookAt(_eye, _target, _up);
  _q.setFromRotationMatrix(_m);
  _e.setFromQuaternion(_q, 'XYZ');
  return [
    THREE.MathUtils.radToDeg(_e.x),
    THREE.MathUtils.radToDeg(_e.y),
    THREE.MathUtils.radToDeg(_e.z),
  ];
}
