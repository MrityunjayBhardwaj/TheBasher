// quatMath — pure quaternion helpers (xyzw), THREE-free (V32/V34: the node
// substrate never imports three). Lifted verbatim out of KeyframeChannelQuat's
// module-private helpers (#199-era slerp) so there is ONE slerp shared by the
// per-keyframe channel sampler AND the NLA layer-fold reducer (foldChannel.ts) —
// no drift between "slerp along a curve" and "slerp between two stacked layers"
// (H40 — one algebra, every consumer).
//
// Basher quaternions are [x, y, z, w] (w LAST — note Blender stores wxyz; the
// power below reads w at index 3). Callers pass NORMALIZED unit quats.
//
// REF: docs/NLA-DESIGN.md §2.1 I-5 (manifold rotation); vyapti V57; the ported
//      helpers are byte-identical to KeyframeChannelQuat's originals.

import type { Quat } from './types';

/** The rotation identity (no rotation): x=y=z=0, w=1. The COMBINE neutral
 *  reference for quaternion channels (I-4 — a full-influence layer over an empty
 *  stack reproduces the source because `qmul(id, q^1) === q`). */
export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

export function dot(a: Quat, b: Quat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

export function neg(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], -q[3]];
}

export function normalize(q: Quat): Quat {
  const len = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  if (len === 0) return [0, 0, 0, 1];
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

/** Slerp a→b at u∈[0,1]. Picks the shortest arc by negating b when dot<0. */
export function slerp(a: Quat, b: Quat, u: number): Quat {
  let d = dot(a, b);
  let bb: Quat = b;
  if (d < 0) {
    bb = neg(b);
    d = -d;
  }
  // Use lerp+normalize when nearly parallel — slerp degenerates to 0/0.
  if (d > 0.9995) {
    return normalize([
      a[0] + (bb[0] - a[0]) * u,
      a[1] + (bb[1] - a[1]) * u,
      a[2] + (bb[2] - a[2]) * u,
      a[3] + (bb[3] - a[3]) * u,
    ]);
  }
  const theta = Math.acos(d);
  const sinTheta = Math.sin(theta);
  const wA = Math.sin((1 - u) * theta) / sinTheta;
  const wB = Math.sin(u * theta) / sinTheta;
  return [
    a[0] * wA + bb[0] * wB,
    a[1] * wA + bb[1] * wB,
    a[2] * wA + bb[2] * wB,
    a[3] * wA + bb[3] * wB,
  ];
}

/** Hamilton product a⊗b (both xyzw). Composes two rotations: the result applies
 *  b then a. Used by the COMBINE-rotation fold `lower ⊗ strip^influence` (I-5;
 *  Blender `nla_combine_quaternion` = `mul_qt_qtqt(lower, upper^inf)`). */
export function qmul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Raise a unit quaternion to a scalar power `t` — the rotation scaled to a
 *  fraction of its angle. For unit quats `q^t === slerp(identity, q, t)` on the
 *  shortest arc, so we reuse the proven slerp rather than re-deriving the
 *  axis-angle power (Blender `pow_qt_fl_normalized`). This is the COMBINE
 *  rotation contribution before it is `qmul`'d onto the lower stack (I-5). */
export function qpow(q: Quat, t: number): Quat {
  return slerp(IDENTITY_QUAT, q, t);
}
