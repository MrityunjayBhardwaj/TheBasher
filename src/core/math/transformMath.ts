// transformMath — the pure math behind the Transform nodes (#1784).
//
// A transform is a 4×4 matrix, stored as 16 numbers COLUMN-MAJOR (`m[col * 4 + row]`), the
// layout three.js uses for `Matrix4.elements`, so a value can cross into the renderer as it is.
// Rotations are Basher quaternions [x, y, z, w] (w last, as in quatMath.ts). Euler angles are
// DEGREES in three.js 'XYZ' order: the same convention an object's `rotation` param uses
// (resolveWorldTransform.ts builds `new THREE.Euler(rx, ry, rz, 'XYZ')` from it), so a rotation
// read out here can be written onto an object and mean the same orientation.
//
// No three.js import: node code stays THREE-free (see quatMath.ts), and this sits in core so
// both the nodes and the socket conversions (core/dag/socketConversion.ts) can use it without
// core reaching into the node layer. The test file cross-checks every function against three.js.
//
// Where Blender and three.js disagree, this follows Blender (5.1.1), because the nodes are
// Blender's matrix nodes:
//   - Transform Point is `3×3 · p + translation`: the bottom row is ignored, no divide by w
//     (BLI_math_matrix.hh `transform_point`). three's `applyMatrix4` divides by w.
//   - Transform Direction is `3×3 · d`, NOT normalised (`transform_direction`). three's
//     `transformDirection` normalises.
//   - Separating a mirrored transform (negative determinant) negates ALL THREE scale axes and
//     the rotation basis (`to_rot_scale<true>`). three's `decompose` negates X only.
//   - Separate goes matrix → Euler → quaternion (`to_loc_rot_scale_safe`), which stays
//     well-defined when the matrix carries shear.
//   - Invert fails only when the determinant is exactly 0 (Eigen `computeInverseWithCheck`
//     with threshold 0, math_matrix.cc `invert`); the node then outputs the identity.
//
// REF: ref/sources/blender-transform-nodes-v5.1.1/ (BLI_math_matrix.hh, math_matrix.cc,
//      node_fn_*_transform.cc); issue #1784.

/** Structurally the same tuples as `src/nodes/types.ts`'s, declared here so core math imports
 *  nothing from the node layer (the dependency points inward). */
export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

/** A 4×4 transform, column-major. */
export type Mat4 = readonly number[];

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export const IDENTITY_MAT4: Mat4 = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Whether `v` is a usable transform: 16 finite numbers. */
export function isMat4(v: unknown): v is Mat4 {
  return Array.isArray(v) && v.length === 16 && v.every((n) => typeof n === 'number');
}

/** Whether `v` is a quaternion-shaped value: 4 numbers. */
export function isQuat(v: unknown): v is Quat {
  return Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number');
}

/** translation · rotation · scale, as Blender's `from_loc_rot_scale` and three's `compose`. */
export function composeTransform(t: Vec3, q: Quat, s: Vec3): Mat4 {
  const [x, y, z, w] = q;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    t[0],
    t[1],
    t[2],
    1,
  ];
}

