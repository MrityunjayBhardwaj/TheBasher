// BVH import — converts three's BVHLoader output to our DAG-native
// AnimationClipParams + Skeleton bone list.
//
// Design choice: this module is one of two places (alongside fbx.ts)
// where THREE.AnimationClip / THREE.Skeleton instances exist in our
// codebase. Both immediately project into POJO params shapes via
// threeAdapter.ts. The DAG never holds THREE objects (V2 — pure-flag
// determinism would break since THREE objects carry mutable state).
//
// REF: THESIS §42.1 (P3.1 — Animation import); project_p31_plan.md;
//      vyapti V2 (purity), V3 (time-as-socket).

import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';
import type { AnimationKeyframe, BoneSpec } from '../../nodes/types';
import { bonesToSpec, clipToKeyframes } from './threeAdapter';

export interface BvhSkeletonParams {
  readonly bones: readonly BoneSpec[];
}

export interface BvhClipParams {
  readonly name: string;
  readonly duration: number;
  readonly loop: boolean;
  readonly keyframes: readonly AnimationKeyframe[];
}

export interface BvhImportResult {
  readonly skeletonParams: BvhSkeletonParams;
  readonly clipParams: BvhClipParams;
}

/**
 * Parse a BVH text payload. Throws when three's BVHLoader rejects the
 * input — the caller surfaces the error (drop chain shows a toast,
 * Mutator returns gate-4 rejection).
 */
export function parseBvh(text: string, name = 'imported-bvh'): BvhImportResult {
  const loader = new BVHLoader();
  const parsed = loader.parse(text);

  const bones = bonesToSpec(parsed.skeleton.bones);
  const keyframes = clipToKeyframes(parsed.clip, bones);

  return {
    skeletonParams: { bones },
    clipParams: {
      name,
      duration: parsed.clip.duration > 0 ? parsed.clip.duration : 1,
      loop: true,
      keyframes,
    },
  };
}
