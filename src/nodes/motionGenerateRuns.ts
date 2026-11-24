// motionGenerateRuns — what a generated run says about itself on a strip (#1721).
//
// A generated run is the clip a `MotionGenerate` cooks into. The NLA pane draws one strip per run
// and paints it amber when the run no longer matches what its generator would now ask for, so a
// director who drags a waypoint sees exactly which run that edit left behind. This module is the
// decision; the strip is the wiring.
//
// ─────────────────────────────────────────────────────────────────────────────
// STALE IS ALREADY A FACT OF THE GRAPH — THIS ONLY NAMES IT PER RUN
// ─────────────────────────────────────────────────────────────────────────────
// The clip records the request hash it was baked from (`sourceHash`), and the generator computes
// its current one (`motionRequestHash`: prompt, seed, model, seconds, the sampled path and its
// placement, pathScale). `clipBakeStates` compares the two. So a moved waypoint, a new prompt or a
// new seed is stale with no new state anywhere, and because both halves are params the answer is
// the same after a reload: nothing about staleness is saved, so the saved format does not move.
//
// The one input the hash does not see directly is the CHARACTER. A walk along a path is asked for
// at the character's scale (#1285), so a swapped or newly bound character leaves the request
// unchanged until the cook writes the new `pathScale` — and the run walks the wrong length the
// whole time. `motionPathScaleFit` already measures that; a run that needs a fit is stale too, with
// its own reason, because pressing Re-cook is what fixes it (the cook fits before it asks).
//
// Stale never touches the clip. The old run keeps playing until it is re-cooked (the bake only
// ever writes a `ready` result), so nothing jumps while the path is edited.
//
// REF: src/app/asset/bakeGeneratedClip.ts (`clipBakeStates`, the hash comparison);
//      src/app/asset/fitMotionPathScale.ts (the character half);
//      src/app/asset/cookMotionGenerations.ts (`motionCookOffer`, the inspector's reading of the
//      same rows); issues #1721, #1470, #1285.

import type { EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import { clipBakeStates } from '../app/asset/bakeGeneratedClip';
import { motionPathScaleFit, pathScaleNeedsFit } from '../app/asset/fitMotionPathScale';

/** Why a run is stale: its generator's request moved, or its character needs a refit. */
export type GeneratedRunStaleReason = 'inputs' | 'character';

/** One generated run, as its strip shows it. */
export interface GeneratedRun {
  readonly clipId: string;
  readonly producerId: string;
  /** The clip's own name — the clip owns it (#1124). */
  readonly name: string;
  /** The run's length in seconds, as baked. The strip spans [0, duration]: a clip plays from 0. */
  readonly duration: number;
  /** True once a run has landed — there is a take to keep playing. */
  readonly baked: boolean;
  /**
   * True when a landed run no longer matches what its generator would ask for now. False for a
   * run that has never landed: there is nothing to be out of date yet, and its strip says so with
   * `status` instead.
   */
  readonly stale: boolean;
  /** Set exactly when `stale` is. */
  readonly staleBecause: GeneratedRunStaleReason | null;
  /** `ready` | `pending` | `failed`, as `clipBakeStates` reports it. */
  readonly status: string | null;
}

/** Whether the graph holds a generator at all — the cheap gate before any evaluation. */
function hasGenerator(state: DagState): boolean {
  for (const id in state.nodes) if (state.nodes[id].type === 'MotionGenerate') return true;
  return false;
}

/**
 * Every generated run in the graph, in clip-id order.
 *
 * Evaluates each generator (its path resolves through the curve), so a render path must pass a
 * shared `cache`; with no generator in the graph it returns at once and evaluates nothing.
 */
export function generatedRuns(state: DagState, cache?: EvaluatorCache): GeneratedRun[] {
  if (!hasGenerator(state)) return [];
  return clipBakeStates(state, cache).map((row) => {
    const params = state.nodes[row.clipId].params as { name?: unknown; duration?: unknown };
    let staleBecause: GeneratedRunStaleReason | null = null;
    if (row.baked) {
      if (row.stale) staleBecause = 'inputs';
      else if (pathScaleNeedsFit(motionPathScaleFit(state, row.producerId, cache))) {
        staleBecause = 'character';
      }
    }
    return {
      clipId: row.clipId,
      producerId: row.producerId,
      name: typeof params.name === 'string' ? params.name : row.clipId,
      duration: typeof params.duration === 'number' ? params.duration : 0,
      baked: row.baked,
      stale: staleBecause !== null,
      staleBecause,
      status: row.status,
    };
  });
}

/** The words a stale strip carries, so the strip and its tests read one table. */
export function staleRunLabel(reason: GeneratedRunStaleReason): string {
  return reason === 'inputs' ? 'stale · inputs changed' : 'stale · fit to character';
}
