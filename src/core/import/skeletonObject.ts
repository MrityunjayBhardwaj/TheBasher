// A motion's skeleton, standing in the scene as an Object of its own (#1056).
//
// A `.bvh` or `.fbx` lands as a `Skeleton` + an `AnimationClip` — data with no scene
// presence, so on its own a motion could not be looked at: no bones drawn, nothing to select,
// nothing to scrub. These are the ops that give that skeleton an Object, the same citizen an
// armature is in Blender (its own Object, pointing at armature data). Every import adds one,
// whatever else is in the scene; a bind hides it (`mutator.animation.retarget`), so a
// character playing the clip does not have a second rig standing beside it.
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
 * (`bindMotionToCharacter.ts`) and whether a path placement's refusal can say an Object of the
 * director's still shows it (`placeGeneratedMotion.ts`). What a bind hides and a placement moves
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

export interface SkeletonObjectArgs {
  readonly skeletonId: string;
  /** The scene aggregator the Object joins as a child. */
  readonly sceneNodeId: string;
  /**
   * #1101 — the name the Object shows: its clip's, which is the file's base name on the import
   * road and the prompt on the generation road. Blender's BVH importer does the same, naming
   * the armature Object and its action after the file (`io_anim_bvh/import_bvh.py`, `load`).
   *
   * Required, so a new caller cannot stand an Object the outliner lists by its id. A blank name
   * adds no op: blank is the unnamed state `nodeDisplayName` falls back from.
   */
  readonly name: string;
  /**
   * #1122 — the clip this Object's name follows. The Object is named after its clip and keeps
   * reading as the same motion when the clip is renamed or re-cooked, until a director renames
   * the Object itself (the link is `meta.nameFrom`; the reducer copies, a rename cuts it).
   *
   * Required for the reason `name` is: a road that could leave it out would stand an Object
   * whose name silently stops following, and both roads would look the same until a rename.
   */
  readonly clipId: string;
}

/**
 * The Object, its name, its `data` edge from the skeleton, and its place among the scene's
 * children.
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
        ? [{ type: 'setMeta' as const, nodeId: objectId, name: args.name, nameFrom: args.clipId }]
        : []),
      {
        type: 'connect',
        from: { node: args.skeletonId, socket: 'out' },
        to: { node: objectId, socket: 'data' },
      },
      {
        type: 'connect',
        from: { node: objectId, socket: 'out' },
        to: { node: args.sceneNodeId, socket: 'children' },
      },
    ],
  };
}
