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
// WHEN THIS IS AVAILABLE, AND WHY IT NOW USUALLY IS. A rest can only supply a
// body frame if its bones point in more than one direction. A rest that lays
// every bone on a single axis has an eigen-spread of 0.947 / 0.053 / 0.000 — a
// third dimension of exactly zero — so there is no orientation to solve for and
// this returns null. A rest exported as a real T-pose measures
// 0.582 / 0.303 / 0.115 against the target bind's 0.571 / 0.300 / 0.129, and the
// disagreement between the two is very nearly one rotation.
//
// This note used to say the rank-1 case was what the project receives. #855's
// T-pose conditioning changed that, and the note outlived it: SEVEN of the
// eleven tracked fixtures now solve non-null, including the whole
// `assets/motion` library, and so does the untracked served output when it is
// present. Null is the exception and it marks a clip conditioning did not reach.
// That census is a row in `retargetRoll.gate.test.ts` rather than a number here,
// so the next time it moves something reds.
//
// THE CONSEQUENCE, MEASURED. On this branch a bone's twist away from its own
// bind is carried across to within 0.5°; on the null branch it is lost by up to
// 153°, because there is no second axis in a rank-1 rest to recover it from —
// not even the shoulder line, which on such a rest runs within 15° of 61 of its
// 62 bones. See `retargetRoll.gate.test.ts`, #854 and #960.

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

/**
 * How nearly opposite two rest directions may be before the minimal rotation
 * between them stops being a usable correction. cos(168.5°), the angle at which
 * a nudge to either direction is amplified about tenfold in the result. Derived
 * from the measured amplification curve rather than chosen for roundness — see
 * the refusal site in `restDirectionLocalOffsets` (retarget.ts) for the table.
 *
 * Lives HERE because both offset builders refuse on it: the direction branch
 * always did, and the aligned branch does since #866 folded a per-bone direction
 * correction into its offsets. `retarget.ts` re-exports it so its callers keep
 * their import.
 */
export const ANTIPARALLEL_REFUSAL_COSINE = -0.98;

/** Fewer pairs than this cannot pin a rotation with any confidence. */
export const MIN_PAIRS = 4;

/**
 * A rest whose second-largest direction eigenvalue falls below this lays every
 * bone on ONE axis, and no rotation can be solved from it.
 *
 * Two non-parallel directions determine a rotation, so rank TWO is already
 * enough; rank one is exactly the failure. That is what this measures, and the
 * two populations do not overlap — normalised eigenvalues over the mapped
 * directions of every tracked fixture:
 *
 *   seven healthy sources   0.538-0.558 / 0.339-0.353 / 0.089-0.123
 *   the target rig's bind   0.558       / 0.353       / 0.089
 *   the two flat sources    0.9999-1.0   / 0.0000-0.0001 / 0.0000
 *
 * The bar sits 17x below the lowest healthy reading and 200x above the highest
 * flat one. It is on the NORMALISED spectrum, so it is scale-free and states a
 * shape rather than a size.
 *
 * WHY THIS IS MEASURED AND NOT INFERRED FROM THE GUARDS BELOW. The residual and
 * fraction bounds are properties of the PAIR — they cannot say which of the two
 * rigs is at fault, and the remedy differs entirely by side: a flat CLIP is
 * regenerated with a T-pose rest (#855), a flat CHARACTER is a broken import,
 * and two full-rank rests that simply disagree are a clip aimed at the wrong
 * body. A director can only act on a reason attributable to a side.
 */
export const MIN_REST_RANK_SPREAD = 0.02;

/**
 * Why no whole-rig rotation was solved — reported from the refusal site itself,
 * so a caller never re-derives it. Each arm names a different remedy, and that
 * is the whole reason the arms exist:
 *
 *   `too-few-pairs`  the map does not reach this pair of rigs. Almost nothing
 *                    transfers, and `unmappedSourceBones` already says so —
 *                    this is the LOUD failure.
 *   `flat-rest`      a rest lays every bone on one axis. The clip still
 *                    retargets and looks complete; only the roll is gone, by up
 *                    to 153 degrees. This is the SILENT one (#960).
 *   `rests-disagree` both rests are full rank and still do not correspond.
 */
