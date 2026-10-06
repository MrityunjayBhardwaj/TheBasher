// poseBone Mutator — the AUTHORING road into a character's hand-pose (#993, #1244).
//
//   (motion) ──→ PoseLayer (override, members) ──→ armature Object
//                   ↑ this mutator writes the bone's member, inserting the layer when there is none
//
// A registered node type with no builder can be evaluated but not authored — node creation runs
// through curated builders, with no add-node palette — so the pose lane needed an AUTHOR as well as
// a producer and a consumer. This is the author, for the director's inspector row and the agent
// alike, and `handPoseOps` below is the one builder a hand-pose has (the load-time conversion of an
// old save calls it too).
//
// The bone is named in the skeleton's own spelling and refused when the skeleton does not carry
// it: a member on a bone the rig does not have is an inert node that types, saves and drives
// nothing.
//
// (It once also minted `PoseOverride`s off a `RetargetClip` for the clone road's rigs, resolving
// the live three.js spelling of a bone into the DAG's; that anchor retired with the clone road's
// character half, #1053. Old saves holding one convert at load, #1216.)
//
// REF: src/nodes/PoseLayer.ts (the layer); src/app/animate/poseChain.ts (`handPoseLayerOf`, the
//      shared walk); src/agent/mutators/builders/addChannel.ts (the sibling authoring verb);
//      issues #993, #1244, #1214.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { NodeId, Op } from '../../../core/dag/types';
import { edgeTarget, type GraphNodeLike } from '../../../app/animate/graphNodes';
import {
  handPoseInsertionOf,
  handPoseLayerOf,
  poseLayerChain,
  whyNotHandPosable,
} from '../../../app/animate/poseChain';
import type { PoseLayerMember } from '../../../nodes/PoseLayer';
import type { Vec3 } from '../../../nodes/types';

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

const PoseBoneSpec = z.object({
  /**
   * #1244 — the armature Object being posed. The pose goes into the pose layer feeding the Object;
   * one is inserted when there is none.
   */
  object: z.string().min(1),
  /** The bone to pose, in the skeleton's own spelling. */
  bone: z.string().min(1),
  /** Authored local translation. Supplying it IS the authoring bit. */
  position: Vec3Schema.optional(),
  /** Authored local Euler rotation, DEGREES (the member's `ZYX` order, `handPoseOps`). */
  rotation: Vec3Schema.optional(),
  /** #1338 — authored local scale, a factor per axis (1 = rest). */
  scale: Vec3Schema.optional(),
});
export type PoseBoneSpec = z.infer<typeof PoseBoneSpec>;

/** #1244 — the id of the pose layer a first pose inserts under an armature Object. */
export function poseLayerIdFor(objectId: string): NodeId {
  return `${objectId}_pose_layer`;
}

const asGraph = (state: DagState) =>
  state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>;

/** The bones of the skeleton an armature Object stands, or null when its data is not one. */
function objectBonesOf(state: DagState, objectId: string): readonly { name: string }[] | null {
  const node = state.nodes[objectId];
  if (!node || node.type !== 'Object') return null;
  const skeleton = state.nodes[edgeTarget(asGraph(state)[objectId], 'data') ?? ''];
  if (skeleton?.type !== 'Skeleton') return null;
  return ((skeleton.params as { bones?: { name: string }[] }).bones ?? []) as { name: string }[];
}

/** The layer a hand-pose on `objectId` is written into (the shared walk: the inspector reads the same). */
const editLayerOf = (state: DagState, objectId: string): string | null =>
  handPoseLayerOf(asGraph(state), objectId);

/** Why the chain layer `id` cannot take a hand-pose, or null when it can. */
const whyNotEditable = (state: DagState, id: string, base: string | null): string | null =>
  whyNotHandPosable(asGraph(state), id, base);

