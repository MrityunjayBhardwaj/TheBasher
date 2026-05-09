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
import type {
  AnimationKeyframe,
  BoneSpec,
} from '../../nodes/types';
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
export function retargetClip(args: RetargetArgs): RetargetResult {
  const { skeleton: sourceSkeleton, bones: sourceBoneObjs } = specToThreeSkeleton(
    args.sourceBones,
  );
  const { skeleton: targetSkeleton, bones: targetBoneObjs } = specToThreeSkeleton(
    args.targetBones,
  );

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
  const targetToSource: Record<string, string> = {};
  for (const [sourceName, targetName] of Object.entries(args.nameMap)) {
    targetToSource[targetName] = sourceName;
  }
  const retargeted: ThreeAnimationClip = threeRetargetClip(
    targetWrap,
    sourceWrap,
    sourceClip,
    { names: targetToSource },
  );

  const targetSpecs = bonesToSpec(targetBoneObjs);
  const keyframes = clipToKeyframes(retargeted, targetSpecs);

  return {
    clipParams: {
      name: args.outputName ?? `${args.sourceClip.name}_retargeted`,
      duration: retargeted.duration > 0 ? retargeted.duration : args.sourceClip.duration,
      loop: true,
      keyframes,
    },
    unmappedSourceBones: findUnmappedSource(args.sourceBones, args.nameMap, args.targetBones),
    unboundTargetBones: findUnboundTarget(args.sourceBones, args.nameMap, args.targetBones),
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
