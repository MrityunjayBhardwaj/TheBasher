// The cook that lands a generated clip where the render band can actually see it
// (#935, the remaining half of #902).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS AT ALL — MEASURED, NOT ARGUED
// ─────────────────────────────────────────────────────────────────────────────
// `MotionGenerate` evaluates to an `AnimationClipValue`. Nothing that drives
// pixels reads an `AnimationClip` VALUE. Every one of them — the render band,
// the channel mint, the dopesheet, the format migration — goes through
// `boundClipsForAsset`, which is deliberately pure over PARAMS and never calls
// `evaluate()`, because the migration runs it on raw saved JSON long before an
// evaluator exists.
//
// Observed on one graph with one node swapped in the `RetargetClip.sourceClip`
// slot, the `AnimationClip` arm present precisely so the fixture is known to be
// able to exhibit the property:
//
//   AnimationClip   -> boundClips=1  keyframes=4  retarget.sourceNode=AnimationClip
//   MotionGenerate  -> boundClips=0  keyframes=0  retarget.sourceNode=null
//
// So the producer's output is copied into an ordinary `AnimationClip` node's
// params, and downstream cannot tell the result from a dropped `.bvh` because
// there is no difference. This is the shape `ComfyUIWorkflow` uses one domain
// over: the node describes the request, a separate pass lands the artefact.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT RETURNS OPS INSTEAD OF DISPATCHING
// ─────────────────────────────────────────────────────────────────────────────
// Same contract as `buildGeneratedMotionOps` and every import road: the caller
// dispatches atomically, so a cook is ONE undo entry rather than one per param.
// It also keeps this function pure over the state it is handed, which is what
// lets it be falsified without a store.
//
// ─────────────────────────────────────────────────────────────────────────────
// LOCK / FREEZE, AND WHY IT FALLS OUT RATHER THAN BEING BOLTED ON
// ─────────────────────────────────────────────────────────────────────────────
// Dragging a control point changes the producer's request hash, so its
// `evaluate` returns a `pending` clip — `duration: 0`, no keyframes. If the
// render band read that value, a drag would BLANK the motion until someone paid
// for a regeneration. It reads the sink's params instead, and this cook only
// ever writes a `ready` result, so the last landed motion keeps playing and the
// stale hash is what says it is out of date. The policy is the data model.
//
// REF: src/nodes/MotionGenerate.ts (the producer + `motionRequestHash`);
//      src/nodes/AnimationClip.ts (the `source` socket + `sourceHash` param);
//      src/app/asset/resolveMotionGenerate.ts (the pass that performs the call);
//      src/app/animate/boundClipsForAsset.ts (the params-only read band);
//      issues #935, #902.

import { evaluate } from '../../core/dag/evaluator';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { edgeTarget } from '../animate/graphNodes';
import type { AnimationClipValue } from '../../nodes/types';

/** One sink whose params are behind its producer, and the hash that will fix it. */
export interface StaleClip {
  readonly clipId: string;
  readonly producerId: string;
  readonly requestHash: string;
}

/**
 * Every `AnimationClip` wired to a producer, with whether its params are current.
 *
 * Returned as rows rather than a count so a caller can say WHICH clip is stale.
 * A bare "1 stale" cannot distinguish one clip waiting on a generation from one
 * clip whose generation failed, and those are different things to a director.
 */
export interface ClipBakeState {
  readonly clipId: string;
  readonly producerId: string;
  /** `ready` | `pending` | `failed`, or `null` when the producer evaluated to no
   *  generation state at all — which a plain `AnimationClip` upstream would. */
  readonly status: string | null;
  /** True when the producer is `ready` and the sink's params are behind it. */
  readonly stale: boolean;
}

/** The producer feeding this clip, when it is a node that generates one. */
function producerOf(state: DagState, clipId: string): string | null {
  const producerId = edgeTarget(state.nodes[clipId], 'source');
  if (!producerId) return null;
  return state.nodes[producerId]?.type === 'MotionGenerate' ? producerId : null;
}

/** Every clip/producer pair in the graph, in id order so the answer is stable. */
export function clipBakeStates(state: DagState): ClipBakeState[] {
  const out: ClipBakeState[] = [];
  for (const clipId of Object.keys(state.nodes).sort()) {
    if (state.nodes[clipId].type !== 'AnimationClip') continue;
    const producerId = producerOf(state, clipId);
    if (!producerId) continue;
    const value = evaluate(state, producerId).value as AnimationClipValue;
    const generation = value.generation;
    const bakedHash = (state.nodes[clipId].params as { sourceHash?: unknown }).sourceHash;
    out.push({
      clipId,
      producerId,
      status: generation?.status ?? null,
      stale: generation?.status === 'ready' && bakedHash !== generation.requestHash,
    });
  }
  return out;
}

/**
 * Ops that bring every stale clip's params up to its producer's landed result.
 *
 * Empty when nothing is stale — including when a producer is `pending` or
 * `failed`, which is the whole of lock/freeze: a clip whose producer cannot
 * currently answer keeps the motion it last had.
 */
export function bakeGeneratedClipOps(state: DagState): Op[] {
  const ops: Op[] = [];
  for (const { clipId, producerId, stale } of clipBakeStates(state)) {
    if (!stale) continue;
    const value = evaluate(state, producerId).value as AnimationClipValue;

    // The rig FIRST. A keyframe's `bone` is an index into the skeleton the keys
    // were authored against, so params written in the other order leave a window
    // — however brief, and it is a whole dispatch wide — where new indices
    // address the old rig. The ops land atomically, but they land in order, and
    // an inverse applied halfway is exactly the state this ordering avoids.
    const skeletonId = edgeTarget(state.nodes[clipId], 'skeleton');
    if (skeletonId && state.nodes[skeletonId]?.type === 'Skeleton') {
      ops.push({
        type: 'setParam',
        nodeId: skeletonId,
        paramPath: 'bones',
        value: value.skeleton.bones,
      });
    }

    ops.push(
      { type: 'setParam', nodeId: clipId, paramPath: 'name', value: value.name },
      { type: 'setParam', nodeId: clipId, paramPath: 'duration', value: value.duration },
      { type: 'setParam', nodeId: clipId, paramPath: 'loop', value: value.loop },
      { type: 'setParam', nodeId: clipId, paramPath: 'keyframes', value: value.keyframes },
      // LAST, and that is load-bearing: this is the receipt that the params above
      // were written. An inverse that stops partway leaves the hash unchanged, so
      // the clip still reads as stale and the next cook redoes it — rather than
      // reading as current while carrying half a result.
      {
        type: 'setParam',
        nodeId: clipId,
        paramPath: 'sourceHash',
        value: value.generation!.requestHash,
      },
    );
  }
  return ops;
}
