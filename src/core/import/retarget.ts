// Animation retargeting — apply a clip authored on one skeleton to a
// differently-named (and differently-shaped) skeleton.
//
// Round-trip: POJO sourceBones + sourceClip + POJO targetBones + nameMap
//   → THREE.Skeleton + THREE.AnimationClip + nameMap-as-options
//   → SkeletonUtils.retargetClip                             [the math]
//   → AnimationClip with target-bone-named tracks
//   → POJO AnimationClipParams (via threeAdapter.clipToKeyframes)
//
// Why round-trip THREE: SkeletonUtils handles the bind-pose-aware
// rebinding (bone hierarchies with different rest poses + scales) that
// raw track-renaming can't. Mixamo characters at scale ~100 retargeted
// to a glTF rig at scale 1 just work without scale prep on the user's
// part.
//
// Bone-name boundary class: this is a sister boundary to B7 (agent
// identifier ↔ DAG node-set). Both resolve names to a concrete entity;
// B7 is fuzzy + agent-facing, this is exact + rig-facing. Promote to a
// dharana boundary B9 if a second name-resolution bug surfaces here.
//
// REF: THESIS §42.1; project_p31_plan.md.

import { retargetClip as threeRetargetClip } from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  AnimationClip as ThreeAnimationClip,
  SkinnedMesh,
  Quaternion,
  Matrix4,
  Vector3,
  Euler,
  type Bone,
} from 'three';

/**
 * `localOffsets` exists in the SHIPPED JavaScript but not in `@types/three`.
 *
 * `SkeletonUtils.js:123-127` reads `options.localOffsets[bone.name]` and
 * multiplies it into the composed world matrix; `SkeletonUtils.d.ts`'s
 * `RetargetOptions` does not declare it (nor `preserveBonePositions`, which the
 * JS also reads). The typings lag the implementation, so the option is declared
 * here rather than silently cast away — if a future `@types/three` adds it, this
 * alias becomes redundant and the compiler will not complain either way.
 */
type RetargetClipOptionsWithOffsets = Parameters<typeof threeRetargetClip>[3] & {
  localOffsets?: Record<string, Matrix4>;
};
import type { AnimationKeyframe, BoneSpec } from '../../nodes/types';
import {
  bonesToSpec,
  clipToKeyframes,
  paramsToThreeClip,
  specToThreeSkeleton,
} from './threeAdapter';
import { solveRestAlignment, alignedLocalOffsets } from './restAlignment';

export interface RetargetArgs {
  /** Source bone hierarchy (e.g. Mixamo). */
  readonly sourceBones: readonly BoneSpec[];
  /** Source AnimationClip params. */
  readonly sourceClip: {
    readonly name: string;
    readonly duration: number;
    readonly keyframes: readonly AnimationKeyframe[];
    /** The source's own time domain. Retargeting changes WHICH RIG a motion plays
     *  on, never HOW IT ENDS, so this travels with the keys rather than being
     *  decided here (#919) — the same "keys and domain are one answer" rule #913
     *  and #916 applied at their layers.
     *
     *  Optional for the one honest reason: a caller that has no source clip to
     *  ask. Every production caller does have one and passes it. Absent, it falls
     *  back to the value this function used to invent unconditionally.
     *
     *  Load-bearing since #924: `loop` selects the per-side extend rule, so a
     *  clip wrongly marked looping does not merely wrap — its root accumulates
     *  travel forever. */
    readonly loop?: boolean;
  };
  /** Target bone hierarchy (e.g. user's glTF character). */
  readonly targetBones: readonly BoneSpec[];
  /** Source bone-name → target bone-name. Bones absent from the map keep their source name. */
  readonly nameMap: Readonly<Record<string, string>>;
  /** Output clip name — defaults to "<sourceName>_retargeted". */
  readonly outputName?: string;
}

export interface RetargetResult {
  readonly clipParams: {
    readonly name: string;
    readonly duration: number;
    readonly loop: boolean;
    readonly keyframes: readonly AnimationKeyframe[];
  };
  /** Source bones with no entry in nameMap and no match in the target — surface to UI. */
  readonly unmappedSourceBones: readonly string[];
  /** Target bones that no source bone mapped to — surface to UI. */
  readonly unboundTargetBones: readonly string[];
}

/**
 * Retarget a clip from sourceBones onto targetBones via the name map.
 * Pure: same inputs → same output. No DOM / clock side effects.
 */
/**
 * A separator-insensitive key for a bone name.
 *
 * The two import roads sanitise the SAME Mixamo bone differently, and neither is
 * wrong on its own terms:
 *
 *   FBX  — three's `PropertyBinding.sanitizeNodeName` REMOVES reserved characters
 *          (`PropertyBinding.js`), so `mixamorig:Hips` arrives as `mixamorigHips`.
 *          It runs inside `FBXLoader` before our code ever sees the name.
 *   glTF — our own `sanitizeBoneName` REPLACES them with `_` (`threeAdapter.ts`),
 *          so the same bone arrives as `mixamorig_Hips`.
 *
 * A name map authored against one spelling therefore matched NOTHING on the other,
 * and the failure was silent: every track dropped, an empty clip, no error. Measured
 * on a real Mixamo export — the shipped Mixamo→glTF preset matched 0 of 22 bones and
 * produced 0 keyframes. Canonicalising both sides is what makes a map portable across
 * the two roads without migrating anyone's stored bone names.
 */
export function canonicalBoneKey(name: string): string {
  return name.toLowerCase().replace(/[_:.\-\s]/g, '');
}

