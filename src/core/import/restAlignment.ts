// Reconciling two rest poses.
//
// The retarget's per-bone correction can only ever be a BONE-LOCAL rotation:
// `SkeletonUtils` composes `T_b(t) = W_b(t) · Q_b`, right-multiplying the source
// bone's world rotation by the offset (SkeletonUtils.js:127). That shape is
// exactly right for two rigs that hold the SAME rest pose with different
// bone-axis conventions, and it is silently wrong for two rigs whose rests are
// oriented differently — copying world rotations between bodies that face
// different ways moves a limb in the wrong plane. A forward arm raise on a rig
// facing +Z becomes a lateral raise on a rig facing +X, and no per-bone
// right-multiplication can repair it, because the error is a conjugation.
//
// So the whole-rig part is separated from the per-bone part and applied where it
// CAN be applied: rotate the source wrapper by R on the left, and carry R⁻¹ in
// the offsets on the right, giving
//
//     T_b(t) = R · W_b(t) · R⁻¹ · B_b
//
// — the source's motion re-expressed in the target's body frame, then applied to
// the target's own bind. At the source's rest (W = I) the target sits exactly at
// its bind, which is the identity case this construction is gated on.
//
// WHEN THIS IS AVAILABLE, AND WHY IT USUALLY IS NOT. A rest can only supply a
// body frame if its bones point in more than one direction. The clips this
// project receives today are exported against a rest that lays every bone on a
// single axis: the eigen-spread of its directions measures 0.947 / 0.053 / 0.000
// — a third dimension of exactly zero. There is no orientation to solve for, and
// `solveRestAlignment` returns null so the caller keeps the per-bone direction
// alignment that is correct for that case. A rest exported as a real T-pose
// measures 0.582 / 0.303 / 0.115 against the target bind's 0.571 / 0.300 / 0.129,
// and the disagreement between the two is very nearly one rotation.

import { Matrix4, Quaternion, Vector3, type Bone } from 'three';

const DEG = 180 / Math.PI;

/**
 * The rigid rotation carrying one rest onto another, with the evidence that it
 * is worth using. Angles are RMS over the mapped bones, in degrees.
 */
export interface RestAlignment {
  /** Carries SOURCE rest directions onto TARGET bind directions, in world. */
  readonly rotation: Quaternion;
  readonly disagreementBefore: number;
  readonly disagreementAfter: number;
}

/**
 * The rigid rotation must account for at least this much of the disagreement
 * between the two rests.
 *
 * Not a taste threshold — it separates two measured populations by a wide
 * margin. A T-pose rest against the live target goes 63.4° -> 17.2°, explaining
 * 73%. The degenerate rest, put through the identical solve, goes 93.4° -> 66.5°
 * and explains 29%, with an incoherent rotation (yaw -100.8°, pitch 15.5°, roll
 * 149.2°) — because a rank-1 direction set cannot be aligned to a
 * three-dimensional one and the solve returns whatever fit the residue best.
 * The bar sits in the middle of that gap and is scale-free, so it states a
 * relationship rather than an angle.
 */
export const MIN_EXPLAINED_FRACTION = 0.5;

/**
 * ...and what is left must be small enough to be per-bone anatomy rather than a
 * second orientation nobody solved for. An A-pose and a T-pose disagree by about
 * 45° at the shoulder and less everywhere else, so a rest pair whose residual
 * exceeds this is not two poses of the same kind.
 *
 * The two bounds catch different failures, which is why both are here: the
 * fraction rejects a solve that explained nothing, and this rejects one that
 * explained most of a disagreement that was enormous to begin with.
 */
export const MAX_RESIDUAL_DEGREES = 30;

/** Fewer pairs than this cannot pin a rotation with any confidence. */
export const MIN_PAIRS = 4;

/** A bone's world rotation, off a matrix the caller has already composed. */
function worldRotationOf(bone: Bone): Quaternion {
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  bone.matrixWorld.decompose(position, rotation, scale);
  return rotation;
}

/** The nearest descendant of `bone` that the map covers, or null at a chain end. */
function mappedChild(bone: Bone, covered: (name: string) => boolean): Bone | null {
  const stack = [...bone.children];
  while (stack.length > 0) {
    const next = stack.shift() as Bone;
    if (!next.isBone) continue;
    if (covered(next.name)) return next;
    stack.push(...(next.children as Bone[]));
  }
  return null;
}

/**
 * Where each mapped bone points, in WORLD. World rather than bone-local on
 * purpose: the two rigs disagree about every bone's local axes, and that
 * disagreement is precisely what the per-bone correction exists to absorb. A
 * whole-rig orientation is a statement about the world, so it has to be measured
 * there.
 */
function restDirectionsInWorld(
  bones: readonly Bone[],
  covered: (name: string) => boolean,
): Map<string, Vector3> {
  for (const bone of bones) {
    if (!bone.parent || !(bone.parent as Bone).isBone) bone.updateMatrixWorld(true);
  }
  const out = new Map<string, Vector3>();
  for (const bone of bones) {
    const child = mappedChild(bone, covered);
    if (!child) continue;
    const here = new Vector3().setFromMatrixPosition(bone.matrixWorld);
    const there = new Vector3().setFromMatrixPosition(child.matrixWorld);
    const delta = there.sub(here);
    if (delta.lengthSq() < 1e-18) continue;
    out.set(bone.name, delta.normalize());
  }
  return out;
}

