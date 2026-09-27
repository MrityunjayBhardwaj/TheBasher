// FBX import — converts three's FBXLoader output to our DAG-native
// Skeleton bone list, the first clip's raw tracks (what the import road's base
// pose layer is built from, #1211), and AnimationClipParams (the clip shape
// retarget tests and saved projects still read).
//
// 🔴 #1279 — three r169 reads a bone's rotation wrong when its X, Y and Z euler
// curves are keyed at different times (Blender's default export simplifies each
// axis on its own): `interpolateRotations` pairs the axes by index. The tracks
// here carry that error; `fbxImportChain.test.ts` pins it until it is fixed.
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
import { bonesToSpec, clipToKeyframes, parseTrackName, type ClipShape } from './threeAdapter';
import type { ClipLoop } from '../../nodes/clipLoop';

export interface FbxSkeletonParams {
  readonly bones: readonly BoneSpec[];
}

export interface FbxClipParams {
  readonly name: string;
  readonly duration: number;
  readonly loop: ClipLoop;
  readonly keyframes: readonly AnimationKeyframe[];
}

/**
 * #1211 — one of three's tracks as the file keyed it: a bone (sanitised as `bonesToSpec` spells it),
 * the property, and the key times and flat values, untouched. What the import road's base pose layer
 * is built from, so the file's own key times and its scale survive; `clipParams` merges each bone's
 * times and drops scale.
 */
export interface FbxTrack {
  readonly bone: string;
  /** three's property name: `position`, `quaternion` (xyzw), `scale`, or anything else it wrote. */
  readonly property: string;
  readonly times: readonly number[];
  readonly values: readonly number[];
}

export interface FbxImportResult {
  readonly skeletonParams: FbxSkeletonParams;
  readonly clipParams: FbxClipParams;
  /** The first clip's tracks, in three's order; a track whose name does not parse is left out. */
  readonly tracks: readonly FbxTrack[];
  /** Tracks of the first clip whose name does not parse as `node.property` — counted, not read. */
  readonly unparsedTracks: number;
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
      clipParams: { name, duration: 0, loop: 'hold', keyframes: [] },
      tracks: [],
      unparsedTracks: 0,
    };
  }

  const keyframes = clipToKeyframes(clip as ClipShape, skeletonBones);
  const tracks: FbxTrack[] = [];
  let unparsedTracks = 0;
  for (const track of clip.tracks) {
    const parsed = parseTrackName(track.name);
    if (!parsed) {
      unparsedTracks += 1;
      continue;
    }
    tracks.push({
      bone: parsed.bone,
      property: parsed.property,
      times: Array.from(track.times),
      values: Array.from(track.values),
    });
  }
  return {
    skeletonParams: { bones: skeletonBones },
    tracks,
    unparsedTracks,
    clipParams: {
      name,
      duration: clip.duration > 0 ? clip.duration : 1,
      // #927 — an assertion about the file, not a value from it. See the long
      // note at the same decision in `bvh.ts`: no FBX animation stack states that
      // its motion returns to its start, the reference systems default to holding
      // the endpoint, and since #924 an asserted `true` makes a one-shot travel
      // away from its own end instead of stopping there. The skeleton-only branch
      // above has always said `false`; these two now agree.
      loop: 'hold',
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