/**
 * Resolve authored bone names onto the names a skeleton actually carries, matching
 * separator-insensitively only when an exact name is absent. Returns every authored
 * name mapped to its resolution — to ITSELF when nothing resolves it, so a caller
 * substitutes unconditionally and an unresolved name still reaches the diagnostics
 * as authored rather than the map quietly shrinking.
 *
 * Deliberately conservative in three ways, and each one is a silent wrong answer
 * that would otherwise be available:
 *
 *   1. An exact name always wins, so an author who spelled a name precisely is
 *      never second-guessed — and no inexact name may later revise that entry.
 *   2. A canonical form shared by two different BONES is left UNRESOLVED rather
 *      than guessed at.
 *   3. A bone claimed by two different AUTHORED NAMES is left unresolved for the
 *      same reason. Writing a preset that covers both import roads' spellings is
 *      the natural reaction to the bug this function exists to fix, and resolving
 *      in one pass silently kept whichever name happened to come last.
 *
 * Rules 1 and 3 hold regardless of input order because the pass COUNTS claims
 * before it writes any of them; deciding and writing in the same iteration made
 * the stated priority depend on key order, which is not a rule at all.
 */
export function resolveBoneNames(
  authored: readonly string[],
  bones: readonly BoneSpec[],
): Record<string, string> {
  const exact = new Set(bones.map((b) => b.name));
  const byCanonical = new Map<string, string | null>();
  for (const b of bones) {
    const key = canonicalBoneKey(b.name);
    // null marks "two bones share this canonical form" — ambiguous, so no match.
    byCanonical.set(key, byCanonical.has(key) ? null : b.name);
  }

  // Distinct spellings, because rule 3 is about two DIFFERENT names claiming one
  // bone. Two source bones may legitimately map onto a single target bone, and
  // that repeat is one authored name, not a collision.
  const names = [...new Set(authored)];
  const exactNames = names.filter((n) => exact.has(n));
  const inexactNames = names.filter((n) => !exact.has(n));
  const takenByExact = new Set(exactNames);

  const hitFor = new Map<string, string>();
  const claims = new Map<string, number>();
  for (const n of inexactNames) {
    const hit = byCanonical.get(canonicalBoneKey(n));
    if (!hit || takenByExact.has(hit)) continue;
    hitFor.set(n, hit);
    claims.set(hit, (claims.get(hit) ?? 0) + 1);
  }

  const out: Record<string, string> = {};
  for (const n of exactNames) out[n] = n;
  for (const n of inexactNames) {
    const hit = hitFor.get(n);
    out[n] = hit !== undefined && claims.get(hit) === 1 ? hit : n;
  }
  return out;
}

/**
 * Rewrite a name map's SOURCE keys to the names the source skeleton actually uses.
 */
export function resolveNameMapToSource(
  nameMap: Readonly<Record<string, string>>,
  sourceBones: readonly BoneSpec[],
): Record<string, string> {
  const resolved = resolveBoneNames(Object.keys(nameMap), sourceBones);
  const out: Record<string, string> = {};
  for (const [key, targetName] of Object.entries(nameMap)) out[resolved[key] ?? key] = targetName;
  return out;
}

/**
 * Rewrite a name map's TARGET values to the names the target skeleton actually uses.
 *
 * The mirror of the above, and it exists because a match has two sides while the
 * mechanism that corrupts the names — a loader's sanitiser — does not care which
 * side a name is standing on. Fixing only the reported side left the other failing
 * exactly as completely: a BVH-spelled clip retargeted onto an FBX-derived skeleton
 * through an underscore-spelled map bound 0 of 22 target bones and emitted no
 * keyframes, with no throw and no warning. It is reachable because `parseFbx` really
 * does produce a `skeletonParams.bones` list, so an FBX rig can be the TARGET and not
 * only the source.
 */
export function resolveNameMapToTarget(
  nameMap: Readonly<Record<string, string>>,
  targetBones: readonly BoneSpec[],
): Record<string, string> {
  const resolved = resolveBoneNames(Object.values(nameMap), targetBones);
  const out: Record<string, string> = {};
  for (const [key, targetName] of Object.entries(nameMap)) {
    out[key] = resolved[targetName] ?? targetName;
  }
  return out;
}

