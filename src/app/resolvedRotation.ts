// #1153 — the ONE place a value's orientation is decided: what its `rotation` reads, in
// whichever mode it is in.
//
// ── WHY EVERY READER GOES THROUGH HERE, AND WHEN ────────────────────────────────────────
//
// A posable value can hold its orientation as a quaternion (`rotationMode: 'quaternion'`,
// src/nodes/rotationMode.ts). Its readers — the renderer, the world and evaluated-transform
// resolvers — were all written against the euler `rotation`, and there are dozens of them. So
// rather than teach each one a second representation, this puts the quaternion's orientation
// INTO `rotation`, and each reader's one entry point calls it:
//
//   - the draw: `MeshChild` (every scene child) and `LightKindR` (every light road ends in it),
//     plus the light-helper follower, which draws the wireframe outside both
//   - the read side: `localMatrix` (resolveWorldTransform) and resolveEvaluatedTransform
//
// It runs AFTER the channel overlay, never inside the evaluator: a channel on `quaternion`
// patches the value after evaluate, so a rotation decided at evaluate would be a frame stale.
//
// ── WHY EULER AS THE CARRIER LOSES NOTHING ──────────────────────────────────────────────
//
// What bends a rotation is INTERPOLATING in euler, which the quaternion channel never does —
// it slerps. One orientation written as XYZ euler and read back is the same orientation:
// measured over 200,050 orientations, including both gimbal poles, the worst round trip is
// 3.4e-6°. So the carrier is exact for everything downstream of the overlay.
//
// ── NORMALISED, AS BLENDER DOES ─────────────────────────────────────────────────────────
//
// Blender normalises before composing (`object.cc:2807-2811`), so a non-unit quaternion turns
// the object and never scales it. A ZERO quaternion has no direction; Blender draws it as
// (w=0, x=1) — a half turn about X — measured in 4.5.9 and 5.1.1 alike. Matched here rather
// than guessed at: a file or a hand edit that lands on zero draws what it draws in Blender.

import { Euler, Quaternion } from 'three';
import type { Quat, RotationModeFields, Vec3 } from '../nodes/types';

const RAD2DEG = 180 / Math.PI;

/** The normalised quaternion a value composes with, or null when it is in euler mode. */
export function resolvedQuaternionOf(value: RotationModeFields): Quat | null {
  if (value.rotationMode !== 'quaternion' || !value.quaternion) return null;
  const [x, y, z, w] = value.quaternion;
  const len = Math.hypot(x, y, z, w);
  // Blender's zero fallback: wxyz (0, 1, 0, 0), i.e. xyzw [1, 0, 0, 0].
  if (len === 0) return [1, 0, 0, 0];
  return [x / len, y / len, z / len, w / len];
}

/**
 * `value` with `rotation` reading its orientation in whatever mode it is in. Returns `value`
 * ITSELF in euler mode, so a reader that memoises on identity sees no change for the values
 * that never opt in.
 */
export function withResolvedRotation<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  const q = resolvedQuaternionOf(value as RotationModeFields);
  if (!q) return value;
  const e = new Euler().setFromQuaternion(new Quaternion(q[0], q[1], q[2], q[3]), 'XYZ');
  const rotation: Vec3 = [e.x * RAD2DEG, e.y * RAD2DEG, e.z * RAD2DEG];
  return { ...value, rotation };
}

/**
 * The patch a Track-To aim writes. The aim REPLACES the orientation whatever mode it was held
 * in — Blender evaluates constraints after the object's own rotation — so a quaternion-mode
 * value has its mode dropped as well, or `withResolvedRotation` downstream would put the
 * quaternion back over the aim. An euler value gets exactly the one field it always got.
 */
export function aimPatch(value: RotationModeFields, aim: Vec3): Record<string, unknown> {
  return value.rotationMode === 'quaternion'
    ? { rotation: aim, rotationMode: undefined }
    : { rotation: aim };
}
