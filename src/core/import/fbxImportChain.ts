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
import type { DagState } from '../../core/dag/state';

export interface FbxImportChainResult {
  readonly ops: Op[];
  readonly skeletonId: string;
  readonly clipId: string;
}

export interface FbxImportChainArgs {
  readonly data: ArrayBuffer | string;
  readonly name?: string;
  readonly ids?: { skeleton: string; clip: string };
  readonly timeSourceId?: string;
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

export function buildFbxImportOps(args: FbxImportChainArgs, state: DagState): FbxImportChainResult {
  const parsed = parseFbx(args.data, args.name ?? 'imported-fbx');

  const ids = args.ids ?? {
    skeleton: uniqueId('fbx_skel'),
    clip: uniqueId('fbx_clip'),
  };

  const timeId = args.timeSourceId ?? findTimeSource(state);
  if (!timeId) {
    throw new Error(
      'No TimeSource node in DAG. Default projects seed `n_time` (PR #40); ' +
        'this project has been mutated to remove it. Add a TimeSource node ' +
        'before importing animation.',
    );
  }

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
    {
      type: 'connect',
      from: { node: timeId, socket: 'out' },
      to: { node: ids.clip, socket: 'time' },
    },
  ];

  return { ops, skeletonId: ids.skeleton, clipId: ids.clip };
}

function findTimeSource(state: DagState): string | null {
  for (const node of Object.values(state.nodes)) {
    if (node.type === 'TimeSource') return node.id;
  }
  return null;
}