/**
 * Per-target-bone corrections that carry the SOURCE rig's bone-axis convention
 * onto the TARGET's, keyed by target bone name.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NEEDED AT ALL
 * ─────────────────────────────────────────────────────────────────────────
 * `SkeletonUtils.retarget` sets the target bone's world rotation to the source
 * bone's world rotation VERBATIM:
 *
 *     globalMatrix.makeRotationFromQuaternion(
 *       quat.setFromRotationMatrix( relativeMatrix ) );   // SkeletonUtils.js:114
 *
 * where `relativeMatrix` is the SOURCE bone's `matrixWorld`. There is no bind
 * compensation anywhere in that function. Copying a world rotation across is
 * only meaningful when both rigs agree on where a bone POINTS at rest — and
 * SOMA (chains along ±X, identity local rotations) and Mixamo (a real T-pose
 * bind) do not agree at all. So the source's world rotation carries the ~90°
 * that stands its skeleton up off the floor, and that rotation lands on a
 * target whose bind is already correct: the character is laid down by exactly
 * the amount the source's rest pose is wrong.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THE CORRECTION IS, AND WHY IT NEEDS NO POSE
 * ─────────────────────────────────────────────────────────────────────────
 * The thing we actually want is simple to say: **the target's bone should point
 * where the source's bone points.** Write that down and the correction falls
 * out with no reference pose in it anywhere.
 *
 * A bone's world rotation takes its own REST DIRECTION — the way it points in
 * its own local frame, which is just the direction to its child — onto the
 * direction it points now:
 *
 *     R_S(t) · restDir_S = dir(t)          the source, at any time t
 *     R_T(t) · restDir_T = dir(t)          what we want of the target
 *
 * Substituting gives `R_T = R_S · Q` where `Q · restDir_T = restDir_S`, so Q is
 * the minimal rotation carrying the target's rest direction onto the source's.
 * `options.localOffsets` is applied as exactly `R_T = R_S · offset`
 * (`SkeletonUtils.js:123-127`), so Q goes straight in.
 *
 * Both rest directions are properties of a rig ALONE — no pose is sampled, none
 * is assumed, and the source's may be as degenerate as SOMA's actually is. That
 * is what makes this hold for an A-pose source against a T-pose target, or for
 * two rigs that are neither.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS REPLACED, AND WHY THE ARMS WERE WRONG BEFORE
 * ─────────────────────────────────────────────────────────────────────────
 * The first version of this solved the same equation at a sampled REFERENCE
 * POSE: `offset = inverse(sourceRefWorldRot) · targetBindWorldRot`, with the
 * source sampled at its clip's frame 0 and the target at its bind. That stands
 * the character up, and it is exact at the pose it was sampled in — but the two
 * poses sampled were DIFFERENT. The source's frame 0 is an A-pose, arms hanging;
 * the target's bind is a T-pose, arms straight out. So the target held its own
 * T-pose whenever the source held its A-pose, and every arm bone carried the
 * angle between them for the whole clip (#845). Measured on the live pair, the
 * upper arm sat 20-42° below horizontal where the source's was near 75°.
 *
 * Aligning directions instead removes the question rather than answering it:
 * there is no reference pose to pick, so there is no way to pick two different
 * ones. Blender reaches the same place from the other side — Child Of's *Set
 * Inverse* captures the offset empirically and names no canonical pose either.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TWIST, STATED HONESTLY
 * ─────────────────────────────────────────────────────────────────────────
 * A direction constrains two degrees of freedom and a rotation has three, so
 * the roll ABOUT the bone's own axis is not determined by the equation above.
 * `setFromUnitVectors` resolves it by taking the minimal rotation, which adds no
 * roll of its own — so whatever twist the source carries is passed through
 * unchanged, and the only thing left unconstrained is a CONSTANT difference
 * between the two rigs' idea of which way is "up" around a limb.
 *
 * That constant cannot be recovered from directions alone; it needs a second
 * axis both rigs agree on, and no such axis is available here. Choosing one
 * arbitrarily would be a guess with the authority of a computation. Twist shows
 * in the SKIN — a rolled forearm — and never in where a limb goes, so this is
 * the smaller of the two errors and it is the one that stays put.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AN ALTERNATIVE THAT WAS MEASURED FALSE — DO NOT RETRY IT
 * ─────────────────────────────────────────────────────────────────────────
 * Re-binding the SOURCE skeleton to its calibration pose and recomputing
 * `boneInverses` changes NOTHING — byte-identical output, verified with the
 * patch logging its own execution so the null could not be mistaken for a
 * stale build. `retarget` never reads the source's bind; it reads only
 * `boneTo.matrixWorld`.
 *
 * A bone with no mapped child has no direction to align and inherits its
 * parent's correction — hands, feet, head and toe tips, which is also where a
 * constraint stack would leave them. A bone with no mapped ancestor either gets
 * no entry at all and keeps whatever the retarget would have given it, notably
 * the root, which is never in a name map.
 */
/**
 * The source rig's WORLD rotations at a reference pose, by bone name.
 *
 * Composed from the given LOCAL rotations without touching the live bones — the
 * same skeleton objects are read again for their rest directions, and a posed
 * skeleton would silently change that answer. A bone the reference does not
 * name keeps its own rest rotation.
 */
export function referenceWorldRotations(
  sourceBoneObjs: readonly Bone[],
  localRotations: Readonly<Record<string, readonly [number, number, number]>>,
): Map<string, Quaternion> {
  const out = new Map<string, Quaternion>();
  const visit = (bone: Bone, parentWorld: Quaternion): void => {
    const posed = localRotations[bone.name];
    const local = posed
      ? new Quaternion().setFromEuler(new Euler(posed[0], posed[1], posed[2], 'XYZ'))
      : bone.quaternion.clone();
    const world = parentWorld.clone().multiply(local);
    out.set(bone.name, world);
    for (const child of bone.children) if ((child as Bone).isBone) visit(child as Bone, world);
  };
  for (const bone of sourceBoneObjs) {
    if (!bone.parent || !(bone.parent as Bone).isBone) visit(bone, new Quaternion());
  }
  return out;
}

/**
 * How nearly opposite two rest directions may be before the minimal rotation
 * between them stops being a usable correction. cos(168.5 deg), the angle at
 * which a nudge to either direction is amplified about tenfold in the result.
 * Derived from the measured amplification curve rather than chosen for roundness
 * -- see the refusal site in `restDirectionLocalOffsets` for the table.
 */
export const ANTIPARALLEL_REFUSAL_COSINE = -0.98;

