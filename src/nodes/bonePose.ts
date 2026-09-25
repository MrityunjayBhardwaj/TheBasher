// #1223 — a bone's local transform as the pose wire carries it: name, position, quaternion, scale.
//
// THREE-free on purpose (the node substrate never imports three), so the clip sampler, the pose
// nodes and the deform can all build and read a `BonePose` without the renderer. The euler helpers
// are three's own formulas for the 'XYZ' order (`Quaternion.setFromEuler`,
// `Euler.setFromRotationMatrix`), which is the order every `BoneSpec.rotation` and every clip key
// is stored in (`boneShape.ts` `boneWorldMatrices`); `bonePose.test.ts` pins them against three.
//
// REF: issue #1223; design "Bones as Channels" (the pose wire).

import type { BonePose, BoneSpec, Quat, Vec3 } from './types';

/** A rotation stored as XYZ euler radians, as the quaternion it means. */
export function quatFromEulerXYZ(e: Vec3): Quat {
  const c1 = Math.cos(e[0] / 2);
  const c2 = Math.cos(e[1] / 2);
  const c3 = Math.cos(e[2] / 2);
  const s1 = Math.sin(e[0] / 2);
  const s2 = Math.sin(e[1] / 2);
  const s3 = Math.sin(e[2] / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

/** A unit quaternion as XYZ euler radians — the branch three picks, with y in [-π/2, π/2]. */
export function eulerXYZFromQuat(q: Quat): Vec3 {
  const [x, y, z, w] = q;
  const m11 = 1 - 2 * (y * y + z * z);
  const m12 = 2 * (x * y - w * z);
  const m13 = 2 * (x * z + w * y);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - w * x);
  const m32 = 2 * (y * z + w * x);
  const m33 = 1 - 2 * (x * x + y * y);
  const ry = Math.asin(Math.min(1, Math.max(-1, m13)));
  if (Math.abs(m13) < 0.9999999) {
    return [Math.atan2(-m23, m33), ry, Math.atan2(-m12, m11)];
  }
  return [Math.atan2(m32, m22), ry, 0];
}

/** A bone at rest, as a pose entry: its bind transform, scale 1 where the bone states none. */
export function restBonePose(bone: BoneSpec): BonePose {
  return {
    name: bone.name,
    position: bone.position,
    quaternion: quatFromEulerXYZ(bone.rotation),
    scale: bone.scale ?? [1, 1, 1],
  };
}
