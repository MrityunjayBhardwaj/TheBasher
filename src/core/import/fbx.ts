// FBX import — converts three's FBXLoader output to our DAG-native
// AnimationClipParams + Skeleton bone list.
//
// THREE.FBXLoader.parse(buffer) returns a THREE.Group whose subtree may
// contain SkinnedMesh children (each with their own .skeleton) and a
// .animations[] array of THREE.AnimationClip. We pick the first
// non-empty skeleton and the first clip — multi-skeleton / multi-clip
// FBX files are rare in director workflows; revisit if a real authoring
// case appears.
//
// SkinnedMesh geometry import is deferred to a later wave / phase.
// The skeleton + clip alone are enough to drive Mixamo retargeting onto
// existing rigs — which IS the load-bearing P3.1 use case.
//
// THREE.FBXLoader is a full-JS parser (no FBX SDK). Some proprietary
// FBX features (NURBS, certain subdivs) won't parse — fail loudly per
// project_p31_plan honesty contract.
//
// REF: THESIS §42.1 (P3.1); project_p31_plan.md.

import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import type { Bone, AnimationClip as ThreeAnimationClip, SkinnedMesh } from 'three';
import type { AnimationKeyframe, BoneSpec } from '../../nodes/types';
import { bonesToSpec, clipToKeyframes, type ClipShape } from './threeAdapter';

export interface FbxSkeletonParams {
  readonly bones: readonly BoneSpec[];
}

export interface FbxClipParams {
  readonly name: string;
  readonly duration: number;
  readonly loop: boolean;
  readonly keyframes: readonly AnimationKeyframe[];
}

export interface FbxImportResult {
  readonly skeletonParams: FbxSkeletonParams;
  readonly clipParams: FbxClipParams;
}

/**
 * Parse an FBX payload (ArrayBuffer for binary, string for ASCII).
 * Throws when three's FBXLoader rejects the input.
 */
export function parseFbx(input: ArrayBuffer | string, name = 'imported-fbx'): FbxImportResult {
  const loader = new FBXLoader();
  const group = loader.parse(input as ArrayBuffer, '');
  // FBXLoader.parse signature: (data: ArrayBuffer, path: string) → Group
  // The path is used to resolve textures; we pass empty since we don't
  // import meshes/textures in this wave.

  const bones = extractBones(group);
  if (bones.length === 0) {
    throw new Error('FBX contains no skeleton or skinned mesh — nothing to import.');
  }
  const skeletonBones = bonesToSpec(bones);

  // First animation clip wins. group.animations[] is THREE.AnimationClip[].
  const clip = (group as unknown as { animations: ThreeAnimationClip[] }).animations[0];
  if (!clip) {
    // Skeleton-only FBX — rare but valid (T-pose import). Empty clip.
    return {
      skeletonParams: { bones: skeletonBones },
      clipParams: { name, duration: 0, loop: false, keyframes: [] },
    };
  }

  const keyframes = clipToKeyframes(clip as ClipShape, skeletonBones);
  return {
    skeletonParams: { bones: skeletonBones },
    clipParams: {
      name,
      duration: clip.duration > 0 ? clip.duration : 1,
      loop: true,
      keyframes,
    },
  };
}

/**
 * Walk the imported Group to find the first non-empty skeleton.
 * Preference order:
 *   1. Any SkinnedMesh.skeleton (most common — Mixamo, character FBXs)
 *   2. Root-level bones (skeleton-only FBX)
 */
function extractBones(group: import('three').Group): Bone[] {
  let found: Bone[] | null = null;
  group.traverse((obj) => {
    if (found) return;
    const sm = obj as unknown as SkinnedMesh;
    if ((obj as unknown as SkinnedMesh).isSkinnedMesh && sm.skeleton?.bones?.length) {
      found = [...sm.skeleton.bones];
    }
  });
  if (found) return found;

  // Fallback: collect every Bone in the subtree.
  const bones: Bone[] = [];
  group.traverse((obj) => {
    if ((obj as unknown as Bone).isBone) bones.push(obj as Bone);
  });
  return bones;
}