export function restDirectionLocalOffsets(
  sourceBoneObjs: readonly Bone[],
  targetBoneObjs: readonly Bone[],
  targetToSource: Readonly<Record<string, string>>,
  sourceReference?: ReadonlyMap<string, Quaternion>,
): Record<string, Matrix4> {
  // Compose from every parentless bone before reading. `specToThreeSkeleton` has
  // already done this (K42), but a subtree nothing has touched can still be
  // stale, and a stale matrix here is a silently wrong direction.
  for (const bones of [sourceBoneObjs, targetBoneObjs]) {
    for (const b of bones) if (!b.parent || !(b.parent as Bone).isBone) b.updateMatrixWorld(true);
  }

  const sourceByName = new Map(sourceBoneObjs.map((b) => [b.name, b]));

  /**
   * The direction from `bone` to `child`, in BONE's own local frame.
   *
   * Taken from world positions and rotated back, rather than read off the
   * child's local translation, so an unmapped joint BETWEEN the two does not
   * change the answer — two rigs rarely subdivide a limb the same way, and the
   * direction along a limb is the same whether one bone spans it or three.
   */
  /** A bone's world rotation, read off the matrix the caller already composed. */
  const worldRotationOf = (bone: Bone): Quaternion => {
    const position = new Vector3();
    const rotation = new Quaternion();
    const scale = new Vector3();
    bone.matrixWorld.decompose(position, rotation, scale);
    return rotation;
  };

  const localDirection = (bone: Bone, child: Bone): Vector3 | null => {
    const here = new Vector3();
    const there = new Vector3();
    const rotation = new Quaternion();
    const scale = new Vector3();
    bone.matrixWorld.decompose(here, rotation, scale);
    there.setFromMatrixPosition(child.matrixWorld);
    const delta = there.sub(here);
    if (delta.lengthSq() < 1e-18) return null;
    return delta.applyQuaternion(rotation.invert()).normalize();
  };

  /** The nearest MAPPED bone below `bone` in the target, or null at a chain end. */
  const mappedChild = (bone: Bone): Bone | null => {
    const stack = [...bone.children];
    while (stack.length > 0) {
      const next = stack.shift() as Bone;
      if (!next.isBone) continue;
      if (targetToSource[next.name] !== undefined) return next;
      stack.push(...(next.children as Bone[]));
    }
    return null;
  };

  const offsets: Record<string, Matrix4> = {};
  // Parents before children, so a chain end can inherit a correction that is
  // already computed. `specToThreeSkeleton` preserves the spec's order, and a
  // spec lists a parent before its children.
  for (const targetBone of targetBoneObjs) {
    const sourceName = targetToSource[targetBone.name];
    if (sourceName === undefined) continue;

    /**
     * A bone that cannot be aligned by direction takes its correction from the
     * joint it hangs off, at the source's REFERENCE POSE.
     *
     * The nearest already-corrected ancestor is aligned by direction, so two of
     * its three degrees of freedom are right. Carrying that down and then
     * asking the joint BETWEEN them to sit at the target's own bind bend fixes
     * all three for the leaf — and it is the joint, not the world, that the
     * reference is taken relative to. That distinction is the whole fix: an
     * A-pose and a T-pose disagree at the SHOULDER, so a wrist, an ankle and a
     * neck never pick the disagreement up, while a world-relative reference
     * hands every one of them the full arm swing. Measured on the live pair,
     * world-relative moved the hands 96° and 114° and the toes 111° and 93°;
     * joint-relative moves them 15°, 24°, 8° and 21° while still turning the
     * head the 42° it was wrong by.
     *
     * WHAT THIS ASSUMES, STATED. That the source holds its leaf joints at their
     * own neutral in the reference frame — a straight wrist, a level head, a
     * flat foot. That is what a calibration A-pose IS, and SOMA's clips carry
     * exactly such a frame. A clip whose first frame turns the head would bake
     * that turn in; nothing here can tell the two apart, so it is written down
     * rather than detected.
     */
    const fromReferenceJoint = (): boolean => {
      if (!sourceReference) return false;
      let ancestor = targetBone.parent as Bone | null;
      while (ancestor && (targetToSource[ancestor.name] === undefined || !offsets[ancestor.name])) {
        ancestor = ancestor.parent as Bone | null;
      }
      if (!ancestor) return false;
      const ancestorSource = sourceByName.get(targetToSource[ancestor.name]);
      const boneSource = sourceByName.get(sourceName);
      if (!ancestorSource || !boneSource) return false;
      const referenceHere = sourceReference.get(boneSource.name);
      const referenceThere = sourceReference.get(ancestorSource.name);
      if (!referenceHere || !referenceThere) return false;

      // The target's own bind bend across this joint — what the joint should
      // read whenever the source holds its neutral.
      const bindBend = worldRotationOf(ancestor).invert().multiply(worldRotationOf(targetBone));
      offsets[targetBone.name] = new Matrix4().makeRotationFromQuaternion(
        referenceHere
          .clone()
          .invert()
          .multiply(referenceThere)
          .multiply(new Quaternion().setFromRotationMatrix(offsets[ancestor.name]))
          .multiply(bindBend),
      );
      return true;
    };

    /**
     * The correction for a bone that has no direction to align by: from the
     * joint above where a reference pose is available, and otherwise the
     * neighbour's, which is all there is to go on.
     */
    const withoutADirection = (): void => {
      if (fromReferenceJoint()) return;
      const parent = targetBone.parent as Bone | null;
      const fromParent = parent ? offsets[parent.name] : undefined;
      if (fromParent) offsets[targetBone.name] = fromParent.clone();
    };

    const targetChild = mappedChild(targetBone);
    const sourceChild = targetChild
      ? sourceByName.get(targetToSource[targetChild.name])
      : undefined;
    const sourceBone = sourceByName.get(sourceName);
    if (!targetChild || !sourceChild || !sourceBone) {
      withoutADirection();
      continue;
    }

    const targetDir = localDirection(targetBone, targetChild);
    const sourceDir = localDirection(sourceBone, sourceChild);
    if (!targetDir || !sourceDir) {
      withoutADirection();
      continue;
    }

    // A pair that is nearly OPPOSITE has no usable minimal rotation. Every axis
    // perpendicular to the bone carries one direction onto the other, and those
    // half-turns differ from each other by a roll ABOUT the bone — the very
    // degree of freedom this correction is already short of. So the answer is
    // not merely large, it is undetermined, and it is picked by an
    // implementation detail rather than by anything in either rig.
    //
    // Measured: nudge the source direction by 0.5 deg and read how far the
    // correction moves. The amplification is about 2/sin(angle) --
    //
    //     90 deg -> 0.71 deg out (1.4x)      175 deg -> 11.42 deg out (22.8x)
    //    150 deg -> 1.93 deg out (3.9x)      179 deg -> 57.35 deg out (114.7x)
    //
    // -- so the refusal is placed where the amplification reaches 10x, which is
    // 168.5 deg, cos -0.98. Below that a degree of rest error stays a few
    // degrees of correction error; above it, rest noise becomes a large
    // arbitrary twist that presents as a retarget bug rather than a
    // conditioning one.
    //
    // This cannot fire on any source we currently receive: their rests lay every
    // bone on one axis, so every mapped pair sits at exactly 90 deg. It fires on
    // a source whose rest genuinely opposes the target's bone axis -- which a
    // proper T-pose rest does at the legs, at 175-179 deg.
    //
    // Falling back is the module's own existing answer to "this bone cannot be
    // aligned by direction", used already for a bone with no mapped child. What
    // it yields is DEFINED rather than correct; supplying the missing second
    // axis so the rotation is determined instead of minimal is a separate change.
    if (targetDir.dot(sourceDir) < ANTIPARALLEL_REFUSAL_COSINE) {
      withoutADirection();
      continue;
    }

    offsets[targetBone.name] = new Matrix4().makeRotationFromQuaternion(
      new Quaternion().setFromUnitVectors(targetDir, sourceDir),
    );
  }
  return offsets;
}

