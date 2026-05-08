// BVH import → Op chain.
//
// Produces a deterministic Op[] that adds a Skeleton + AnimationClip
// pair from a parsed BVH and wires the clip to the project's existing
// TimeSource (n_time, seeded by DEFAULT_OPS post-#40). Caller dispatches
// via dispatchAtomic so the import lands as one Cmd+Z entry.
//
// Library UI / drop-zone routing lands in Wave B alongside FBX.

import { parseBvh } from './bvh';
import type { Op } from '../../core/dag/types';
import type { DagState } from '../../core/dag/state';

export interface BvhImportChainResult {
  readonly ops: Op[];
  readonly skeletonId: string;
  readonly clipId: string;
}

export interface BvhImportChainArgs {
  readonly text: string;
  readonly name?: string;
  /** Caller-supplied ids — tests pass deterministic ones. */
  readonly ids?: { skeleton: string; clip: string };
  /**
   * Optional explicit TimeSource id. When omitted the chain searches the
   * state for one; throws when none is present (the seed includes
   * `n_time` but a stripped project must add one first).
   */
  readonly timeSourceId?: string;
}

let counter = 0;
function uniqueId(prefix: string): string {
  counter += 1;
  // Match dropChain.ts pattern: counter+random suffix for cross-restart
  // collision avoidance. Safe under V2 (ids are UI artifacts, not
  // pure-evaluator values).
  const r = Math.floor(Math.random() * 1e6).toString(36);
  return `n_${prefix}_${counter.toString(36)}${r}`;
}

/** Test-only — reset the monotonic counter so id sequences are reproducible. */
export function __resetBvhImportCounterForTests(): void {
  counter = 0;
}

export function buildBvhImportOps(
  args: BvhImportChainArgs,
  state: DagState,
): BvhImportChainResult {
  const parsed = parseBvh(args.text, args.name ?? 'imported-bvh');

  const ids = args.ids ?? {
    skeleton: uniqueId('bvh_skel'),
    clip: uniqueId('bvh_clip'),
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