/**
 * Eigenvalues of a symmetric 4x4, by cyclic Jacobi, returning the eigenvector for
 * the largest. Deterministic and exact to float precision — the alignment sits
 * under every retargeted clip, so it is solved rather than searched for.
 */
function largestEigenvector4(matrix: number[][]): number[] {
  const a = matrix.map((row) => [...row]);
  const v = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  for (let sweep = 0; sweep < 64; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p][q] * a[p][q];
    if (off < 1e-24) break;
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 4; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (a[i][i] > a[best][best]) best = i;
  return [v[0][best], v[1][best], v[2][best], v[3][best]];
}

/**
 * The rotation that best carries `from` onto `to` — Davenport's q-method: build
 * the profile matrix from the direction pairs, and the rotation is the
 * eigenvector of the largest eigenvalue of the symmetric 4x4 assembled from it.
 * Closed form, no seeding, no local minima.
 */
export function bestRigidRotation(from: readonly Vector3[], to: readonly Vector3[]): Quaternion {
  const b = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < from.length; i++) {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        b[r][c] += from[i].getComponent(r) * to[i].getComponent(c);
      }
    }
  }
  const trace = b[0][0] + b[1][1] + b[2][2];
  const z = [b[1][2] - b[2][1], b[2][0] - b[0][2], b[0][1] - b[1][0]];
  const s = [
    [b[0][0] * 2 - trace, b[0][1] + b[1][0], b[0][2] + b[2][0]],
    [b[1][0] + b[0][1], b[1][1] * 2 - trace, b[1][2] + b[2][1]],
    [b[2][0] + b[0][2], b[2][1] + b[1][2], b[2][2] * 2 - trace],
  ];
  const k = [
    [trace, z[0], z[1], z[2]],
    [z[0], s[0][0], s[0][1], s[0][2]],
    [z[1], s[1][0], s[1][1], s[1][2]],
    [z[2], s[2][0], s[2][1], s[2][2]],
  ];
  const e = largestEigenvector4(k);
  const q = new Quaternion(e[1], e[2], e[3], e[0]);
  if (q.lengthSq() < 1e-12) return new Quaternion();
  return q.normalize();
}

/** RMS angle between corresponding directions, in degrees, after `rotation`. */
function rmsDisagreement(
  from: readonly Vector3[],
  to: readonly Vector3[],
  rotation: Quaternion,
): number {
  let total = 0;
  for (let i = 0; i < from.length; i++) {
    const angle = from[i].clone().applyQuaternion(rotation).angleTo(to[i]) * DEG;
    total += angle * angle;
  }
  return Math.sqrt(total / from.length);
}

/**
 * Solve the whole-rig rotation between two rests, or return null when the two
 * rests do not correspond well enough for one to exist.
 *
 * Null is the ordinary answer for the clips this project receives today, and the
 * caller must keep its per-bone behaviour for that case — see the module note.
 */
export function solveRestAlignment(
  sourceBoneObjs: readonly Bone[],
  targetBoneObjs: readonly Bone[],
  targetToSource: Readonly<Record<string, string>>,
): RestAlignment | null {
  const sourceNames = new Set(Object.values(targetToSource));
  const sourceDirs = restDirectionsInWorld(sourceBoneObjs, (n) => sourceNames.has(n));
  const targetDirs = restDirectionsInWorld(targetBoneObjs, (n) => targetToSource[n] !== undefined);

  const from: Vector3[] = [];
  const to: Vector3[] = [];
  for (const [targetName, sourceName] of Object.entries(targetToSource)) {
    const s = sourceDirs.get(sourceName);
    const t = targetDirs.get(targetName);
    if (s && t) {
      from.push(s);
      to.push(t);
    }
  }
  if (from.length < MIN_PAIRS) return null;

  const rotation = bestRigidRotation(from, to);
  const before = rmsDisagreement(from, to, new Quaternion());
  const after = rmsDisagreement(from, to, rotation);
  if (before <= 1e-9) return null;
  if (after > MAX_RESIDUAL_DEGREES) return null;
  if (after > before * (1 - MIN_EXPLAINED_FRACTION)) return null;

  return { rotation, disagreementBefore: before, disagreementAfter: after };
}

/**
 * The per-bone offsets that go with an alignment: `R⁻¹ · B_b`, where `B_b` is the
 * target bone's own bind world rotation. Uniform across every mapped bone —
 * including the chain ends that otherwise need a reference pose to be given a
 * third degree of freedom, because here the rest supplies one.
 */
export function alignedLocalOffsets(
  targetBoneObjs: readonly Bone[],
  targetToSource: Readonly<Record<string, string>>,
  rotation: Quaternion,
): Record<string, Matrix4> {
  for (const bone of targetBoneObjs) {
    if (!bone.parent || !(bone.parent as Bone).isBone) bone.updateMatrixWorld(true);
  }
  const inverse = rotation.clone().invert();
  const offsets: Record<string, Matrix4> = {};
  for (const bone of targetBoneObjs) {
    if (targetToSource[bone.name] === undefined) continue;
    offsets[bone.name] = new Matrix4().makeRotationFromQuaternion(
      inverse.clone().multiply(worldRotationOf(bone)),
    );
  }
  return offsets;
}