export function retargetClip(args: RetargetArgs): RetargetResult {
  const { skeleton: sourceSkeleton, bones: sourceBoneObjs } = specToThreeSkeleton(args.sourceBones);
  const { skeleton: targetSkeleton, bones: targetBoneObjs } = specToThreeSkeleton(args.targetBones);

  // SkeletonUtils.retargetClip wants Object3D-like wrappers exposing
  // `.skeleton` and `.isObject3D=true`. SkinnedMesh fits. Add the root
  // bone as a child so traversal works for source-side bone iteration.
  const sourceWrap = new SkinnedMesh();
  if (sourceBoneObjs[0]) sourceWrap.add(sourceBoneObjs[0]);
  sourceWrap.skeleton = sourceSkeleton;
  const targetWrap = new SkinnedMesh();
  if (targetBoneObjs[0]) targetWrap.add(targetBoneObjs[0]);
  targetWrap.skeleton = targetSkeleton;

  const sourceClip = paramsToThreeClip(
    args.sourceClip.name,
    args.sourceClip.duration,
    args.sourceClip.keyframes,
    args.sourceBones,
  );

  // SkeletonUtils.retargetClip iterates TARGET bones and uses
  // options.names[targetBoneName] to find the matching source bone.
  // Our public API takes the natural source→target direction; invert
  // here so callers don't have to think in THREE-internal terms.
  // Resolve the map against the names each skeleton actually carries, BOTH sides
  // and BEFORE inverting, so a map authored in either road's spelling lands
  // whichever road each operand arrived by.
  const nameMap = resolveNameMapToTarget(
    resolveNameMapToSource(args.nameMap, args.sourceBones),
    args.targetBones,
  );
  const targetToSource: Record<string, string> = {};
  for (const [sourceName, targetName] of Object.entries(nameMap)) {
    targetToSource[targetName] = sourceName;
  }
  // 🔴 READ THE TARGET'S BIND POSE BEFORE THE RETARGET RUNS.
  //
  // `threeRetargetClip` poses the target skeleton frame by frame and leaves the
  // bone objects wherever the last frame put them — measured: every local
  // translation flattened to [0,0,0]. `clipToKeyframes` falls back to
  // `bind.position` for a bone the clip does not translate, which is EVERY bone
  // here (a retarget emits quaternion tracks only, by design, because the target
  // keeps its own proportions). So reading the spec afterwards fed it a bind pose
  // of all zeros, it wrote position [0,0,0] into every keyframe, and the bake
  // copied that into an absolute local-position channel — placing every bone at
  // its parent's origin and folding the character into a blob (#828).
  //
  // The names read back identically either side of the call; only the positions
  // are destroyed by it. So this is an ORDERING fix, not a data-source change.
  const targetSpecs = bonesToSpec(targetBoneObjs);

  // 🔴 ROOT MOTION IS OPT-IN, AND WE WERE NOT OPTING IN (#839).
  //
  // `SkeletonUtils.retargetClip` emits a POSITION track for exactly one bone:
  // the one whose source name equals `options.hip` (SkeletonUtils.js:263). Every
  // other bone gets a quaternion track only — which is right, because a limb's
  // translation IS its bone length and taking the source's would stretch the
  // character to the source's proportions.
  //
  // The root is the one bone where translation is the PAYLOAD rather than a
  // proportion: it is the locomotion. Passing no `hip` meant no position track at
  // all, so a walk that travels 6.5 units in the source produced a character that
  // cycled its legs and never left the spot.
  //
  // `scale` matters just as much. `retarget` writes the SOURCE bone's world
  // position onto the target and then multiplies by `options.scale`
  // (SkeletonUtils.js:139-141). Unscaled, a source hip standing at 1.0 lands a
  // target whose hips belong at 0.51 exactly twice as high — which is #791 seen
  // from the other end. The ratio is read off the two bind poses rather than
  // configured, so it cannot drift from the rigs it describes — off their LEG
  // CHAINS specifically, because a hip bone's own offset is hip height only on a
  // rig whose root sits on the floor, and SOMA's is a nominal constant (#846).
  const hip = shallowestMapped(args.sourceBones, nameMap);
  // `args.targetBones`, not `targetSpecs`: the ratio is a property of the two
  // BIND poses, and this one is in hand before the retarget touches anything.
  const scale = retargetScale(hip, args.sourceBones, nameMap, args.targetBones);

  // Reconcile the two rigs' bone-axis conventions. Without this every bone but
  // the root receives an orientation unrelated to its own rest direction and the
  // character performs the motion lying down (#844). See
  // `restDirectionLocalOffsets` — it needs no reference pose, which is what keeps
  // the arms right as well as the spine (#845).
  //
  // The clip's FIRST frame is the source's reference pose, and it is what gives
  // a leaf bone its third degree of freedom (#853). A bone with a mapped child
  // is aligned by direction and never consults it; a bone without one — head,
  // hands, toe bases — has no direction to align and would otherwise inherit a
  // correction computed for a bone pointing somewhere else.
  const referenceTime = args.sourceClip.keyframes.reduce(
    (earliest, k) => Math.min(earliest, k.time),
    Number.POSITIVE_INFINITY,
  );
  const referencePose: Record<string, readonly [number, number, number]> = {};
  for (const keyframe of args.sourceClip.keyframes) {
    if (keyframe.time !== referenceTime) continue;
    const bone = args.sourceBones[keyframe.bone];
    if (bone) referencePose[bone.name] = keyframe.rotation;
  }
  const sourceReference = Number.isFinite(referenceTime)
    ? referenceWorldRotations(sourceBoneObjs, referencePose)
    : undefined;

  // ── RECONCILE THE TWO RESTS AS A WHOLE, WHEN THAT IS POSSIBLE AT ALL ──────
  //
  // Everything below composes as `T_b(t) = W_b(t) · Q_b` — the source bone's
  // world rotation, right-multiplied by a bone-local offset
  // (SkeletonUtils.js:127). That shape can express a difference of bone-axis
  // CONVENTION and cannot express a difference of body ORIENTATION, because the
  // latter is a conjugation. Copying world rotations between two rigs whose rests
  // face different ways turns a forward arm raise into a lateral one, and no
  // per-bone offset repairs it.
  //
  // So when the two rests do correspond as poses, the whole-rig part is lifted
  // out and applied where it can be: the source WRAPPER carries `R` on the left,
  // the offsets carry `R⁻¹` on the right, and the pipeline composes
  // `R · W_b(t) · R⁻¹ · B_b`. The wrapper is the right place for it — the clip
  // animates the bones, so a rotation put on the root BONE would be overwritten
  // frame by frame, while the wrapper is untouched by the mixer.
  //
  // `solveRestAlignment` returns null for the rests this project receives today
  // (they lay every bone on one axis, so there is no orientation to solve for),
  // and the per-bone direction alignment is kept unchanged for them.
  const restAlignment = solveRestAlignment(sourceBoneObjs, targetBoneObjs, targetToSource);
  if (restAlignment) {
    sourceWrap.quaternion.copy(restAlignment.rotation);
    sourceWrap.updateMatrixWorld(true);
  }

  const localOffsets = restAlignment
    ? // Uniform across every mapped bone, chain ends included: a rest that
      // supplies a body frame gives a leaf its third degree of freedom too, so
      // nothing here needs the clip's first frame as a stand-in neutral.
      alignedLocalOffsets(targetBoneObjs, targetToSource, restAlignment.rotation)
    : restDirectionLocalOffsets(sourceBoneObjs, targetBoneObjs, targetToSource, sourceReference);

  const retargetOptions: RetargetClipOptionsWithOffsets = {
    names: targetToSource,
    localOffsets,
    ...(hip !== null ? { hip, scale } : {}),
  };

  const retargeted: ThreeAnimationClip = threeRetargetClip(
    targetWrap,
    sourceWrap,
    sourceClip,
    retargetOptions,
  );

  const keyframes = clipToKeyframes(retargeted, targetSpecs);

  return {
    clipParams: {
      name: args.outputName ?? `${args.sourceClip.name}_retargeted`,
      duration: retargeted.duration > 0 ? retargeted.duration : args.sourceClip.duration,
      // Carried, not invented (#919). Every other field on this object derives
      // from the source; `loop` alone used to be a literal, so a one-shot motion —
      // a jump, a wave, a fall — silently became a looping one the moment it was
      // retargeted, with nothing in the UI saying the time domain had changed.
      loop: args.sourceClip.loop ?? true,
      keyframes,
    },
    // The RESOLVED map, not the argument — otherwise the report describes a
    // lookup that did not happen and calls a bound bone unmapped.
    unmappedSourceBones: findUnmappedSource(args.sourceBones, nameMap, args.targetBones),
    unboundTargetBones: findUnboundTarget(args.sourceBones, nameMap, args.targetBones),
  };
}

