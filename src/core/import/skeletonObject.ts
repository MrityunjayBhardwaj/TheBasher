// A motion's skeleton, standing in the scene as an Object of its own (#1056).
//
// A `.bvh` or `.fbx` lands as a `Skeleton` + its motion as keys on a base pose layer (#1211) —
// data with no scene presence, so on its own a motion could not be looked at: no bones drawn, nothing to select,
// nothing to scrub. These are the ops that give that skeleton an Object, the same citizen an
// armature is in Blender (its own Object, pointing at armature data). Every import adds one,
// whatever else is in the scene; a bind hides it (`mutator.animation.retarget`), so a
// character playing the motion does not have a second rig standing beside it.
//
// THE OBJECT POINTS AT THE SKELETON ITSELF. `Object.data` accepts a `Skeleton` directly; no
// wrapper node is minted, because the skeleton is already the right noun
// (docs/OBJECT-DATA-SPLIT-DESIGN.md §0, "skeleton-as-data").
//
// SCALE. Every Object this stands is at scale 1: the rig's size is its data's, in metres. A
// file that declares its unit is read in it at parse (FBX, #1086); a BVH declares none and
// stands at the file's own size, where the director sets it on this Object (#791); a generated
// clip carries the unit its producer declared (#790). Nothing here guesses a size from what the
// rig looks like — the reference never does (Blender's BVH and FBX importers, measured).
//
// REF: src/nodes/ObjectNode.ts (the data socket); src/app/asset/importBvhFbx.ts (the caller);
//      src/core/import/fbx.ts (`fbxMetresPerUnit`); issues #1056, #791, #1086.

import type { DagState } from '../dag/state';
import type { Op } from '../dag/types';
import { parentEdge } from './modelImport';

/** The Object's id, derived from the skeleton's — one skeleton, one Object, reproducibly. */
export function skeletonObjectId(skeletonId: string): string {
  return `${skeletonId}_object`;
}

/**
 * Every Object standing this skeleton in the scene, id-sorted (V22).
 *
 * Found by the `data` edge rather than by {@link skeletonObjectId}, so an Object pointed at the
 * skeleton by hand counts as much as the one an import made.
 *
 * ONE lookup for "where does this motion stand": the Object a notice falls back to naming
 * (`bindMotionToCharacter.ts`), whether a path placement's refusal can say an Object of the
 * director's still shows it (`placeGeneratedMotion.ts`), and which Object a retarget poses when the
 * bind names none (`retarget.ts`, #1213). What a bind hides and a placement moves
 * is narrower — {@link standInObjectOf} (#1088, #1141).
 */
export function standingObjectsOf(state: DagState, skeletonId: string): string[] {
  return Object.values(state.nodes)
    .filter((n) => n.type === 'Object' && dataSourceOf(n.inputs?.data) === skeletonId)
    .map((n) => n.id)
    .sort();
}

/**
 * The Object the import stood this skeleton up with, while it still shows the skeleton — or null.
 *
 * #1088 — the one Object a bind hides. {@link standingObjectsOf} answers "where does this motion
 * stand", and an Object the director pointed at the skeleton is a right answer to that; it is not
 * one a bind may hide unasked. The import's own Object is told apart by the id the import derives
 * ({@link skeletonObjectId}): a rename writes `meta.name` and never the id, while a duplicate gets
 * an id of its own. The `data` edge is checked too, because once that Object is pointed at
 * something else it no longer shows this motion.
 */
export function standInObjectOf(state: DagState, skeletonId: string): string | null {
  const id = skeletonObjectId(skeletonId);
  const node = state.nodes[id];
  return node?.type === 'Object' && dataSourceOf(node.inputs?.data) === skeletonId ? id : null;
}

/** The node an input socket reads from, or null — one binding or the first of a list. */
function dataSourceOf(binding: unknown): string | null {
  const one = (Array.isArray(binding) ? binding[0] : binding) as { node?: unknown } | undefined;
  return typeof one?.node === 'string' ? one.node : null;
}

