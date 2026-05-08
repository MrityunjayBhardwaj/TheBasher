// Rotation unit conversion helpers.
//
// Convention: DAG `params.rotation` (and any vec3 user-facing rotation field)
// is stored in DEGREES. THREE.js Euler / Object3D.rotation is RADIANS.
// Convert at the seam — never inside the evaluator (V2 purity), never in the
// agent's tool args (the agent thinks in degrees, like the user).
//
// This matches Blender / Maya / Unity / Unreal: degrees in the UI + storage,
// radians under the hood. See AGENT.md §6 for why this convention matters.
//
// REF: H20 (rotation units mismatch).

import * as THREE from 'three';

export type Vec3 = readonly [number, number, number];

/** Convert a degree-vec3 (DAG storage) to radians (THREE Euler). */
export function degVec3ToRad(v: Vec3): [number, number, number] {
  return [
    THREE.MathUtils.degToRad(v[0]),
    THREE.MathUtils.degToRad(v[1]),
    THREE.MathUtils.degToRad(v[2]),
  ];
}

/** Convert a radian-vec3 (THREE Euler) to degrees (DAG storage). */
export function radVec3ToDeg(v: Vec3): [number, number, number] {
  return [
    THREE.MathUtils.radToDeg(v[0]),
    THREE.MathUtils.radToDeg(v[1]),
    THREE.MathUtils.radToDeg(v[2]),
  ];
}
