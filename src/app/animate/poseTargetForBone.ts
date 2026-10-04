// Where a hand-pose would go for the bone a director has selected (#1156, #1244).
//
// A director clicked a bone of an armature Object, which yields the Object and the bone's name. This
// resolves that into what the pose mutator accepts — the Object, the skeleton's own spelling of the
// bone — and what the inspector shows: the bone's rotation as played, in the layer a hand-pose
// writes. The mutator and the panel walk the same chain (`poseChain.ts`), so the panel never offers
// a pose the mutator would put somewhere else.
//
// (It once also answered for the clone road's rigs, whose hand-poses hung off a retarget chain as
// `PoseOverride`s; that half retired with the clone road's character half, #1053.)
//
// REF: src/agent/mutators/builders/poseBone.ts (the author); src/app/animate/poseChain.ts
//      (the shared walk); issues #1156, #1244.

import type { DagState } from '../../core/dag/state';
import { edgeTarget, type GraphNodeLike } from './graphNodes';
import { handPoseLayerOf } from './poseChain';
import {
  memberEulerDegreesAt,
  memberVec3At,
  poseLayerChannelOf,
  type PoseLayerParams,
} from '../../nodes/PoseLayer';
import type { BoneSpec, Vec3 } from '../../nodes/types';
import { eulerFromQuat, quatFromEulerXYZ, type EulerOrder } from '../../nodes/bonePose';
import { resolveBoneNames } from '../../core/import/retarget';

/** #1244 — the pose goes into the layer feeding the armature Object. */
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
  /** #1338 — the bone's local position in that layer as played, or null when the member has none. */
  readonly position: Vec3 | null;
  /** #1338 — the bone's local scale in that layer as played, or null when the member has none. */
  readonly scale: Vec3 | null;
  /**
   * #1338 — the bone at rest, in the member's units: what a component it does not author shows and
   * seeds an axis edit with. A member REPLACES the bone's local transform (`restBonePose` is the
   * transform it replaces), so rest is the bone's own bind position, rotation and scale, not zero.
   */
  readonly rest: Readonly<Record<PoseComponent, Vec3>>;
  /** #1215 — the layer a hand-pose writes (`handPoseLayerOf`), or null when one will be inserted. */
  readonly layerId: string | null;
  /**
   * #1215, #1338 — which components are keyed in that layer, so an edit of them is a key. A rotation
   * counts only with a curve in the member's mode, as Blender ignores other modes' curves.
   */
  readonly keyed: Readonly<Record<PoseComponent, boolean>>;
}

const DEG = Math.PI / 180;

/** #1338 — the parts of a bone a hand-pose writes. */
export type PoseComponent = 'position' | 'rotation' | 'scale';
export const POSE_COMPONENTS: readonly PoseComponent[] = ['position', 'rotation', 'scale'];

/**
 * The pose target for a selected bone, or null when there is none to offer.
 *
 * Null is an ordinary answer, not a failure: the selected node is not an armature Object, or its
 * skeleton does not carry the bone. The control asks this and shows nothing when the answer is null.
 */
export function poseTargetForBone(
  state: DagState,
  nodeId: string,
  liveBoneName: string,
  seconds = 0,
): ObjectPoseTarget | null {
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
    const spec = (data.params as { bones: BoneSpec[] }).bones.find((b) => b.name === resolved)!;
    const order: EulerOrder =
      member && member.rotationMode !== 'quaternion' ? member.rotationMode : 'ZYX';
    const restRotation = eulerFromQuat(quatFromEulerXYZ(spec.rotation), order);
    const has = (component: PoseComponent) =>
      member !== undefined && poseLayerChannelOf(channels, resolved, component) !== undefined;
    return {
      kind: 'object',
      objectId: nodeId,
      bone: resolved,
      rotation: member ? memberEulerDegreesAt(member, channels, seconds) : null,
      position: member ? memberVec3At(member, channels, 'position', seconds) : null,
      scale: member ? memberVec3At(member, channels, 'scale', seconds) : null,
      rest: {
        position: [...spec.position] as Vec3,
        // `+ 0` turns the conversion's -0 into 0, so a field shows 0, not -0.
        rotation: restRotation.map((r) => r / DEG + 0) as unknown as Vec3,
        scale: (spec.scale ? [...spec.scale] : [1, 1, 1]) as Vec3,
      },
      layerId,
      keyed: {
        position: has('position'),
        rotation: has('rotation') && member?.rotationMode !== 'quaternion',
        scale: has('scale'),
      },
    };
  }
  return null;
}