/** a · b: `b` applies first, then `a` (a point goes through b, then a). */
export function multiplyTransforms(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/** The inverse, or null when the determinant is exactly 0 (Blender's test). */
export function invertTransform(m: Mat4): Mat4 | null {
  const [n11, n21, n31, n41, n12, n22, n32, n42, n13, n23, n33, n43, n14, n24, n34, n44] = m;
  const t11 =
    n23 * n34 * n42 -
    n24 * n33 * n42 +
    n24 * n32 * n43 -
    n22 * n34 * n43 -
    n23 * n32 * n44 +
    n22 * n33 * n44;
  const t12 =
    n14 * n33 * n42 -
    n13 * n34 * n42 -
    n14 * n32 * n43 +
    n12 * n34 * n43 +
    n13 * n32 * n44 -
    n12 * n33 * n44;
  const t13 =
    n13 * n24 * n42 -
    n14 * n23 * n42 +
    n14 * n22 * n43 -
    n12 * n24 * n43 -
    n13 * n22 * n44 +
    n12 * n23 * n44;
  const t14 =
    n14 * n23 * n32 -
    n13 * n24 * n32 -
    n14 * n22 * n33 +
    n12 * n24 * n33 +
    n13 * n22 * n34 -
    n12 * n23 * n34;
  const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
  if (det === 0) return null;
  const d = 1 / det;
  return [
    t11 * d,
    (n24 * n33 * n41 -
      n23 * n34 * n41 -
      n24 * n31 * n43 +
      n21 * n34 * n43 +
      n23 * n31 * n44 -
      n21 * n33 * n44) *
      d,
    (n22 * n34 * n41 -
      n24 * n32 * n41 +
      n24 * n31 * n42 -
      n21 * n34 * n42 -
      n22 * n31 * n44 +
      n21 * n32 * n44) *
      d,
    (n23 * n32 * n41 -
      n22 * n33 * n41 -
      n23 * n31 * n42 +
      n21 * n33 * n42 +
      n22 * n31 * n43 -
      n21 * n32 * n43) *
      d,
    t12 * d,
    (n13 * n34 * n41 -
      n14 * n33 * n41 +
      n14 * n31 * n43 -
      n11 * n34 * n43 -
      n13 * n31 * n44 +
      n11 * n33 * n44) *
      d,
    (n14 * n32 * n41 -
      n12 * n34 * n41 -
      n14 * n31 * n42 +
      n11 * n34 * n42 +
      n12 * n31 * n44 -
      n11 * n32 * n44) *
      d,
    (n12 * n33 * n41 -
      n13 * n32 * n41 +
      n13 * n31 * n42 -
      n11 * n33 * n42 -
      n12 * n31 * n43 +
      n11 * n32 * n43) *
      d,
    t13 * d,
    (n14 * n23 * n41 -
      n13 * n24 * n41 -
      n14 * n21 * n43 +
      n11 * n24 * n43 +
      n13 * n21 * n44 -
      n11 * n23 * n44) *
      d,
    (n12 * n24 * n41 -
      n14 * n22 * n41 +
      n14 * n21 * n42 -
      n11 * n24 * n42 -
      n12 * n21 * n44 +
      n11 * n22 * n44) *
      d,
    (n13 * n22 * n41 -
      n12 * n23 * n41 -
      n13 * n21 * n42 +
      n11 * n23 * n42 +
      n12 * n21 * n43 -
      n11 * n22 * n43) *
      d,
    t14 * d,
    (n13 * n24 * n31 -
      n14 * n23 * n31 +
      n14 * n21 * n33 -
      n11 * n24 * n33 -
      n13 * n21 * n34 +
      n11 * n23 * n34) *
      d,
    (n14 * n22 * n31 -
      n12 * n24 * n31 -
      n14 * n21 * n32 +
      n11 * n24 * n32 +
      n12 * n21 * n34 -
      n11 * n22 * n34) *
      d,
    (n12 * n23 * n31 -
      n13 * n22 * n31 +
      n13 * n21 * n32 -
      n11 * n23 * n32 -
      n12 * n21 * n33 +
      n11 * n22 * n33) *
      d,
  ];
}

/** 3×3 · p + translation (Blender: no divide by w). */
export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** 3×3 · d (Blender: turned and scaled, not moved, not normalised). */
export function transformDirection(m: Mat4, d: Vec3): Vec3 {
  return [
    m[0] * d[0] + m[4] * d[1] + m[8] * d[2],
    m[1] * d[0] + m[5] * d[1] + m[9] * d[2],
    m[2] * d[0] + m[6] * d[1] + m[10] * d[2],
  ];
}

/** Euler angles (degrees, three 'XYZ') → quaternion, as three's `Quaternion.setFromEuler`. */
export function eulerToQuat(e: Vec3): Quat {
  const c1 = Math.cos((e[0] * DEG2RAD) / 2);
  const c2 = Math.cos((e[1] * DEG2RAD) / 2);
  const c3 = Math.cos((e[2] * DEG2RAD) / 2);
  const s1 = Math.sin((e[0] * DEG2RAD) / 2);
  const s2 = Math.sin((e[1] * DEG2RAD) / 2);
  const s3 = Math.sin((e[2] * DEG2RAD) / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

/** A pure-rotation 3×3 (inside a column-major 4×4) → Euler degrees, three 'XYZ'. */
function rotationMatrixToEuler(m: Mat4): Vec3 {
  const m11 = m[0];
  const m12 = m[4];
  const m13 = m[8];
  const m22 = m[5];
  const m23 = m[9];
  const m32 = m[6];
  const m33 = m[10];
  const y = Math.asin(Math.min(Math.max(m13, -1), 1));
  let x: number;
  let z: number;
  if (Math.abs(m13) < 0.9999999) {
    x = Math.atan2(-m23, m33);
    z = Math.atan2(-m12, m11);
  } else {
    x = Math.atan2(m32, m22);
    z = 0;
  }
  return [x * RAD2DEG, y * RAD2DEG, z * RAD2DEG];
}

/** Quaternion → Euler degrees, three 'XYZ' (three's `Euler.setFromQuaternion`). */
export function quatToEuler(q: Quat): Vec3 {
  return rotationMatrixToEuler(composeTransform([0, 0, 0], q, [1, 1, 1]));
}

export interface SeparatedTransform {
  readonly translation: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
}

/**
 * translation, rotation and scale back out of a transform — Blender's `to_loc_rot_scale_safe`
 * with negative scale allowed: column lengths are the scale; a mirrored basis (negative
 * determinant) negates the basis and all three scales; the rotation goes through Euler so a
 * sheared matrix still gives a rotation. A zero-length column stays zero (no NaN).
 */
export function separateTransform(m: Mat4): SeparatedTransform {
  const cols = [0, 4, 8].map((o) => [m[o], m[o + 1], m[o + 2]]);
  let scale = cols.map((c) => Math.hypot(c[0], c[1], c[2]));
  let basis = cols.map((c, i) => (scale[i] === 0 ? c : c.map((v) => v / scale[i])));
  const det =
    basis[0][0] * (basis[1][1] * basis[2][2] - basis[1][2] * basis[2][1]) -
    basis[1][0] * (basis[0][1] * basis[2][2] - basis[0][2] * basis[2][1]) +
    basis[2][0] * (basis[0][1] * basis[1][2] - basis[0][2] * basis[1][1]);
  if (det < 0) {
    basis = basis.map((c) => c.map((v) => -v));
    scale = scale.map((v) => -v);
  }
  const r: Mat4 = [...basis[0], 0, ...basis[1], 0, ...basis[2], 0, 0, 0, 0, 1];
  return {
    translation: [m[12], m[13], m[14]],
    rotation: eulerToQuat(rotationMatrixToEuler(r)),
    scale: [scale[0], scale[1], scale[2]],
  };
}

export interface PolarParts {
  readonly translation: Vec3;
  /** The pure rotation nearest the transform's 3×3. */
  readonly rotation: Quat;
  /** What is left once the rotation is out: scale and shear, as a transform with no translation. */
  readonly stretch: Mat4;
}

type V3 = [number, number, number];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * A transform's 3×3 as rotation × stretch, the polar decomposition Blender blends by
 * (`interp_m3_m3m3`, `mat3_polar_decompose`). Separating into a scale VECTOR cannot hold what a
 * non-uniformly scaled parent leaves in a child's world, so the stretch stays a matrix and
 * rotation × stretch rebuilds the 3×3 whatever it holds.
 *
 * The rotation comes from a one-sided Jacobi SVD (A = UΣVᵀ, rotation = UVᵀ). A mirrored 3×3 negates
 * the whole rotation, as `separateTransform` does. A singular one completes the missing directions
 * of U; an all-zero one reads as the identity rotation. None of them yield a NaN.
 */
export function polarSplit(m: Mat4): PolarParts {
  const cols: V3[] = [0, 4, 8].map((o) => [m[o], m[o + 1], m[o + 2]]);
  const v: V3[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 30; sweep++) {
    let rotated = false;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      const alpha = dot3(cols[p], cols[p]);
      const beta = dot3(cols[q], cols[q]);
      const gamma = dot3(cols[p], cols[q]);
      if (Math.abs(gamma) <= 1e-15 * Math.sqrt(alpha * beta) || gamma === 0) continue;
      rotated = true;
      const zeta = (beta - alpha) / (2 * gamma);
      const t = (zeta >= 0 ? 1 : -1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
      const c = 1 / Math.sqrt(1 + t * t);
      const s = c * t;
      for (const w of [cols, v]) {
        const wp = w[p];
        const wq = w[q];
        w[p] = [c * wp[0] - s * wq[0], c * wp[1] - s * wq[1], c * wp[2] - s * wq[2]];
        w[q] = [s * wp[0] + c * wq[0], s * wp[1] + c * wq[1], s * wp[2] + c * wq[2]];
      }
    }
    if (!rotated) break;
  }
  const sigma = cols.map((c) => Math.sqrt(dot3(c, c)));
  const tiny = 1e-12 * Math.max(...sigma);
  const known = sigma.map((x) => x > tiny && x > 0);
  const u: V3[] = cols.map((c, i) => (known[i] ? (c.map((x) => x / sigma[i]) as V3) : [0, 0, 0]));
  const count = known.filter(Boolean).length;
  if (count === 1) {
    const i = known.indexOf(true);
    const a = u[i];
    const axis: V3 =
      Math.abs(a[0]) <= Math.abs(a[1]) && Math.abs(a[0]) <= Math.abs(a[2])
        ? [1, 0, 0]
        : Math.abs(a[1]) <= Math.abs(a[2])
          ? [0, 1, 0]
          : [0, 0, 1];
    const b = cross3(a, axis);
    const len = Math.sqrt(dot3(b, b));
    const j = (i + 1) % 3;
    const k = (i + 2) % 3;
    u[j] = b.map((x) => x / len) as V3;
    u[k] = cross3(a, u[j]);
  } else if (count === 2) {
    const k = known.indexOf(false);
    u[k] = cross3(u[(k + 1) % 3], u[(k + 2) % 3]);
  }
  // rotation = U·Vᵀ, column-major.
  const r: number[][] = [0, 1, 2].map((col) =>
    [0, 1, 2].map((row) => u[0][row] * v[0][col] + u[1][row] * v[1][col] + u[2][row] * v[2][col]),
  );
  const det = dot3(r[0] as V3, cross3(r[1] as V3, r[2] as V3));
  const rot = det < 0 ? r.map((c) => c.map((x) => -x)) : r;
  const rotation4: Mat4 = [...rot[0], 0, ...rot[1], 0, ...rot[2], 0, 0, 0, 0, 1];
  // stretch = rotationᵀ · A, so rotation × stretch is the 3×3 exactly.
  const a3: V3[] = [0, 4, 8].map((o) => [m[o], m[o + 1], m[o + 2]]);
  const stretchCol = (c: V3) => [
    dot3(rot[0] as V3, c),
    dot3(rot[1] as V3, c),
    dot3(rot[2] as V3, c),
    0,
  ];
  return {
    translation: [m[12], m[13], m[14]],
    rotation: eulerToQuat(rotationMatrixToEuler(rotation4)),
    stretch: [...stretchCol(a3[0]), ...stretchCol(a3[1]), ...stretchCol(a3[2]), 0, 0, 0, 1],
  };
}
