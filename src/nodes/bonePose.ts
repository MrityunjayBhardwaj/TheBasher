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

/**
 * #1242 — a unit quaternion as euler radians in Blender's `order`: the inverse of {@link quatFromEuler},
 * on the branch three picks (the middle angle in [-π/2, π/2]). The six arms are three's
 * `Euler.setFromRotationMatrix`, each under the three name its Blender order equals.
 */
export function eulerFromQuat(q: Quat, order: EulerOrder): Vec3 {
  const [x, y, z, w] = q;
  const m11 = 1 - 2 * (y * y + z * z);
  const m12 = 2 * (x * y - w * z);
  const m13 = 2 * (x * z + w * y);
  const m21 = 2 * (x * y + w * z);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - w * x);
  const m31 = 2 * (x * z - w * y);
  const m32 = 2 * (y * z + w * x);
  const m33 = 1 - 2 * (x * x + y * y);
  const clamp = (v: number) => Math.min(1, Math.max(-1, v));
  const EDGE = 0.9999999;
  switch (order) {
    case 'ZYX': // three XYZ
      return eulerXYZFromQuat(q);
    case 'ZXY': {
      // three YXZ
      const ex = Math.asin(-clamp(m23));
      return Math.abs(m23) < EDGE
        ? [ex, Math.atan2(m13, m33), Math.atan2(m21, m22)]
        : [ex, Math.atan2(-m31, m11), 0];
    }
    case 'YXZ': {
      // three ZXY
      const ex = Math.asin(clamp(m32));
      return Math.abs(m32) < EDGE
        ? [ex, Math.atan2(-m31, m33), Math.atan2(-m12, m22)]
        : [ex, 0, Math.atan2(m21, m11)];
    }
    case 'XYZ': {
      // three ZYX
      const ey = Math.asin(-clamp(m31));
      return Math.abs(m31) < EDGE
        ? [Math.atan2(m32, m33), ey, Math.atan2(m21, m11)]
        : [0, ey, Math.atan2(-m12, m22)];
    }
    case 'XZY': {
      // three YZX
      const ez = Math.asin(clamp(m21));
      return Math.abs(m21) < EDGE
        ? [Math.atan2(-m23, m22), Math.atan2(-m31, m11), ez]
        : [0, Math.atan2(m13, m33), ez];
    }
    case 'YZX': {
      // three XZY
      const ez = Math.asin(-clamp(m12));
      return Math.abs(m12) < EDGE
        ? [Math.atan2(m32, m22), Math.atan2(m13, m11), ez]
        : [Math.atan2(-m23, m33), 0, ez];
    }
  }
}

/**
 * #1242 — the other euler triple for the same rotation, in Blender's `order`: the FIRST and LAST
 * applied angles gain a half turn and the MIDDLE one becomes π − itself. The middle axis is the
 * order's second letter, so only for a Y-middle order (`XYZ`, `ZYX`) is this `(x+π, π−y, z+π)` —
 * the form `continuousEuler` (`threeAdapter.ts`) hard-codes for the clip reader's one order.
 * Proven for all six orders in `eulerOrders.test.ts`.
 */
export function flippedEuler(e: Vec3, order: EulerOrder): Vec3 {
  const middle = 'XYZ'.indexOf(order[1]);
  return [0, 1, 2].map((k) => (k === middle ? Math.PI - e[k] : e[k] + Math.PI)) as unknown as Vec3;
}

const TWO_PI = Math.PI * 2;

/**
 * #1242 — the triple for rotation `e` (radians, Blender's `order`) written nearest `prev`: whole turns
 * per axis, or the flipped triple plus whole turns, whichever lies closer. A representation change
 * only; the rotation is the same. Keys converted from quaternions go through this so a curve does
 * not jump 360° between two keys a degree apart.
 */
export function continuousEulerIn(e: Vec3, prev: Vec3 | null, order: EulerOrder): Vec3 {
  if (!prev) return e;
  const snap = (c: Vec3): Vec3 =>
    [0, 1, 2].map((k) => c[k] + TWO_PI * Math.round((prev[k] - c[k]) / TWO_PI)) as unknown as Vec3;
  const spread = (a: Vec3) =>
    Math.max(Math.abs(a[0] - prev[0]), Math.abs(a[1] - prev[1]), Math.abs(a[2] - prev[2]));
  const direct = snap(e);
  const flipped = snap(flippedEuler(e, order));
  return spread(flipped) < spread(direct) ? flipped : direct;
}
