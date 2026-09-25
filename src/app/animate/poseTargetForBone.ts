// Where a hand-pose would go for the bone a director has selected (#1156).
//
// The mutator that authors a pose takes a `RetargetClip` and the rig's own spelling of a
// bone. A director has neither: they clicked a bone in the viewport, which yields the node
// that produced the rig and the LIVE three.js spelling of the bone. This resolves the one
// into the other, so the inspector's control asks for exactly what the mutator accepts.
//
// WHY IT IS ITS OWN LOOKUP RATHER THAN A SCAN IN THE PANEL: the panel and the mutator must
// agree about which retarget a bone belongs to and whether that bone already carries an
// override. Two spellings of that walk are two answers to one question, which is what cost
// #1088 and #1141 — a bind's hide and a path placement each grew their own answer and drifted.
// So the chain walk is the shared one (`poseChain.ts`) and the rig membership is the shared
// band walk (`boundClipsForAsset`), not a fresh traversal.
//
// NAME SPELLING IS THE SUBTLE PART. The live tree says `mixamorigLeftArm` and the DAG says
// `mixamorig_LeftArm`; both are sanitisations of one glTF name, and comparing them raw finds
// nothing. `resolveBoneNames` is the one place that reconciles them, and it is what the
// mutator uses too — so a bone the panel offers is a bone the mutator will accept.
//
// REF: src/agent/mutators/builders/poseBone.ts (the author); src/app/animate/poseChain.ts
//      (the shared walk); issues #1156, #993.

import type { DagState } from '../../core/dag/state';
import { boundClipsForAsset } from './boundClipsForAsset';
import { edgeTarget, type GraphNodeLike } from './graphNodes';
import { bonesOfSkeletonNode } from './retargetFromNodes';
import { overrideChain } from './poseChain';
import { resolveBoneNames } from '../../core/import/retarget';
import { selectedAssetRefs } from '../asset/bindMotionToCharacter';

export interface PoseTarget {
  /** The `RetargetClip` a pose for this bone hangs off — the mutator's `retarget`. */
  readonly retargetId: string;
  /** The RIG's spelling of the selected bone — the mutator's `bone`. */
  readonly bone: string;
  /** The override already authored for that bone, or null when none is. */
  readonly overrideId: string | null;
}

/**
 * The pose target for a selected bone, or null when there is none to offer.
 *
 * Null is an ordinary answer, not a failure: a rig with no retarget driving it has no pose
 * chain to hang an override off, and a bone the rig does not carry cannot be posed. The
 * control asks this and shows nothing when the answer is null, which is the same rule the
 * band applies — a bone it cannot name is scoped to no asset and never draws.
 */
export function poseTargetForBone(
  state: DagState,
  nodeId: string,
  liveBoneName: string,
): PoseTarget | null {
  const nodes = state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>;

  // The retarget driving this rig, found through the SAME walk the render band uses to
  // decide which clips reach an asset — so the panel cannot offer a pose on a rig the band
  // would not have accepted a clip for.
  let retargetId: string | null = null;
  for (const ref of selectedAssetRefs(state, nodeId)) {
    for (const bound of boundClipsForAsset(nodes, ref)) {
      if (nodes[bound.clipId]?.type === 'RetargetClip') {
        retargetId = bound.clipId;
        break;
      }
    }
    if (retargetId !== null) break;
  }
  if (retargetId === null) return null;

  const bones = bonesOfSkeletonNode(nodes, edgeTarget(nodes[retargetId], 'skeleton'));
  if (!bones) return null;

  const resolved = resolveBoneNames([liveBoneName], bones as never)[liveBoneName];
  // `resolveBoneNames` maps an unresolved name to ITSELF, so "did it resolve" is "is the
  // answer a name the rig actually carries" — checked against the rig, exactly as the
  // mutator checks it, so the panel never offers a bone the mutator would refuse.
  if (resolved === undefined || !bones.some((b) => b.name === resolved)) return null;

  const existing = overrideChain(nodes, retargetId).find((o) => o.bone === resolved);
  return { retargetId, bone: resolved, overrideId: existing?.id ?? null };
}
