// #1451 — Collections (#397), read off the graph: which collections the scene holds, what each one
// holds, and what a hidden one hides. A Collection is membership by `members` edges and never a
// transform (`src/nodes/Collection.ts`), so every question about it is a read of those edges.
//
// HIDING. Blender hides a collection's objects with it. The viewport skips a hidden TOP-LEVEL node
// with everything under it (`SceneFromDAG`), and the bone overlay skips a rig with a hidden node
// above it (`collectSkeletonObjects`, #1450); both ask `hiddenByCollection` as well, so a member of a
// hidden collection goes the same way its own eye would send it.

import type { DagState } from '../core/dag/state';
import type { NodeId, Op } from '../core/dag/types';
import { collectionOps } from '../core/import/modelImport';

const refsOf = (binding: unknown): NodeId[] =>
  (Array.isArray(binding) ? binding : binding ? [binding] : [])
    .map((r) => (r as { node?: unknown } | undefined)?.node)
    .filter((id): id is NodeId => typeof id === 'string');

/** The collections the scene holds, in the scene's order. Empty with no scene. */
export function sceneCollectionsOf(state: DagState): NodeId[] {
  const sceneId = state.outputs.scene?.node;
  const scene = sceneId ? state.nodes[sceneId] : undefined;
  return refsOf(scene?.inputs?.collections).filter((id) => state.nodes[id]?.type === 'Collection');
}

/** The nodes a collection holds, in its order. */
export function collectionMembersOf(state: DagState, collectionId: NodeId): NodeId[] {
  const node = state.nodes[collectionId];
  return node?.type === 'Collection' ? refsOf(node.inputs?.members) : [];
}

/** Every node a hidden collection of the scene holds. */
export function hiddenByCollection(state: DagState): ReadonlySet<NodeId> {
  const out = new Set<NodeId>();
  for (const id of sceneCollectionsOf(state)) {
    if (!state.nodes[id].meta?.hidden) continue;
    for (const member of collectionMembersOf(state, id)) out.add(member);
  }
  return out;
}

/**
 * The scene's active collection — where an import links what it makes — or null when that is the
 * scene itself: none chosen, or one chosen that the scene no longer holds (deleted or unlinked),
 * which Blender likewise never leaves active.
 */
export function activeCollectionOf(state: DagState): NodeId | null {
  const sceneId = state.outputs.scene?.node;
  const chosen = (sceneId ? state.nodes[sceneId]?.params : undefined) as
    | { activeCollection?: unknown }
    | undefined;
  const id = chosen?.activeCollection;
  return typeof id === 'string' && sceneCollectionsOf(state).includes(id) ? id : null;
}

/** The op that makes `collectionId` the scene's active collection, or the scene itself (null). */
export function setActiveCollectionOp(state: DagState, collectionId: NodeId | null): Op | null {
  const sceneId = state.outputs.scene?.node;
  if (!sceneId) return null;
  return {
    type: 'setParam',
    nodeId: sceneId,
    paramPath: 'activeCollection',
    value: collectionId ?? undefined,
  };
}

/**
 * #1451 — an import's ops with every Object it makes linked into the active collection, as Blender's
 * importers link each object they make (`import_fbx.py`, `import_bvh.py`, the glTF importer's
 * single-scene case). An imported Empty is a Group here (`emptyOps`), and Blender links it too.
 * Membership only: where each one hangs in the scene is the import's own. With the scene itself
 * active, the ops are returned as they are.
 */
export function intoActiveCollection(state: DagState, ops: readonly Op[]): Op[] {
  const collectionId = activeCollectionOf(state);
  if (collectionId === null) return [...ops];
  const made = ops.flatMap((op) =>
    op.type === 'addNode' && (op.nodeType === 'Object' || op.nodeType === 'Group')
      ? [op.nodeId]
      : [],
  );
  return [
    ...ops,
    ...made.map(
      (id): Op => ({
        type: 'connect',
        from: { node: id, socket: 'out' },
        to: { node: collectionId, socket: 'members' },
      }),
    ),
  ];
}

/**
 * The name Blender gives a new collection: "Collection", then "Collection.001", "Collection.002", …
 * — the first not already taken by one of the scene's collections.
 */
export function newCollectionName(state: DagState): string {
  const taken = new Set(sceneCollectionsOf(state).map((id) => state.nodes[id].meta?.name));
  if (!taken.has('Collection')) return 'Collection';
  for (let i = 1; ; i++) {
    const name = `Collection.${String(i).padStart(3, '0')}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * #1451 — the outliner's New Collection, as Blender's: an empty collection the scene holds, named
 * `newCollectionName`. Null with no scene. Membership comes later — an import into it once it is
 * active, or (later in #397) moving objects in.
 */
export function newCollectionOps(state: DagState): { ops: Op[]; collectionId: NodeId } | null {
  const sceneId = state.outputs.scene?.node;
  if (!sceneId) return null;
  let collectionId: NodeId;
  do {
    collectionId = `n_collection_${Math.floor(Math.random() * 36 ** 6).toString(36)}`;
  } while (state.nodes[collectionId]);
  return { ops: collectionOps(collectionId, newCollectionName(state), [], sceneId), collectionId };
}
