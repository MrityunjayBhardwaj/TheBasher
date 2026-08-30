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
import { AnimationClip as ThreeAnimationClip, SkinnedMesh } from 'three';
import type { AnimationKeyframe, BoneSpec } from '../../nodes/types';
import {
  bonesToSpec,
  clipToKeyframes,
  paramsToThreeClip,
  specToThreeSkeleton,
} from './threeAdapter';

export interface RetargetArgs {
  /** Source bone hierarchy (e.g. Mixamo). */
  readonly sourceBones: readonly BoneSpec[];
  /** Source AnimationClip params. */
  readonly sourceClip: {
    readonly name: string;
    readonly duration: number;
    readonly keyframes: readonly AnimationKeyframe[];
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
  // configured, so it cannot drift from the rigs it describes.
  const hip = shallowestMapped(args.sourceBones, nameMap);
  // `args.targetBones`, not `targetSpecs`: the ratio is a property of the two
  // BIND poses, and this one is in hand before the retarget touches anything.
  const hipScale = hipHeightRatio(hip, args.sourceBones, nameMap, args.targetBones);

  const retargeted: ThreeAnimationClip = threeRetargetClip(targetWrap, sourceWrap, sourceClip, {
    names: targetToSource,
    ...(hip !== null ? { hip, scale: hipScale } : {}),
  });

  const targetSpecs = bonesToSpec(targetBoneObjs);
  const keyframes = clipToKeyframes(retargeted, targetSpecs);

  return {
    clipParams: {
      name: args.outputName ?? `${args.sourceClip.name}_retargeted`,
      duration: retargeted.duration > 0 ? retargeted.duration : args.sourceClip.duration,
      loop: true,
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
 * How much smaller the target's root sits than the source's.
 *
 * Their bind translations are their heights above their parents, so the ratio is
 * the factor that turns source-space locomotion into target-space locomotion. A
 * source root at its parent's origin carries no height to scale by, and 1 is the
 * honest answer there rather than a division by zero.
 */
function hipHeightRatio(
  hip: string | null,
  sourceBones: readonly BoneSpec[],
  nameMap: Readonly<Record<string, string>>,
  targetSpecs: readonly BoneSpec[],
): number {
  if (hip === null) return 1;
  const src = sourceBones.find((b) => b.name === hip);
  const tgt = targetSpecs.find((b) => b.name === nameMap[hip]);
  if (!src || !tgt) return 1;
  const len = (p: readonly number[]) => Math.hypot(p[0], p[1], p[2]);
  const srcLen = len(src.position);
  return srcLen > 1e-9 ? len(tgt.position) / srcLen : 1;
}