export type RestRefusal =
  | { readonly kind: 'too-few-pairs'; readonly pairs: number }
  | {
      readonly kind: 'flat-rest';
      /** Which rig cannot supply a body frame. Names the remedy. */
      readonly side: 'source' | 'target' | 'both';
      /** The offending rest's second eigenvalue, against MIN_REST_RANK_SPREAD. */
      readonly spread: number;
    }
  | {
      readonly kind: 'rests-disagree';
      readonly before: number;
      readonly after: number;
    };

/**
 * The outcome of reconciling two rests. Never null: the refusal carries its
 * reason, because the caller's job is to SAY what happened and a bare null
 * leaves it inventing an explanation.
 */
export type RestReconciliation =
  | ({ readonly kind: 'aligned' } & RestAlignment)
  | { readonly kind: 'direction'; readonly reason: RestRefusal };

/**
 * The second-largest normalised eigenvalue of a direction set's covariance —
 * how far the set departs from lying on a single axis.
 *
 * Closed form for a symmetric 3x3 (Smith 1961): no iteration, no seeding. The
 * directions are already unit, so the covariance trace is the count and the
 * normalisation is by the eigenvalue sum.
 */
function rankSpread(v: readonly Vector3[]): number {
  if (v.length < 2) return 0;
  const a = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const d of v) {
    const c = [d.x, d.y, d.z];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) a[i][j] += c[i] * c[j];
  }
  const p1 = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
  const q = (a[0][0] + a[1][1] + a[2][2]) / 3;
  // Already diagonal: the eigenvalues ARE the diagonal, and the general branch
  // below divides by zero here.
  if (p1 < 1e-18) {
    const e = [a[0][0], a[1][1], a[2][2]].sort((x, y) => y - x);
    const sum = e[0] + e[1] + e[2];
    return sum > 0 ? e[1] / sum : 0;
  }
  const p2 = (a[0][0] - q) ** 2 + (a[1][1] - q) ** 2 + (a[2][2] - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  const b = a.map((row, i) => row.map((x, j) => (x - (i === j ? q : 0)) / p));
  const det =
    b[0][0] * (b[1][1] * b[2][2] - b[1][2] * b[2][1]) -
    b[0][1] * (b[1][0] * b[2][2] - b[1][2] * b[2][0]) +
    b[0][2] * (b[1][0] * b[2][1] - b[1][1] * b[2][0]);
  const phi = Math.acos(Math.max(-1, Math.min(1, det / 2))) / 3;
  const e1 = q + 2 * p * Math.cos(phi);
  const e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  const e2 = 3 * q - e1 - e3;
  const sum = e1 + e2 + e3;
  return sum > 0 ? e2 / sum : 0;
}

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

/** Bones of a rig that ARE limbs: everything but the anchor at the top. */
function nonRootBones(bones: readonly Bone[]): Bone[] {
  return bones.filter((b) => b.parent && (b.parent as Bone).isBone);
}

/** A bone's own child bones, in rig order. */
function childBones(bone: Bone): Bone[] {
  return (bone.children as Bone[]).filter((c) => c.isBone);
}

/** The world direction from `bone` to the mean of `points`, or null if degenerate. */
function directionToMean(bone: Bone, points: readonly Vector3[]): Vector3 | null {
  if (points.length === 0) return null;
  const mean = new Vector3();
  for (const p of points) mean.add(p);
  mean.multiplyScalar(1 / points.length).sub(new Vector3().setFromMatrixPosition(bone.matrixWorld));
  return mean.lengthSq() < 1e-18 ? null : mean.normalize();
}

