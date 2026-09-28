// The CLIP shape of a BVH motion — a Skeleton and an AnimationClip wired to it — for tests whose
// subject is a clip: what a project saved before #1211 carries, and what generated motion still is.
//
// A dropped .bvh no longer becomes this (it lands as keys on a base pose layer,
// `buildBvhImportOps`), so product code does not import it.

import { BVH_UNIT_SCALE_METRES, parseBvh } from '../core/import/bvh';
import type { Op } from '../core/dag/types';

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
      { type: 'addNode', nodeId: clip, nodeType: 'AnimationClip', params: parsed.clipParams },
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
