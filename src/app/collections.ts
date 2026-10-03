// #1451 — Collections (#397), read off the graph: which collections the scene holds, what each one
// holds, and what a hidden one hides. A Collection is membership by `members` edges and never a
// transform (`src/nodes/Collection.ts`), so every question about it is a read of those edges.
//
// HIDING. Blender hides a collection's objects with it. The viewport skips a hidden TOP-LEVEL node
// with everything under it (`SceneFromDAG`), and the bone overlay skips a rig with a hidden node
// above it (`collectSkeletonObjects`, #1450); both ask `hiddenByCollection` as well, so a member of a
// hidden collection goes the same way its own eye would send it.

import type { DagState } from '../core/dag/state';
import type { NodeId } from '../core/dag/types';

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