function findUnmappedSource(
  source: readonly BoneSpec[],
  nameMap: Readonly<Record<string, string>>,
  target: readonly BoneSpec[],
): string[] {
  const targetNames = new Set(target.map((b) => b.name));
  const out: string[] = [];
  for (const s of source) {
    const mappedTo = nameMap[s.name];
    if (mappedTo) {
      // If the user mapped to a name that doesn't exist on target,
      // that's still "unmapped" — the retarget will silently drop it.
      if (!targetNames.has(mappedTo)) out.push(s.name);
    } else if (!targetNames.has(s.name)) {
      // No map entry AND no name match in target.
      out.push(s.name);
    }
  }
  return out;
}

function findUnboundTarget(
  source: readonly BoneSpec[],
  nameMap: Readonly<Record<string, string>>,
  target: readonly BoneSpec[],
): string[] {
  const claimed = new Set<string>();
  for (const s of source) {
    const mappedTo = nameMap[s.name] ?? s.name;
    claimed.add(mappedTo);
  }
  return target.filter((t) => !claimed.has(t.name)).map((t) => t.name);
}

/**
 * The source bone that drives the target's root: the shallowest source bone the
 * name map places on a bone the target actually has.
 *
 * Derived rather than spelled. A hardcoded `Hips` is right for SOMA and Mixamo
 * and wrong for anything else, and it would be wrong SILENTLY — the clip would
 * still retarget, still bind, and still refuse to travel, which is precisely the
 * failure this exists to end.
 */