export const poseBoneMutator: MutatorDefinition<PoseBoneSpec> = {
  name: 'mutator.animate.poseBone',
  // 🔴 THE FIRST SENTENCE IS THE PICKER PAYLOAD, so it ends before a CAPITAL.
  // `firstSentence` splits on a period followed by an upper-case letter, digit or
  // quote; a period followed by a lower-case word is not a boundary, and the
  // "summary" then runs on to the next capital — the measured way three entries
  // became 400-550 characters each and pushed the catalog over its byte ceiling.
  description:
    'Hand-pose ONE bone of a character, held against the motion underneath. ' +
    '`object` is the armature Object: the pose goes into the pose layer feeding it, ' +
    'one is inserted when there is none. Position is local translation, rotation is local ' +
    'Euler DEGREES, scale is a local factor per axis; at least one is required — a pose ' +
    "authoring none is inert. The bone is named in the skeleton's own spelling.",
  spec: PoseBoneSpec,
  specExample: {
    object: 'node_id',
    bone: 'mixamorig_LeftArm',
    rotation: [0, 0, 45],
  },
  contract: {
    // The Object's closure walks `pose` down its layer chain; its node type is checked in
    // `preconditions`, as the retarget mutator checks its skeletons.
    requiredEdges: [],
    requiredNodeTypes: [],
    // The rig's motion is untouched — a hand-pose REPLACES components of one bone's sampled pose
    // above the motion and writes nothing back.
    preserves: ['position', 'rotation', 'scale', 'material', 'children', 'animation'],
  },
  buildClosureSpec(spec): ClosureSpec {
    // #1244 — the Object, the layer chain under it (`pose`), and the fresh layer id.
    return {
      rootSelectors: [spec.object, poseLayerIdFor(spec.object)],
      followedEdges: ['pose'],
    };
  },
  preconditions(spec, _closure, state) {
    if (spec.position === undefined && spec.rotation === undefined && spec.scale === undefined) {
      return {
        ok: false,
        reason:
          'poseBone needs position, rotation or scale — a pose authoring no component is inert.',
      };
    }
    const bones = objectBonesOf(state, spec.object);
    if (bones === null) {
      return {
        ok: false,
        reason: `"${spec.object}" is not an armature Object (an Object whose data is a Skeleton).`,
      };
    }
    if (!bones.some((b) => b.name === spec.bone)) {
      return {
        ok: false,
        reason: `bone "${spec.bone}" is not on this rig. Its bones are: ${bones
          .slice(0, 12)
          .map((b) => b.name)
          .join(', ')}${bones.length > 12 ? `, … (${bones.length} total)` : ''}.`,
      };
    }
    // #1245 — a pose layer is inserted only when the chain has none to take the pose, and under
    // an id derived from the Object (a closure is declared before the graph is read, so the id
    // cannot be invented here). Held by some other node, it is refused by name, not by collision.
    const layerId = poseLayerIdFor(spec.object);
    if (editLayerOf(state, spec.object) === null && state.nodes[layerId]) {
      const { layers, base } = poseLayerChain(asGraph(state), spec.object);
      const why = layers.includes(layerId) ? whyNotEditable(state, layerId, base) : null;
      return {
        ok: false,
        reason: why
          ? `the pose layer "${layerId}" ${why}, so it cannot take a pose.`
          : `the pose layer "${layerId}" exists but is not an override layer in this Object's pose ` +
            'chain; wire it back under the Object, or set its mode to override, to pose into it.',
      };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    return handPoseOps(state, spec.object, spec.bone, {
      ...(spec.position !== undefined ? { position: spec.position } : {}),
      ...(spec.rotation !== undefined ? { rotation: spec.rotation } : {}),
      ...(spec.scale !== undefined ? { scale: spec.scale } : {}),
    });
  },
};

/**
 * #1244 — pose a bone of a native character: write it into the override layer feeding its armature
 * Object, as a member held against whatever motion arrives underneath — keyed bones included (the
 * decision on #1214: Blender drops such a pose at the next frame, we keep it).
 *
 * The rotation keeps this verb's one meaning, local euler DEGREES in the codebase's order, which is
 * Blender's `ZYX` (`bonePose.ts`, `EULER_ORDERS`); the member is stored in that mode. Members are a
 * list found by bone name, so the whole list is written: a bone name never becomes a param path.
 * With no layer feeding the Object, one is inserted between the Object and whatever posed it.
 *
 * The one builder of a hand-pose: this mutator, and a saved clone-road pose converting at load
 * (#1216), both call it. #1338 — the mutator writes `scale` too, as the conversion always could.
 */
export function handPoseOps(
  state: DagState,
  objectId: string,
  bone: string,
  pose: { readonly position?: Vec3; readonly rotation?: Vec3; readonly scale?: Vec3 },
): Op[] {
  const existingLayer = editLayerOf(state, objectId);
  const members: PoseLayerMember[] = existingLayer
    ? [...((state.nodes[existingLayer].params as { members?: PoseLayerMember[] }).members ?? [])]
    : [];
  const at = members.findIndex((m) => m.bone === bone);
  const before = at >= 0 ? members[at] : undefined;
  const member: PoseLayerMember = {
    ...(before ?? { bone }),
    bone,
    rotationMode: pose.rotation !== undefined ? 'ZYX' : (before?.rotationMode ?? 'ZYX'),
    ...(pose.position !== undefined ? { position: [...pose.position] } : {}),
    ...(pose.rotation !== undefined ? { rotation: [...pose.rotation] } : {}),
    ...(pose.scale !== undefined ? { scale: [...pose.scale] } : {}),
  };
  if (at >= 0) members[at] = member;
  else members.push(member);

  if (existingLayer) {
    return [{ type: 'setParam', nodeId: existingLayer, paramPath: 'members', value: members }];
  }

  const layerId = poseLayerIdFor(objectId);
  // #1343 — under the lowest ik layer when there is one (the FK its solve reads), else the Object.
  const under = handPoseInsertionOf(asGraph(state), objectId);
  const feed = state.nodes[under].inputs?.pose as { node: string; socket: string } | undefined;
  return [
    {
      type: 'addNode',
      nodeId: layerId,
      nodeType: 'PoseLayer',
      params: { name: 'pose', mode: 'override', members },
    },
    ...(feed
      ? [
          {
            type: 'connect' as const,
            from: { node: feed.node, socket: feed.socket },
            to: { node: layerId, socket: 'pose' },
          },
        ]
      : []),
    {
      type: 'connect',
      from: { node: layerId, socket: 'out' },
      to: { node: under, socket: 'pose' },
      replace: true,
    },
  ];
}
