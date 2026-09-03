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
  /**
   * Carries SOURCE rest directions onto TARGET bind directions, in world.
   *
   * Always a turn about the world's vertical — a heading, never a lean. The
   * caller applies it to the source's TRAVEL as well as its bone rotations, and
   * a tilt there compounds with distance walked (#874).
   */
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
 * The world's vertical. Both rests reach this module already in the project's
 * Y-up world — the BVH reader and the glTF reader each convert on the way in —
 * so the two rigs stand on one shared ground plane. That is what makes the axis
 * below a fact about the data rather than a convention chosen here.
 */
const WORLD_UP = new Vector3(0, 1, 0);

/**
 * The rotation ABOUT `axis` that best carries `from` onto `to`.
 *
 * Closed form. For a rotation by θ about a unit axis n, Rodrigues gives
 * `(R·a)·b = cosθ·[(a·b) − (n·a)(n·b)] + sinθ·[(n×a)·b] + (n·a)(n·b)`, so the
 * total over all pairs is `C·cosθ + S·sinθ + constant` and the maximum sits at
 * `atan2(S, C)`. One arctangent: no seeding, no iteration, no local minima.
 *
 * This replaced an unconstrained best-fit rotation (Davenport's q-method over a
 * 4x4 Jacobi eigen-solve). The unconstrained fit is not kept alongside it on
 * purpose — see `solveRestAlignment`, where the extra two degrees of freedom
 * were the whole of #874.
 */
export function bestRotationAboutAxis(
  from: readonly Vector3[],
  to: readonly Vector3[],
  axis: Vector3,
): Quaternion {
  const n = axis.clone().normalize();
  let cosTerm = 0;
  let sinTerm = 0;
  for (let i = 0; i < from.length; i++) {
    const a = from[i];
    const b = to[i];
    cosTerm += a.dot(b) - n.dot(a) * n.dot(b);
    sinTerm += n.clone().cross(a).dot(b);
  }
  // Both terms vanish only when every `from` lies along the axis, and no
  // rotation about an axis moves what is already on it. Identity is the honest
  // answer there; anything else would be invented.
  if (Math.abs(cosTerm) < 1e-12 && Math.abs(sinTerm) < 1e-12) return new Quaternion();
  return new Quaternion().setFromAxisAngle(n, Math.atan2(sinTerm, cosTerm));
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

  // ── SOLVE FOR A HEADING, NOT FOR AN ORIENTATION ──────────────────────────
  //
  // The rotation turns about the world's vertical and nothing else, and that
  // constraint is the whole of the fix for #874. An unconstrained fit is free to
  // spend a little pitch and roll buying down the per-bone residual, and on the
  // live rig pair it did exactly that: it tilted the vertical by 4.46° to move
  // the RMS over 17 bones from 17.56° to 17.17°. Four and a half degrees of
  // tilt, bought for four tenths of a degree of fit.
  //
  // WHY THAT TRADE IS NEVER WORTH TAKING. The caller puts this rotation on the
  // source wrapper, so the source hip's world POSITION turns with it too —
  // `SkeletonUtils.js:134,140-142` reads that position and scales it onto the
  // target's root. A rotation applied to a bone's ORIENTATION contributes an
  // error no larger than its own angle. The same rotation applied to a
  // DISPLACEMENT that accumulates along a path contributes an error proportional
  // to the distance walked. 4.46° of tilt is 7.8 cm of climb per metre: the
  // bundled walk ended 0.30 m in the air, on a rig whose hips sit at 0.51 m.
  //
  // WHY THE CONSTRAINT COSTS NOTHING REAL. A pitch between these two rests is
  // not a thing that exists. Measured independently in Blender, both rests stand
  // upright — spines 84-90° above the ground in the source and 86.7° in the
  // target, legs within 5° of straight down in both. What the two disagree about
  // is the arms (horizontal in the source, 21° below it in the target) and the
  // feet (-21° against +6°), and that is per-bone anatomy which no whole-rig
  // rotation can express in the first place. It stays where it already was, in
  // the residual `alignedLocalOffsets` absorbs. See #866.
  //
  // WHAT HAPPENS TO A REST THAT GENUINELY IS PITCHED — a rig lying down, an axis
  // convention that slipped past the reader. Measured on a synthetic pair pitched
  // by a known angle, the residual this leaves rises as 0.87x the pitch, so:
  // below about 35° the pair is still ACCEPTED, the rotation is still a pure
  // heading, and the pitch stays in the residual for the per-bone offsets to
  // absorb bone by bone; beyond that it crosses MAX_RESIDUAL_DEGREES and falls
  // back to the per-bone alignment entirely. Both outcomes leave the travel in
  // the ground plane, which is the property that matters here. Neither tips it.
  const rotation = bestRotationAboutAxis(from, to, WORLD_UP);
  const before = rmsDisagreement(from, to, new Quaternion());
  const after = rmsDisagreement(from, to, rotation);
  // What is actually required is that the two rests CORRESPOND once the rotation
  // is applied — that is the residual bound, and it is the primary test.
  if (after > MAX_RESIDUAL_DEGREES) return null;
  // The fraction is a second, narrower guard: it rejects a solve that found a
  // rotation which explained nothing, which is what a rank-1 source produces.
  // It only applies when there was a real disagreement to explain. Two rests
  // that already correspond need no rotation, and refusing them for failing to
  // improve on nothing would reject the BEST case — the rotation is simply
  // identity, and every bone still gains the third degree of freedom the aligned
  // offsets carry.
  if (before > MAX_RESIDUAL_DEGREES && after > before * (1 - MIN_EXPLAINED_FRACTION)) {
    return null;
  }

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