function shallowestMapped(
  sourceBones: readonly BoneSpec[],
  nameMap: Readonly<Record<string, string>>,
): string | null {
  const depthOf = (i: number): number => {
    let d = 0;
    for (let cur = sourceBones[i]?.parent ?? -1; cur >= 0; cur = sourceBones[cur]?.parent ?? -1)
      d++;
    return d;
  };
  let best: string | null = null;
  let bestDepth = Number.POSITIVE_INFINITY;
  for (let i = 0; i < sourceBones.length; i++) {
    const name = sourceBones[i].name;
    if (nameMap[name] === undefined) continue;
    const d = depthOf(i);
    if (d < bestDepth) {
      bestDepth = d;
      best = name;
    }
  }
  return best;
}

/**
 * The factor that carries a SOURCE-space length into TARGET space — what
 * `options.scale` multiplies the root's translation by
 * (`SkeletonUtils.js:139-141`).
 *
 * The quantity the retarget actually needs is HIP HEIGHT: `retarget` writes the
 * source hip's world position onto the target, and at rest that position is the
 * hips' height above the floor. Hip height is not readable pose-free, so this
 * derives it from the LEG CHAIN — thigh plus shin — which is the pose-free
 * stand-in for it: both are bone lengths, so neither moves when a rig is posed
 * and neither depends on where a rig's root happens to sit.
 *
 * That last independence is the whole point. The previous basis, the hip bone's
 * own parent-relative offset, is only equal to hip height when the root sits on
 * the floor directly below the hips. Measured on the pair this pipeline actually
 * carries:
 *
 *     target (Tripo)   Root→Hips 0.5102   true hip height 0.4984   agrees
 *     source (SOMA)    Root→Hips 1.0000   true hip height 0.8708   15% apart
 *
 * SOMA's `Root→Hips` is a nominal calibration constant — literally `100.0` in
 * BVH units — and not a measurement of the skeleton at all. The resulting scale
 * was 0.5102 where the leg chain gives 0.5793: about 13% small, so the character
 * travelled 13% less than its own legs were stepping. That is the foot-slide
 * signature, and it is quiet enough to read as "nearly right" ([[V323]] — a proxy
 * quantity is only valid where the identity it stands for holds, and it will hold
 * on the rig you tested).
 *
 * Where the leg is unreadable — a rig with no two-segment limb below the hips,
 * or one the name map does not cover that far — this falls back to the hip
 * offset. Falling back to 1 instead would be worse than the bug it replaces: an
 * unscaled source hip standing at 1.0 lands a target whose hips belong at 0.51
 * exactly twice as high, which is #791 seen from the other end.
 */
export function retargetScale(
  hip: string | null,
  sourceBones: readonly BoneSpec[],
  nameMap: Readonly<Record<string, string>>,
  targetBones: readonly BoneSpec[],
): number {
  return (
    legChainRatio(hip, sourceBones, nameMap, targetBones) ??
    hipOffsetRatio(hip, sourceBones, nameMap, targetBones)
  );
}

const boneLength = (p: readonly number[]): number => Math.hypot(p[0], p[1], p[2]);

