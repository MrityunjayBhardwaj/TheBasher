// #1223 — a bone's local transform as the pose wire carries it: name, position, quaternion, scale.
//
// THREE-free on purpose (the node substrate never imports three), so the clip sampler, the pose
// nodes and the deform can all build and read a `BonePose` without the renderer. The euler helpers
// are three's own formulas for the 'XYZ' order (`Quaternion.setFromEuler`,
// `Euler.setFromRotationMatrix`), which is the order every `BoneSpec.rotation` and every clip key
// is stored in (`boneShape.ts` `boneWorldMatrices`); `bonePose.test.ts` pins them against three.
//
// REF: issue #1223; design "Bones as Channels" (the pose wire).

import type { BonePose, BoneSpec, ObjectValue, PosedSkeletonValue, Quat, Vec3 } from './types';

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

/**
 * #1224 — an armature Object's pose: the pose wired into it, or `null` when it has none or the
 * pose was made for a different rig. (#1203's `actionPoseOf`, which read an action clip.)
 *
 * A pose pairs index-for-index with the skeleton it was made against, so it can only pose a
 * skeleton whose bones are the same list. Blender binds an action to pose bones by NAME and leaves
 * an unmatched channel doing nothing; the index form cannot do that partially, so a pose whose bone
 * names differ from the Object's, anywhere, poses nothing rather than the wrong bones.
 */
export function armaturePoseOf(object: ObjectValue): PosedSkeletonValue | null {
  const { data, pose } = object;
  if (data?.kind !== 'Skeleton' || pose === undefined) return null;
  const own = data.bones;
  const made = pose.skeleton.bones;
  if (own.length !== made.length || own.some((bone, i) => bone.name !== made[i].name)) {
    return null;
  }
  return pose;
}

/**
 * #1240 — the euler orders a pose layer member can be keyed in, named as Blender names them (its
 * pose bones' and Objects' `rotation_mode`). Blender's order names the axes in the order they are
 * APPLIED, so its `XYZ` is three's `ZYX` and the reverse — measured on Blender 5.1.1 for all six
 * (`q1240_euler_orders.py`). This codebase's own euler, `BoneSpec.rotation` and every clip key, is
 * three's `XYZ`, which is Blender's `ZYX`.
 */
export const EULER_ORDERS = ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'] as const;
export type EulerOrder = (typeof EULER_ORDERS)[number];

/** A rotation as euler radians in Blender's `order`, as the quaternion it means. The six arms are
 *  three's `Quaternion.setFromEuler`, each under the three name its Blender order equals. */
export function quatFromEuler(e: Vec3, order: EulerOrder): Quat {
  const c1 = Math.cos(e[0] / 2);
  const c2 = Math.cos(e[1] / 2);
  const c3 = Math.cos(e[2] / 2);
  const s1 = Math.sin(e[0] / 2);
  const s2 = Math.sin(e[1] / 2);
  const s3 = Math.sin(e[2] / 2);
  switch (order) {
    case 'ZYX': // three XYZ
      return quatFromEulerXYZ(e);
    case 'ZXY': // three YXZ
      return [
        s1 * c2 * c3 + c1 * s2 * s3,
        c1 * s2 * c3 - s1 * c2 * s3,
        c1 * c2 * s3 - s1 * s2 * c3,
        c1 * c2 * c3 + s1 * s2 * s3,
      ];
    case 'YXZ': // three ZXY
      return [
        s1 * c2 * c3 - c1 * s2 * s3,
        c1 * s2 * c3 + s1 * c2 * s3,
        c1 * c2 * s3 + s1 * s2 * c3,
        c1 * c2 * c3 - s1 * s2 * s3,
      ];
    case 'XYZ': // three ZYX
      return [
        s1 * c2 * c3 - c1 * s2 * s3,
        c1 * s2 * c3 + s1 * c2 * s3,
        c1 * c2 * s3 - s1 * s2 * c3,
        c1 * c2 * c3 + s1 * s2 * s3,
      ];
    case 'XZY': // three YZX
      return [
        s1 * c2 * c3 + c1 * s2 * s3,
        c1 * s2 * c3 + s1 * c2 * s3,
        c1 * c2 * s3 - s1 * s2 * c3,
        c1 * c2 * c3 - s1 * s2 * s3,
      ];
    case 'YZX': // three XZY
      return [
        s1 * c2 * c3 - c1 * s2 * s3,
        c1 * s2 * c3 - s1 * c2 * s3,
        c1 * c2 * s3 + s1 * s2 * c3,
        c1 * c2 * c3 + s1 * s2 * s3,
      ];
  }
}