interface SkeletonObjectBase {
  readonly skeletonId: string;
  /** The scene aggregator the Object joins as a child. */
  readonly sceneNodeId: string;
  /**
   * #1101 — the name the Object shows. For a motion's own rig, its motion's: the file's base name
   * on the import road and the prompt on the generation road. Blender's BVH importer does the same,
   * naming the armature Object and its action after the file (`io_anim_bvh/import_bvh.py`, `load`).
   * For a glTF armature, its armature node's (#1238).
   *
   * Required, so a new caller cannot stand an Object the outliner lists by its id. A blank name
   * adds no op: blank is the unnamed state `nodeDisplayName` falls back from.
   */
  readonly name: string;
  /**
   * The clip whose pose poses this Object (#1224), and — when {@link nameFollowsClip} — whose name
   * it follows (#1122): a motion's rig keeps reading as the same motion when the clip is renamed or
   * re-cooked, until a director renames the Object itself (the link is `meta.nameFrom`; the reducer
   * copies, a rename cuts it).
   *
   * Required for the reason `name` is: a road that could leave it out would stand an Object with
   * no pose edge, and both roads would look the same until something played. A road whose motion
   * is keys on a pose layer names that layer as {@link SkeletonObjectArgs} `pose` instead.
   */
  readonly clipId: string;
  /**
   * #1238 — whether the Object's name follows its clip's (`meta.nameFrom`). True for a GENERATED
   * motion's own rig, whose clip carries the prompt (#1101, #1122). A road whose motion is keys on a
   * layer follows nothing: a glTF armature is a node with a name of its own (Blender names the
   * armature Object after that node, `io_scene_gltf2/blender/imp/node.py`, `create_object`), and a
   * dropped BVH or FBX is named after the file, which Blender never renames after its action.
   *
   * Required, for the reason `name` is: a road that could leave it out would silently inherit one.
   */
  readonly nameFollowsClip: boolean;
}

/**
 * The builder's arguments: the shared ones, and EXACTLY ONE pose source for the Object — a clip
 * (`clipId`, whose `pose` output is wired) or any pose-wire output (`pose`), such as the base pose
 * layer an imported glTF's keys live in (#1211). A road naming a `pose` has no clip for the name to
 * follow, so it passes `nameFollowsClip: false`.
 */
export type SkeletonObjectArgs = Omit<SkeletonObjectBase, 'clipId' | 'nameFollowsClip'> &
  (
    | { readonly clipId: string; readonly nameFollowsClip: boolean; readonly pose?: never }
    | {
        readonly pose: { readonly node: string; readonly socket: string };
        readonly nameFollowsClip: false;
        readonly clipId?: never;
      }
  );

/**
 * The Object, its name, its `data` edge from the skeleton, its `pose` edge from its motion, and
 * its place among the scene's children.
 *
 * #1224 — the motion's POSE output feeds the Object's `pose`, the end of the pose wire (#1203 wired
 * the clip itself, as the Object's action): a clip's `pose` on the generation road, the base pose
 * layer's `out` on the glTF, BVH and FBX roads (#1211). The armature band poses the rig from this
 * edge, and a deform pointed at the Object reads the pose through it (#393). Wired here, so every
 * road that stands a rig wires it.
 *
 * The name goes on `meta.name` through a `setMeta` op, because that is the field the outliner's
 * rename writes and `nodeDisplayName` reads first, and `addNode` carries no meta. It lands in the
 * same op list, so the one undo that removes the Object removes its name with it.
 */
export function buildSkeletonObjectOps(args: SkeletonObjectArgs): {
  readonly ops: Op[];
  readonly objectId: string;
} {
  const objectId = skeletonObjectId(args.skeletonId);
  return {
    objectId,
    ops: [
      {
        type: 'addNode',
        nodeId: objectId,
        nodeType: 'Object',
        params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      ...(args.name.trim()
        ? [
            {
              type: 'setMeta' as const,
              nodeId: objectId,
              name: args.name,
              ...(args.nameFollowsClip && args.clipId !== undefined
                ? { nameFrom: args.clipId }
                : {}),
            },
          ]
        : []),
      {
        type: 'connect',
        from: { node: args.skeletonId, socket: 'out' },
        to: { node: objectId, socket: 'data' },
      },
      {
        type: 'connect',
        from: args.pose ?? { node: args.clipId, socket: 'pose' },
        to: { node: objectId, socket: 'pose' },
      },
      parentEdge(objectId, args.sceneNodeId),
    ],
  };
}
