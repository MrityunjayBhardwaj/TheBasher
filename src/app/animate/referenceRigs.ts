// #1250 — which retargets' source rigs the viewport can draw beside their characters, and why each
// of the others is not drawn.
//
// Show Source Rig (#977) used to skip a retarget silently at two places: the scene read path, when
// the source or the target did not evaluate to a rig, and the armature helper, when no character
// stood the rig the retarget drives. Turning the overlay on could draw nothing with nothing saying
// why — the symptom #1250 was filed for. Every reason is decided here, once, from the graph; the
// viewport draws `rigs` and the View menu says how many of the retargets that is, zero included.
//
// REF: src/viewport/SceneFromDAG.tsx (the one read path that calls this);
//      src/viewport/ArmatureHelper.tsx (draws `rigs`, pairs each with the Object standing its target);
//      src/app/MenuBar.tsx (the readout); issues #1250, #977.

import type { DagState } from '../../core/dag/state';
import { evaluate, type EvaluatorCache } from '../../core/dag/evaluator';
import type { PosedSkeletonValue, SkeletonValue } from '../../nodes/types';
import { retargetPairs } from './boundClipsForAsset';

/** One source rig the viewport draws: the pose the retarget reads, and the rig it drives. */
export interface ReferenceRig {
  /** The retarget node's id — stable identity across frames. */
  readonly id: string;
  /** The SOURCE pose the retarget reads: a clip's, a base layer's, any pose wire. It carries its own
   *  skeleton and samples itself at a time. */
  readonly pose: PosedSkeletonValue;
  /** The Skeleton node this retarget drives. A native character's armature Object stands exactly
   *  this skeleton, so it is found by identity (#1273); a motion's own rig Object stands the
   *  SOURCE skeleton, never a target, so it can never be taken for the character. */
  readonly targetSkeletonId: string;
}

/** A retarget whose source rig is not drawn, and why, in words for the readout. */
export interface SkippedReferenceRig {
  readonly retargetId: string;
  readonly reason: string;
}

export interface ReferenceRigs {
  readonly rigs: readonly ReferenceRig[];
  readonly skipped: readonly SkippedReferenceRig[];
}

/**
 * Every wired retarget in the graph, split into the source rigs that can be drawn and the ones that
 * can't, with the reason. `standing` is the set of Skeleton node ids some skeleton Object stands:
 * a source rig is drawn beside its character, so a retarget no character stands has nowhere to go.
 */
export function collectReferenceRigs(
  state: DagState,
  standing: ReadonlySet<string>,
  cache?: EvaluatorCache,
): ReferenceRigs {
  const rigs: ReferenceRig[] = [];
  const skipped: SkippedReferenceRig[] = [];
  for (const pair of retargetPairs(state.nodes)) {
    const skip = (reason: string) => skipped.push({ retargetId: pair.retargetId, reason });
    try {
      // The source is whatever pose the retarget reads, evaluated on the socket its edge names: a
      // clip's pose, a base layer's, a layer above it. The wire carries its own rig.
      const pose = evaluate(state, pair.sourceId, { cache, socket: pair.sourceSocket }).value as
        | PosedSkeletonValue
        | undefined;
      const target = evaluate(state, pair.targetSkeletonId, { cache, socket: 'out' }).value as
        | SkeletonValue
        | undefined;
      if (!pose || pose.kind !== 'PosedSkeleton' || !pose.skeleton?.bones?.length) {
        skip('its source has no rig to draw');
        continue;
      }
      if (!target || !target.bones?.length) {
        skip('the rig it drives has no bones');
        continue;
      }
      if (!standing.has(pair.targetSkeletonId)) {
        skip('no character stands the rig it drives');
        continue;
      }
      rigs.push({ id: pair.retargetId, pose, targetSkeletonId: pair.targetSkeletonId });
    } catch (e) {
      // A half-wired or mid-edit graph draws no reference rig. This runs in a render path; throwing
      // here would take the whole viewport down for a diagnostic overlay.
      skip(`its graph does not evaluate: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { rigs, skipped };
}

/** The View menu's words for a collection: how many were drawn of how many, zero included. */
export function referenceRigsReadout(found: ReferenceRigs): string {
  const total = found.rigs.length + found.skipped.length;
  if (total === 0) return 'no retarget to draw';
  return `${found.rigs.length} of ${total} drawn`;
}
