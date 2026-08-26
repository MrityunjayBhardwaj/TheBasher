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
 * Rewrite a name map's SOURCE keys to the names the source skeleton actually uses,
 * matching separator-insensitively only when an exact key is absent.
 *
 * Deliberately conservative in two ways. An exact key always wins, so an author who
 * spelled a name precisely is never second-guessed. And a canonical form shared by
 * two different source bones is left UNRESOLVED rather than guessed at — an ambiguous
 * auto-match would be a silent wrong answer, which is the very failure class this
 * function exists to remove.
 */
export function resolveNameMapToSource(
  nameMap: Readonly<Record<string, string>>,
  sourceBones: readonly BoneSpec[],
): Record<string, string> {
  const exact = new Set(sourceBones.map((b) => b.name));
  const byCanonical = new Map<string, string | null>();
  for (const b of sourceBones) {
    const key = canonicalBoneKey(b.name);
    // null marks "two bones share this canonical form" — ambiguous, so no match.
    byCanonical.set(key, byCanonical.has(key) ? null : b.name);
  }

  const out: Record<string, string> = {};
  for (const [sourceName, targetName] of Object.entries(nameMap)) {
    if (exact.has(sourceName)) {
      out[sourceName] = targetName;
      continue;
    }
    const hit = byCanonical.get(canonicalBoneKey(sourceName));
    out[hit ?? sourceName] = targetName;
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
  // Resolve the map against the names this source skeleton actually carries
  // BEFORE inverting, so a map authored in either road's spelling lands.
  const nameMap = resolveNameMapToSource(args.nameMap, args.sourceBones);
  const targetToSource: Record<string, string> = {};
  for (const [sourceName, targetName] of Object.entries(nameMap)) {
    targetToSource[targetName] = sourceName;
  }
  const retargeted: ThreeAnimationClip = threeRetargetClip(targetWrap, sourceWrap, sourceClip, {
    names: targetToSource,
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