/**
 * How far a rig's bones may stray from one shared local axis and still count as
 * carrying a convention. Measured, not chosen: on the rig a director gets today
 * the worst of 17 non-root bones is 0.1° off local +Y, and on the two rigs that
 * have no convention the BEST is over 20°. Nothing sits near this line.
 */
const BONE_AXIS_TOLERANCE_COSINE = Math.cos((5 * Math.PI) / 180);

/** At least this many bones must agree before one axis is called a convention. */
const BONE_AXIS_MIN_EVIDENCE = 3;

/**
 * The single bone-local axis every non-root bone of this rig points along, or
 * null when the rig has no such convention (#999).
 *
 * ── WHY A RIG WOULD HAVE ONE, AND WHY IT IS WORTH ASKING ──────────────────
 *
 * A bone in the map with no MAPPED child has no direction to align by, so #866's
 * per-bone correction skips it and its rest gap survives — hands, toe bases and
 * the head, the three joints furthest out. On the rig a director actually gets
 * those bones have no children AT ALL, so there is no unmapped child to fall
 * back to either. The direction has to come from somewhere else.
 *
 * It comes from the rig's own other bones. Measured over the three rigs in the
 * tree, excluding each rig's root:
 *
 *   tripo (the target)   17 of 17 within 0.1° of local (0, 1, 0)
 *   mixamo xbot           0 of 51 within 5° of anything
 *   kimodo BVH source     0 of 61 within 5° of anything
 *
 * So "a bone points along its local +Y" is a FACT ABOUT THIS RIG that 17 bones
 * can be checked against, not an assumption — and a rig without the property
 * says so loudly rather than nearly passing.
 *
 * 🔴 THE ROOT IS EXCLUDED, AND IT IS THE ONE THING THAT DECIDES THIS. Measured
 * with the root in, the tripo rig reads 17 of 18 with an 87° outlier, and a rule
 * tuned to tolerate one outlier would also tolerate a rig with no convention at
 * all. A root is an anchor rather than a limb: its "direction to its children"
 * is the direction to the whole body, which is not a bone axis and was never
 * meant to be one. Excluding it by STRUCTURE — a bone whose parent is not a bone
 * — takes the outlier out for a reason rather than by threshold.
 *
 * Null on too little evidence: three bones agreeing is a coincidence a small rig
 * can produce, and inferring a leaf's direction from a coincidence is worse than
 * leaving the gap where a director can at least see it.
 */
export function boneAxisConvention(bones: readonly Bone[]): Vector3 | null {
  for (const bone of bones) {
    if (!bone.parent || !(bone.parent as Bone).isBone) bone.updateMatrixWorld(true);
  }
  const local: Vector3[] = [];
  for (const bone of nonRootBones(bones)) {
    const kids = childBones(bone);
    const world = directionToMean(
      bone,
      kids.map((k) => new Vector3().setFromMatrixPosition(k.matrixWorld)),
    );
    if (!world) continue;
    local.push(world.applyQuaternion(worldRotationOf(bone).clone().invert()));
  }
  if (local.length < BONE_AXIS_MIN_EVIDENCE) return null;
  const mean = new Vector3();
  for (const v of local) mean.add(v);
  if (mean.lengthSq() < 1e-12) return null;
  mean.normalize();
  // EVERY bone, not most of them. A convention with exceptions is not one, and
  // the two rigs that lack it miss by tens of degrees rather than by a few.
  for (const v of local) {
    if (v.dot(mean) < BONE_AXIS_TOLERANCE_COSINE) return null;
  }
  return mean;
}