/** child indices by parent index; parentless bones sit under -1. */
function childrenByParent(bones: readonly BoneSpec[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (let i = 0; i < bones.length; i++) {
    const siblings = out.get(bones[i].parent);
    if (siblings) siblings.push(i);
    else out.set(bones[i].parent, [i]);
  }
  return out;
}

/**
 * The accumulated rest length of the path from `ancestor` down to `descendant`,
 * or null when `descendant` is not below `ancestor`.
 *
 * Summing the offsets ALONG the path rather than reading one bone's offset is
 * what makes the measurement survive a rig that subdivides the same anatomy into
 * more joints than its partner — a thigh split by a twist bone still measures as
 * one thigh.
 */
function chainLength(
  bones: readonly BoneSpec[],
  ancestor: number,
  descendant: number,
): number | null {
  let total = 0;
  let cur = descendant;
  // Bounded by the bone count so a malformed parent cycle cannot hang the import.
  for (let step = 0; step < bones.length; step++) {
    const bone = bones[cur];
    if (bone === undefined) return null;
    total += boneLength(bone.position);
    if (bone.parent === ancestor) return total;
    cur = bone.parent;
    if (cur < 0) return null;
  }
  return null;
}

/**
 * The first MAPPED bone on every downward path out of `from`.
 *
 * Descending past an unmapped joint is deliberate: two rigs rarely subdivide a
 * limb identically, and an intermediate joint the map does not name must not
 * hide the mapped bone beneath it.
 */
function nearestMappedBelow(
  bones: readonly BoneSpec[],
  children: ReadonlyMap<number, readonly number[]>,
  from: number,
  isMapped: (name: string) => boolean,
): number[] {
  const found: number[] = [];
  const stack: number[] = [...(children.get(from) ?? [])];
  while (stack.length > 0) {
    const i = stack.pop() as number;
    if (isMapped(bones[i].name)) found.push(i);
    else stack.push(...(children.get(i) ?? []));
  }
  return found;
}

/**
 * Thigh + shin summed over the legs, as a target/source ratio — or null when
 * either rig will not yield a leg.
 *
 * THE LEG IS DERIVED, NOT SPELLED. A hardcoded `LeftUpLeg` would be right for
 * Mixamo and wrong for the five other presets in `boneNameMaps.ts`, which spell
 * the same bone `thigh.L`, `LeftUpperLeg`, `DEF-thigh.L` and `LeftLeg` (SOMA,
 * where `LeftLeg` is the THIGH). The rule instead: among the mapped limbs
 * hanging off the hips, the legs are the ones with the longest two-segment
 * chains. Below the pelvis a humanoid has exactly three — a spine and two legs —
 * and the spine's first two joints are short by construction. Measured on the
 * real pair: spine 0.147 against legs 0.855 on the source, spine 0.146 against
 * legs 0.495 on the target.
 *
 * BOTH LEGS ARE SUMMED, AND THAT IS NOT TIDINESS. Taking the single longest was
 * tried first and is a coin flip: this pair's source legs differ by 0.1%
 * (0.8563 against 0.8553) while its TARGET legs differ by 2.6% (0.5084 against
 * 0.4954), so a rounding-scale difference on one rig chose between two answers
 * 2.5% apart on the other. Summing both is insensitive to which leg is longer
 * and to how asymmetric a generated rig turns out to be.
 *
 * IT STOPS AT THE ANKLE ON PURPOSE. Feet are the one part of a humanoid whose
 * proportions are not shared: this pair's toe segments are 0.142 against 0.036, a
 * factor of four, and including them drags the ratio to 0.53 against the 0.59
 * that thigh and shin agree on. Two long bones both rigs scale together is the
 * whole basis; a third that they do not is noise. The hip→thigh offset is
 * excluded for the same reason — it is pelvis half-width, not leg, and it differs
 * by more than a factor of two here (0.134 against 0.057).
 *
 * The residual, stated honestly: leg chain runs knee-to-ankle where hip height
 * runs to the FLOOR, so it reads slightly long — 0.586 here against a directly
 * measured 0.572. That is 2% where the hip offset it replaces was 11% under, and
 * unlike hip height it needs no reference pose on a source whose rest is
 * degenerate.
 */
function legChainRatio(
  hip: string | null,
  sourceBones: readonly BoneSpec[],
  nameMap: Readonly<Record<string, string>>,
  targetBones: readonly BoneSpec[],
): number | null {
  if (hip === null) return null;
  const sourceHip = sourceBones.findIndex((b) => b.name === hip);
  if (sourceHip < 0) return null;

  const sourceChildren = childrenByParent(sourceBones);
  const isMapped = (name: string): boolean => nameMap[name] !== undefined;

  // The SAME bones on the target, reached through the map rather than by running
  // the rule twice — two independent derivations could pick two limbs that do not
  // correspond, and the ratio would then compare an arm to a leg.
  const onTarget = (sourceIndex: number): number => {
    const targetName = nameMap[sourceBones[sourceIndex].name];
    return targetName === undefined ? -1 : targetBones.findIndex((b) => b.name === targetName);
  };

  const limbs: { source: number; target: number }[] = [];
  for (const thigh of nearestMappedBelow(sourceBones, sourceChildren, sourceHip, isMapped)) {
    // Exactly one mapped bone below, twice: a branch is a pelvis or a foot, not
    // a knee, and guessing which fork is the leg is the ambiguity this avoids.
    const knees = nearestMappedBelow(sourceBones, sourceChildren, thigh, isMapped);
    if (knees.length !== 1) continue;
    const ankles = nearestMappedBelow(sourceBones, sourceChildren, knees[0], isMapped);
    if (ankles.length !== 1) continue;
    const upper = chainLength(sourceBones, thigh, knees[0]);
    const lower = chainLength(sourceBones, knees[0], ankles[0]);
    if (upper === null || lower === null) continue;

    const [tThigh, tKnee, tAnkle] = [thigh, knees[0], ankles[0]].map(onTarget);
    if (tThigh < 0 || tKnee < 0 || tAnkle < 0) continue;
    const tUpper = chainLength(targetBones, tThigh, tKnee);
    const tLower = chainLength(targetBones, tKnee, tAnkle);
    if (tUpper === null || tLower === null) continue;

    limbs.push({ source: upper + lower, target: tUpper + tLower });
  }

  // Longest first, then the two legs. A rig that offers only one keeps it — half
  // a measurement of the right quantity still beats a whole one of the wrong one.
  const legs = limbs.sort((a, b) => b.source - a.source).slice(0, 2);
  if (legs.length === 0) return null;
  const source = legs.reduce((sum, l) => sum + l.source, 0);
  const target = legs.reduce((sum, l) => sum + l.target, 0);
  return source > 1e-9 ? target / source : null;
}

/**
 * The ratio of the two rigs' HIP OFFSETS — the fallback basis, named for what it
 * measures rather than for what it is standing in for.
 *
 * A hip bone's parent-relative offset is its height above its parent, which is
 * hip height only when that parent sits on the floor. It does on rigs authored
 * that way and it does not on SOMA ([[V323]]); it is kept because a rig too
 * simple to yield a leg chain still needs SOME basis, and the hips are the one
 * bone every name map names. A source root at its parent's origin carries no
 * height to scale by, and 1 is the honest answer there rather than a division by
 * zero.
 */
function hipOffsetRatio(
  hip: string | null,
  sourceBones: readonly BoneSpec[],
  nameMap: Readonly<Record<string, string>>,
  targetSpecs: readonly BoneSpec[],
): number {
  if (hip === null) return 1;
  const src = sourceBones.find((b) => b.name === hip);
  const tgt = targetSpecs.find((b) => b.name === nameMap[hip]);
  if (!src || !tgt) return 1;
  const srcLen = boneLength(src.position);
  return srcLen > 1e-9 ? boneLength(tgt.position) / srcLen : 1;
}
