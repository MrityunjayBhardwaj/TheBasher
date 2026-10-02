// The CLIP shape of a BVH motion — a Skeleton and an AnimationClip wired to it — for tests whose
// subject is a clip: what a project saved before #1211 carries, and what generated motion still is.
//
// A dropped .bvh no longer becomes this (it lands as keys on a base pose layer,
// `buildBvhImportOps`), so product code does not import it.

import { BVH_UNIT_SCALE_METRES, parseBvh } from '../core/import/bvh';
import { posesFromKeyframes } from '../core/import/keyframePoses';
import type { Op } from '../core/dag/types';
import type { ClipLoop } from '../nodes/clipLoop';
import type { AnimationKeyframe, BoneSpec, MotionPose } from '../nodes/types';

/**
 * A parsed motion file as `AnimationClip` params. A parser hands back keys by bone index with euler
 * angles; a clip stores timed poses by bone name (#1227), through the product's own conversion.
 */
export function clipNodeParams(parsed: {
  readonly skeletonParams: { readonly bones: readonly BoneSpec[] };
  readonly clipParams: {
    readonly name: string;
    readonly duration: number;
    readonly loop: ClipLoop;
    readonly keyframes: readonly AnimationKeyframe[];
  };
}): { name: string; duration: number; loop: ClipLoop; poses: MotionPose[] } {
  const { name, duration, loop, keyframes } = parsed.clipParams;
  return {
    name,
    duration,
    loop,
    poses: posesFromKeyframes(keyframes, parsed.skeletonParams.bones),
  };
}

export function buildBvhClipOps(args: {
  readonly text: string;
  readonly name?: string;
  readonly ids: { skeleton: string; clip: string };
  readonly unitScale?: number;
}): { ops: Op[]; skeletonId: string; clipId: string } {
  const parsed = parseBvh(
    args.text,
    args.name ?? 'imported-bvh',
    args.unitScale ?? BVH_UNIT_SCALE_METRES,
  );
  const { skeleton, clip } = args.ids;
  return {
    ops: [
      {
        type: 'addNode',
        nodeId: skeleton,
        nodeType: 'Skeleton',
        params: { bones: parsed.skeletonParams.bones },
      },
      {
        type: 'addNode',
        nodeId: clip,
        nodeType: 'AnimationClip',
        params: clipNodeParams(parsed),
      },
      {
        type: 'connect',
        from: { node: skeleton, socket: 'out' },
        to: { node: clip, socket: 'skeleton' },
      },
    ],
    skeletonId: skeleton,
    clipId: clip,
  };
}
