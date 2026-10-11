// Joint limits (#1344): how far a bone may turn from its rest, per axis.
//
// A limit lives on the bone (`BoneSpec.limits`), one place for everything that turns it: a pose
// layer hands on a pose inside the limits, and the IK solve stops a joint at them.
//
// The angle limited is the bone's rotation RELATIVE TO ITS REST, in its own axes, read as XYZ euler
// (the convention of the bone's `rotation` and `preferredAngle`). That is what Blender limits: its IK
// limits act on the pose channel's basis with the rest removed (`iksolver_plugin.cc:377-383`), and a
// Limit Rotation constraint in Local space clamps the same rotation per euler axis
// (`constraint.cc` `rotlimit_evaluate`). Houdini stores the rest with the limits for the same reason
// ("always applied from the same rest pose that they have been configured in", Configure Joint
// Limits).
//
// Measured in Blender 5.1.1 (two-bone rig, forearm limited to X in [-10°, 30°]):
//   - the limit set as an IK limit stops the IK solve at -10° and the tip falls short of the goal;
//   - the same IK limit does NOT clamp a rotation set by hand (80° draws as 80°);
//   - a Limit Rotation constraint does: 80° draws as 30°, a key curve plays clamped, and the stored
//     value stays 80° unless the constraint's Affect Transform is on.
// Here one limit does both jobs, as #1344 asks.
//
// One axis alone (a hinge) agrees with Blender's IK limit exactly. With several axes limited Blender's
// solver limits swing as an ellipse over X and Z and twist over Y (`IK_QSegment.cpp`
// `IK_QSphericalSegment::SetLimit`); this clamps each euler axis on its own, as its constraint does.
//
// REF: ref/sources/blender-pose-ik-v5.1.1/blenkernel_intern_constraint.cc (`clamp_angle`,
//      `rotlimit_evaluate`); ikplugin_intern_iksolver_plugin.cc; intern_iksolver_IK_QSegment.cpp;
//      ref/sources/houdini-kinefx-docs/kinefx--configurejointlimits.txt; issue #1344.

import { Quaternion } from 'three';
import { eulerXYZFromQuat, quatFromEulerXYZ } from './bonePose';
import type { BonePose, BoneSpec, Quat, Vec3 } from './types';

/** One axis's range, radians from rest: [min, max]. */
export type AxisLimit = readonly [number, number];

/** A bone's limits: an axis that is present is limited. */
export interface JointLimits {
  readonly x?: AxisLimit;
  readonly y?: AxisLimit;
  readonly z?: AxisLimit;
}

export const LIMIT_AXES = ['x', 'y', 'z'] as const;

const TAU = Math.PI * 2;
/** Into [-π, π]. */
const wrap = (a: number) => {
  const w = (((a + Math.PI) % TAU) + TAU) % TAU;
  return w - Math.PI;
};

/**
 * `angle` brought into [min, max], treating angles as points on a circle: outside the range it goes
 * to the nearer end the short way round, so a range that spans ±180° does not flip. Blender's
 * `clamp_angle`.
 */
export function clampAngle(angle: number, min: number, max: number): number {
  if (angle >= min && angle <= max) return angle;
  if (max <= min) return min;
  const lo = wrap(min - angle);
  const hi = wrap(max - angle);
  if (lo < hi) return angle + Math.min(Math.max(0, lo), hi);
  if (hi >= 0 || lo <= 0) return angle;
  return Math.abs(hi) < Math.abs(lo) ? angle + hi : angle + lo;
}

const _rest = new Quaternion();
const _q = new Quaternion();

/**
 * `quaternion` (the bone's local rotation, as on the pose wire) with its turn from rest brought
 * inside the bone's limits. The SAME array when nothing was outside, so a caller can tell.
 */
export function clampToLimits(bone: BoneSpec, quaternion: Quat): Quat {
  const limits = bone.limits;
  if (!limits) return quaternion;
  const rest = quatFromEulerXYZ(bone.rotation);
  _rest.set(rest[0], rest[1], rest[2], rest[3]);
  _q.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]).premultiply(
    _rest.clone().invert(),
  );
  const turned = eulerXYZFromQuat([_q.x, _q.y, _q.z, _q.w]);
  const held = [turned[0], turned[1], turned[2]] as [number, number, number];
  let outside = false;
  LIMIT_AXES.forEach((axis, i) => {
    const range = limits[axis];
    if (!range) return;
    const to = clampAngle(turned[i], range[0], range[1]);
    if (to !== turned[i]) {
      held[i] = to;
      outside = true;
    }
  });
  if (!outside) return quaternion;
  const back = quatFromEulerXYZ(held as Vec3);
  _q.set(back[0], back[1], back[2], back[3]).premultiply(_rest);
  return [_q.x, _q.y, _q.z, _q.w];
}

/** The bones of `bones` that carry a limit, by index. */
export function limitedBones(bones: readonly BoneSpec[]): number[] {
  const out: number[] = [];
  bones.forEach((b, i) => {
    if (b.limits && LIMIT_AXES.some((a) => b.limits![a] !== undefined)) out.push(i);
  });
  return out;
}

/**
 * `pose` with every limited bone inside its limits. The SAME array when none was outside (and a
 * skeleton without limits costs one empty loop).
 */
export function clampPoseToLimits(
  bones: readonly BoneSpec[],
  pose: readonly BonePose[],
  limited: readonly number[],
): readonly BonePose[] {
  let out: BonePose[] | null = null;
  for (const i of limited) {
    const at = pose[i];
    if (!at) continue;
    const held = clampToLimits(bones[i], at.quaternion);
    if (held === at.quaternion) continue;
    out ??= pose.slice();
    out[i] = { ...at, quaternion: held };
  }
  return out ?? pose;
}

/** Why `limits` cannot be stored, or null. */
export function limitsProblem(limits: JointLimits): string | null {
  for (const axis of LIMIT_AXES) {
    const range = limits[axis];
    if (!range) continue;
    if (!(range[0] <= range[1])) return `the ${axis} limit's minimum is above its maximum`;
    if (range[0] < -Math.PI || range[1] > Math.PI) {
      return `the ${axis} limit reaches past a half turn from rest`;
    }
  }
  return null;
}