/**
 * Where a bone's TAIL points in world, for a bone the map treats as a chain end.
 *
 * ── THE `*End` CHILD IS THE TAIL, AND AVERAGING INSTEAD IS MEASURABLY WRONG ──
 *
 * A leaf in the MAP is rarely a leaf in the RIG: a head has a skull top, a toe
 * base has a toe end, a hand has fingers. Which of those children is the tail is
 * not a matter of taste — measured against the target's own convention direction
 * on the live vendor pair:
 *
 *   Head        children [HeadEnd, Jaw, LeftEye, RightEye]
 *                 *End child      9.5°
 *                 mean of all    28.2°   ← jaw and eyes point FORWARD, not up
 *   LeftHand    children [five finger bases, no End]
 *                 mean of all     2.7°
 *   LeftToeBase children [LeftToeEnd]     22.2°  (all three rules agree)
 *
 * So: an `End` child is the tail when there is one — that is the BVH `End Site`
 * and Mixamo `_End` convention, present on both source rigs here. Otherwise the
 * mean of the children, which is right for a hand precisely because no single
 * finger is a hand's direction (the thumb least of all).
 */
function tailDirectionInWorld(bone: Bone): Vector3 | null {
  const kids = childBones(bone);
  const ends = kids.filter((k) => /end$/i.test(k.name));
  const chosen = ends.length > 0 ? ends : kids;
  return directionToMean(
    bone,
    chosen.map((k) => new Vector3().setFromMatrixPosition(k.matrixWorld)),
  );
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
 * How far apart the two rigs point each mapped bone AT REST, in world, after the
 * whole-rig rotation has been applied. Target bone name → degrees.
 *
 * WHY THIS IS THE NUMBER A DIRECTOR NEEDS. Nothing in a rotation transfer
 * removes a rest-direction disagreement, and that is not a limitation of ours:
 * in Blender every bone space is defined against the OWNER's own rest
 * (`BKE_armature_mat_pose_to_bone`, armature.cc:2281, reached from
 * `BKE_constraint_mat_convertspace`, constraint.cc:311), and Copy Rotation
 * transfers that delta without ever consulting the two rests' relative
 * orientation (`rotlike_evaluate`, constraint.cc:2049). The remedy there is to
 * match the rests or to pin the contact with IK — never a cleverer transfer.
 * See ref/GROUND_TRUTH_BLENDER_BONE_SPACES.md.
 *
 * So this is a residue the pipeline is entitled to leave, and the only honest
 * thing to do with it is SAY it. Measured on the pair a director actually gets
 * (mixamo-xbot driven by the generator's own BVH): 18.3° at both feet, 8.8° at
 * both shoulders, 0.0° at the arms — which is why that character's feet do not
 * sit the way the motion says they should, while its arms are perfect.
 *
 * 🔴 IN WORLD, not in each bone's own frame. The two are different questions and
 * the own-frame one is the wrong one: measured on the stand-in pair, the foot's
 * own-frame gap is 113.5° while the world gap is 0.3°, and it is the world gap
 * that predicts what the retarget leaves behind (#979).
 *
 * The RMS on `RestAlignment` answers "did one rotation explain these two rests";
 * this answers "which bone will look wrong". An average cannot: on the vendor
 * pair the feet are the worst bones by a factor of two and there are seventeen
 * bones to average them away with.
 */
export function restDirectionDisagreement(
  sourceBoneObjs: readonly Bone[],
  targetBoneObjs: readonly Bone[],
  targetToSource: Readonly<Record<string, string>>,
  rotation?: Quaternion,
): Map<string, number> {
  const sourceNames = new Set(Object.values(targetToSource));
  const sourceDirs = restDirectionsInWorld(sourceBoneObjs, (n) => sourceNames.has(n));
  const targetDirs = restDirectionsInWorld(targetBoneObjs, (n) => targetToSource[n] !== undefined);

  const out = new Map<string, number>();
  for (const [targetName, sourceName] of Object.entries(targetToSource)) {
    const s = sourceDirs.get(sourceName);
    const t = targetDirs.get(targetName);
    // A bone with no mapped descendant has no direction on one side or the
    // other, so it is ABSENT rather than 0 — a zero here would read as "these
    // two agree perfectly", which is the one thing it does not mean.
    if (!s || !t) continue;
    const turned = rotation ? s.clone().applyQuaternion(rotation) : s;
    out.set(targetName, turned.angleTo(t) * DEG);
  }
  return out;
}

/**
 * Solve the whole-rig rotation between two rests, or refuse WITH A REASON when
 * the two rests do not correspond well enough for one to exist.
 *
 * A refusal means a rest that #855's conditioning did not reach: seven of the
 * eleven TRACKED fixtures align, and which four do not is gated. The caller must
 * keep its per-bone behaviour for the refusal, and that case loses the roll —
 * see the module note, `retargetRoll.gate.test.ts` and #960.
 *
 * 🔴 THE REASON IS NOT DECORATION, and it is why this returns a union rather than
 * null. The four refusing fixtures are two DIFFERENT failures with opposite
 * remedies, and a bare null cannot tell them apart: two of them yield zero
 * mapped pairs and retarget to 0 and 2 keyframe tracks — a loud failure the
 * mapping counts already report — while the other two retarget to 713 tracks of
 * complete, plausible motion with the roll silently gone. Anything that wants to
 * tell a director what happened needs the reason, and re-deriving it at the call
 * site would put a second copy of this decision where it is free to drift
 * (`FloatingViewportToolbar`'s Home button, #856, is what that costs).
 */
export function solveRestAlignment(
  sourceBoneObjs: readonly Bone[],
  targetBoneObjs: readonly Bone[],
  targetToSource: Readonly<Record<string, string>>,
): RestReconciliation {
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
  if (from.length < MIN_PAIRS) {
    return { kind: 'direction', reason: { kind: 'too-few-pairs', pairs: from.length } };
  }

  // WHICH RIG, ASKED BEFORE THE FIT. A rank-one rest cannot be aligned to
  // anything, so the guards below would refuse it — but they would refuse it as
  // a property of the PAIR, and a director cannot act on that. Asked here, the
  // answer names a side and therefore a remedy. Both sides, because a degenerate
  // BIND is a broken character rather than a flat clip and the two are fixed in
  // different places.
  const sourceSpread = rankSpread(from);
  const targetSpread = rankSpread(to);
  const flatSource = sourceSpread < MIN_REST_RANK_SPREAD;
  const flatTarget = targetSpread < MIN_REST_RANK_SPREAD;
  if (flatSource || flatTarget) {
    return {
      kind: 'direction',
      reason: {
        kind: 'flat-rest',
        side: flatSource && flatTarget ? 'both' : flatSource ? 'source' : 'target',
        // The offending one. With both flat, the source is the one a director
        // can regenerate, so it leads.
        spread: flatSource ? sourceSpread : targetSpread,
      },
    };
  }

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
  if (after > MAX_RESIDUAL_DEGREES) {
    return { kind: 'direction', reason: { kind: 'rests-disagree', before, after } };
  }
  // The fraction is a second, narrower guard: it rejects a solve that found a
  // rotation which explained nothing, which is what a rank-1 source produces.
  // It only applies when there was a real disagreement to explain. Two rests
  // that already correspond need no rotation, and refusing them for failing to
  // improve on nothing would reject the BEST case — the rotation is simply
  // identity, and every bone still gains the third degree of freedom the aligned
  // offsets carry.
  if (before > MAX_RESIDUAL_DEGREES && after > before * (1 - MIN_EXPLAINED_FRACTION)) {
    return { kind: 'direction', reason: { kind: 'rests-disagree', before, after } };
  }

  return { kind: 'aligned', rotation, disagreementBefore: before, disagreementAfter: after };
}

/**
 * What `alignedLocalOffsets` hands back: the offsets, and which mapped bones the
 * per-bone direction correction reached.
 *
 * `absorbed` — bones whose rest-direction disagreement the offset now removes.
 * `refused`  — bones whose two rest directions are nearly OPPOSITE after the
 *              heading, where the minimal rotation between them is undetermined
 *              (see `ANTIPARALLEL_REFUSAL_COSINE`); their offset carries no
 *              direction term and their gap stays.
 *
 * A bone with no mapped child — a LEAF of the map — is absorbed too since #999,
 * from the target rig's bone-axis CONVENTION and the source bone's tail, and is
 * named in `byConvention` as well. It falls back into NEITHER list when the
 * target rig has no convention, or when the source leaf has no children of its
 * own to point at: there is then no direction to correct and none is invented.
 *
 * Both are reported from the builder itself so the bone-map panel says what the
 * retarget DID rather than re-deriving it one file over (#987's shape).
 */
export interface AlignedOffsets {
  readonly offsets: Record<string, Matrix4>;
  readonly absorbed: readonly string[];
  readonly refused: readonly string[];
  /**
   * The subset of `absorbed` whose direction came from the target rig's bone-axis
   * CONVENTION rather than from a mapped child (#999) — the leaves.
   *
   * Reported separately because the evidence is weaker and a reader should be
   * able to tell: a mapped bone's direction is measured from where its own child
   * sits, while a leaf's is inferred from what the rig's other seventeen bones
   * do. Both are absorbed, and only one of them could be wrong about THIS bone.
   */
  readonly byConvention: readonly string[];
}

/**
 * The per-bone offsets that go with an alignment: `R⁻¹ · B_b · D_b`, where `B_b`
 * is the target bone's own bind world rotation and `D_b` is the bone-local
 * rotation that carries the target's rest direction onto the source's.
 *
 * ── WHY THERE IS A `D_b` AT ALL (#866) ─────────────────────────────────────
 *
 * Without it the offset is `R⁻¹ · B_b` and the pipeline composes
 * `T_b(t) = R · W_b(t) · R⁻¹ · B_b`: at the source's rest the target sits on its
 * own bind, and thereafter it performs THE SAME DELTA FROM ITS OWN REST as the
 * source performs from the source's. That is exactly right when the two rests
 * agree about where every bone points, and it is silently wrong by the whole
 * disagreement when they do not — a target whose upper arm rests 21° below the
 * source's carries that 21° through every frame of the clip. Measured on the
 * live vendor pair (Kimodo T-pose rest driving the Tripo rig), the direction
 * error between the target bone and the heading-turned source bone was CONSTANT
 * across 109 frames and equal, to a tenth of a degree, to the rest gap:
 * feet 29.7°/28.5°, forearms 28.4°/24.4°, upper arms 21.7°/21.0°.
 *
 * A heading cannot express a disagreement that differs bone by bone, and this is
 * per-bone anatomy — left/right symmetric to a tenth of a degree. So the
 * whole-rig part stays where it was and the per-bone part is layered on top:
 * `D_b` is solved in the target bone's bind-local frame so that
 *
 *     B_b · D_b · localDir_T  =  R · worldDir_S
 *
 * — at the source's rest the target bone POINTS WHERE THE SOURCE'S DOES (turned
 * by the heading), and since `T_b(t) · localDir_T = R · W_b(t) · worldDir_S`,
 * it keeps doing so at every frame. The identity case is unchanged: two rests
 * that are one rotation apart give `D_b = I` on every bone and the target still
 * sits on its bind.
 *
 * WHAT `D_b` DOES NOT TOUCH. It is the minimal rotation between two directions,
 * so its axis is perpendicular to the bone and it adds no roll about it. The
 * third degree of freedom still comes from the rest alignment, as before.
 *
 * WHAT IT REFUSES. A pair of rest directions that are nearly opposite after the
 * heading has no usable minimal rotation — every half-turn perpendicular to the
 * bone carries one onto the other and they differ by a roll, which is precisely
 * the degree of freedom this term must not decide. Those bones keep `R⁻¹ · B_b`
 * and are named in `refused` so the panel can say their gap stayed.
 *
 * Grounded against the reference: Blender's own transfer never consults the two
 * rests and leaves this gap in place (`rotlike_evaluate`, constraint.cc:2049);
 * its remedy is that a human MATCHES the rests first. This is that matching,
 * done per bone from the two rests themselves.
 */
export function alignedLocalOffsets(
  sourceBoneObjs: readonly Bone[],
  targetBoneObjs: readonly Bone[],
  targetToSource: Readonly<Record<string, string>>,
  rotation: Quaternion,
): AlignedOffsets {
  // The source's rest directions are read off its live bones and turned by
  // `rotation` HERE. If the caller has already turned the source's wrapper by the
  // same rotation, the heading lands twice — measured: every arm and foot 82-90°
  // off on the live vendor pair. A sequence error that silent gets a detector,
  // not a comment: a source root whose parent is already rotated is refused.
  for (const bone of sourceBoneObjs) {
    const parent = bone.parent;
    if (parent && !(parent as Bone).isBone && parent.quaternion.angleTo(new Quaternion()) > 1e-6) {
      throw new Error(
        'alignedLocalOffsets: the source wrapper is already rotated. Build the offsets ' +
          'BEFORE turning the wrapper by the heading, or the heading is applied twice.',
      );
    }
  }
  for (const bones of [sourceBoneObjs, targetBoneObjs]) {
    for (const bone of bones) {
      if (!bone.parent || !(bone.parent as Bone).isBone) bone.updateMatrixWorld(true);
    }
  }
  const sourceNames = new Set(Object.values(targetToSource));
  const sourceDirs = restDirectionsInWorld(sourceBoneObjs, (n) => sourceNames.has(n));
  const targetDirs = restDirectionsInWorld(targetBoneObjs, (n) => targetToSource[n] !== undefined);
  // #999 — what a LEAF falls back to. Null on a rig with no convention, and the
  // leaves then keep the pre-#999 behaviour: no direction term, gap intact,
  // named in neither list. Asked once for the whole rig rather than per bone.
  const convention = boneAxisConvention(targetBoneObjs);
  const sourceByName = new Map(sourceBoneObjs.map((b) => [b.name, b]));

  const inverse = rotation.clone().invert();
  const offsets: Record<string, Matrix4> = {};
  const absorbed: string[] = [];
  const refused: string[] = [];
  const byConvention: string[] = [];
  for (const bone of targetBoneObjs) {
    const sourceName = targetToSource[bone.name];
    if (sourceName === undefined) continue;
    const bind = worldRotationOf(bone);
    let correction = new Quaternion();

    // A mapped child's direction FIRST, always. The convention is the fallback
    // for a bone that has no such child, never a second opinion about one that
    // does — 17 bones agreeing about the rig cannot outrank this bone's own
    // measured direction, and letting it try would replace measurement with
    // inference on every bone at once.
    const measuredTarget = targetDirs.get(bone.name);
    const leafTarget =
      measuredTarget ?? (convention ? convention.clone().applyQuaternion(bind) : undefined);
    const sourceBone = sourceByName.get(sourceName);
    const sourceWorld =
      sourceDirs.get(sourceName) ??
      (measuredTarget === undefined && sourceBone
        ? (tailDirectionInWorld(sourceBone) ?? undefined)
        : undefined);
    const targetWorld = leafTarget;
    if (targetWorld && sourceWorld) {
      if (measuredTarget === undefined) byConvention.push(bone.name);
      // Both directions expressed in the target bone's own bind frame, where the
      // offset is applied.
      const bindInverse = bind.clone().invert();
      const have = targetWorld.clone().applyQuaternion(bindInverse);
      const want = sourceWorld.clone().applyQuaternion(rotation).applyQuaternion(bindInverse);
      if (have.dot(want) < ANTIPARALLEL_REFUSAL_COSINE) {
        refused.push(bone.name);
        // A refused leaf claimed a convention term it did not get. Take the
        // claim back rather than leaving the panel two lists that disagree.
        if (measuredTarget === undefined) byConvention.pop();
      } else {
        correction = new Quaternion().setFromUnitVectors(have, want);
        absorbed.push(bone.name);
      }
    }

    offsets[bone.name] = new Matrix4().makeRotationFromQuaternion(
      inverse.clone().multiply(bind).multiply(correction),
    );
  }
  return { offsets, absorbed, refused, byConvention };
}
