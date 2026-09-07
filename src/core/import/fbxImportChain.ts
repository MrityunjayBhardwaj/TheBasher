// FBX import → Op chain. Mirrors bvhImportChain — the FBX path emits
// the same Skeleton + AnimationClip + connect chain as BVH; the only
// difference is the parser + the input type (ArrayBuffer vs string).
//
// Future refactor (Wave D or after): both chains share enough structure
// that a single `buildClipImportOps(parsed, state, ids)` helper would
// fit. Hold off until a third importer (glTF clips? Alembic?) makes the
// abstraction earn its keep.

import { parseFbx } from './fbx';
import type { Op } from '../../core/dag/types';

export interface FbxImportChainResult {
  readonly ops: Op[];
  readonly skeletonId: string;
  readonly clipId: string;
}

export interface FbxImportChainArgs {
  readonly data: ArrayBuffer | string;
  readonly name?: string;
  readonly ids?: { skeleton: string; clip: string };
}

let counter = 0;
function uniqueId(prefix: string): string {
  counter += 1;
  const r = Math.floor(Math.random() * 1e6).toString(36);
  return `n_${prefix}_${counter.toString(36)}${r}`;
}

export function __resetFbxImportCounterForTests(): void {
  counter = 0;
}

export function buildFbxImportOps(args: FbxImportChainArgs): FbxImportChainResult {
  const parsed = parseFbx(args.data, args.name ?? 'imported-fbx');

  const ids = args.ids ?? {
    skeleton: uniqueId('fbx_skel'),
    clip: uniqueId('fbx_clip'),
  };

  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: ids.skeleton,
      nodeType: 'Skeleton',
      params: { bones: parsed.skeletonParams.bones },
    },
    {
      type: 'addNode',
      nodeId: ids.clip,
      nodeType: 'AnimationClip',
      params: parsed.clipParams,
    },
    {
      type: 'connect',
      from: { node: ids.skeleton, socket: 'out' },
      to: { node: ids.clip, socket: 'skeleton' },
    },
  ];

  return { ops, skeletonId: ids.skeleton, clipId: ids.clip };
}
