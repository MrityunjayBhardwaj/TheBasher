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
import { handPoseLayerOf, overrideChain } from './poseChain';
import {
  memberEulerDegreesAt,
  poseLayerChannelOf,
  type PoseLayerParams,
} from '../../nodes/PoseLayer';
import type { Vec3 } from '../../nodes/types';
import { resolveBoneNames } from '../../core/import/retarget';
import { selectedAssetRefs } from '../asset/bindMotionToCharacter';

/**
 * Where a hand-pose for the selected bone goes: onto a native character's armature Object (#1244),
 * or onto the clone road's retarget chain. Both answer here, so the pose row asks one lookup; the
 * clone half is deleted with the clone road (#1053).
 */
export type BonePoseTarget = PoseTarget | ObjectPoseTarget;

/** #1244 — a native character: the pose goes into the layer feeding its armature Object. */
export interface ObjectPoseTarget {
  readonly kind: 'object';
  /** The armature Object — the mutator's `object`. */
  readonly objectId: string;
  /** The bone, in the skeleton's own spelling. */
  readonly bone: string;
  /**
   * The bone's rotation in the layer a hand-pose writes, AS PLAYED at the time asked (degrees, the
   * member's order): its keyed curve's value there, else its static value; null when it has none.
   */
  readonly rotation: Vec3 | null;
  /** #1215 — the layer a hand-pose writes (`handPoseLayerOf`), or null when one will be inserted. */
  readonly layerId: string | null;
  /** #1215 — the rotation is keyed in that layer (a curve in the member's mode), so an edit is a key. */
  readonly keyed: boolean;
}

export interface PoseTarget {
  readonly kind: 'retarget';
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
  seconds = 0,
): BonePoseTarget | null {
  const nodes = state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>;

  // #1244 — a bone of an armature Object (the node a click on its bones selects): pose it there,
  // whatever drives it. Any armature can be posed, as in Blender, not only a character.
  const selected = state.nodes[nodeId];
  const data =
    selected?.type === 'Object' ? state.nodes[edgeTarget(nodes[nodeId], 'data') ?? ''] : null;
  if (data?.type === 'Skeleton') {
    const bones = ((data.params as { bones?: { name: string }[] }).bones ?? []) as {
      name: string;
    }[];
    const resolved = bones.some((b) => b.name === liveBoneName)
      ? liveBoneName
      : resolveBoneNames([liveBoneName], bones as never)[liveBoneName];
    if (resolved === undefined || !bones.some((b) => b.name === resolved)) return null;
    // The layer the pose mutator writes, by the same walk — not the chain's top, which can be a muted
    // or additive layer the pose never lands in.
    const layerId = handPoseLayerOf(nodes, nodeId);
    const params = layerId ? (state.nodes[layerId].params as PoseLayerParams) : null;
    const member = params?.members.find((m) => m.bone === resolved);
    const channels = params?.channels ?? [];
    const keyed =
      member !== undefined &&
      member.rotationMode !== 'quaternion' &&
      poseLayerChannelOf(channels, resolved, 'rotation') !== undefined;
    return {
      kind: 'object',
      objectId: nodeId,
      bone: resolved,
      rotation: member ? memberEulerDegreesAt(member, channels, seconds) : null,
      layerId,
      keyed,
    };
  }

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
  return { kind: 'retarget', retargetId, bone: resolved, overrideId: existing?.id ?? null };
}
