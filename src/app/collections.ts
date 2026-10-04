// #1451 — Collections (#397), read off the graph: which collections the scene holds, what each one
// holds, and what a hidden one hides. A Collection is membership by `members` edges and never a
// transform (`src/nodes/Collection.ts`), so every question about it is a read of those edges.
//
// HIDING. Blender hides a collection's objects with it, and hides each object on its own: a hidden
// parent's children still draw where it puts them (#1462, observed in Blender 5.1.1 headless). The
// viewport (`SceneFromDAG`) and the bone overlay (`collectSkeletonObjects`) both ask `hiddenNodes`,
// so a member of a hidden collection goes the way its own eye would send it, and alone.

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
 * #1462 — every node that is hidden itself: by its own eye (`meta.hidden`) or by a hidden collection
 * holding it. Never what hangs under one — Blender hides an object alone, and its children keep
 * drawing.
 */
export function hiddenNodes(state: DagState): ReadonlySet<NodeId> {
  const out = new Set<NodeId>(hiddenByCollection(state));
  for (const node of Object.values(state.nodes)) if (node.meta?.hidden) out.add(node.id);
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
  const made = ops.flatMap((op) =>
    op.type === 'addNode' && (op.nodeType === 'Object' || op.nodeType === 'Group')
      ? [op.nodeId]
      : [],
  );
  return linkIntoActiveCollection(state, ops, made);
}

/**
 * #1453 — `ops` with each of `ids` linked into the active collection, as Blender links every object
 * it adds (`bpy.ops.mesh.primitive_cube_add` lands in the active collection, the scene collection
 * when that is active). With the scene itself active, the ops are returned as they are.
 */
export function linkIntoActiveCollection(
  state: DagState,
  ops: readonly Op[],
  ids: readonly NodeId[],
): Op[] {
  const collectionId = activeCollectionOf(state);
  return collectionId === null ? [...ops] : [...ops, ...membershipOps(collectionId, ids)];
}

/** The scene's collections that hold `id`, in the scene's order. */
export function collectionsHolding(state: DagState, id: NodeId): NodeId[] {
  return sceneCollectionsOf(state).filter((c) => collectionMembersOf(state, c).includes(id));
}

/** The edges that make each of `ids` a member of `collectionId`. */
export function membershipOps(collectionId: NodeId, ids: readonly NodeId[]): Op[] {
  return ids.map(
    (id): Op => ({
      type: 'connect',
      from: { node: id, socket: 'out' },
      to: { node: collectionId, socket: 'members' },
    }),
  );
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
 * active, or moving objects in (`moveToCollectionOps`).
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

/**
 * #397 — every node the scene holds through `children` edges, at any depth: what stands in the
 * scene and can therefore join a collection. Lights (the scene's own band) and cameras (floating)
 * are not here — they honour no collection's hide yet, so linking one would list it hidden while it
 * still lit or framed the shot.
 */
export function sceneHeldNodes(state: DagState): ReadonlySet<NodeId> {
  const sceneId = state.outputs.scene?.node;
  const out = new Set<NodeId>();
  const stack = sceneId ? refsOf(state.nodes[sceneId]?.inputs?.children) : [];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id) || !state.nodes[id]) continue;
    out.add(id);
    stack.push(...refsOf(state.nodes[id].inputs?.children));
  }
  return out;
}

/** Where Move to Collection sends the selection: a collection, the scene itself (null), or new. */
export type MoveTarget = { collectionId: NodeId | null } | { newCollection: true };

export interface MoveToCollection {
  ops: Op[];
  /** The collection the selection now sits in; null for the scene itself. */
  collectionId: NodeId | null;
  /** The ids moved, in the order given. */
  moved: NodeId[];
  /** The ids given that the scene does not stand in it (lights, cameras, non-scene nodes). */
  skipped: NodeId[];
}

/**
 * #397 — Blender's Move to Collection (M), observed in Blender 5.1.1 headless: each selected object
 * leaves every collection of the scene and joins the target alone; to the Scene Collection, it
 * leaves them all. Only the selected objects move — a child stays in its own collections, as
 * membership is never parenting. A new collection is made first and named as New Collection names
 * one. Null when the target is not one of the scene's collections, or there is no scene.
 */
export function moveToCollectionOps(
  state: DagState,
  ids: readonly NodeId[],
  target: MoveTarget,
): MoveToCollection | null {
  if (!state.outputs.scene?.node) return null;
  const ops: Op[] = [];
  let collectionId: NodeId | null;
  if ('newCollection' in target) {
    const made = newCollectionOps(state);
    if (!made) return null;
    ops.push(...made.ops);
    collectionId = made.collectionId;
  } else {
    collectionId = target.collectionId;
    if (collectionId !== null && !sceneCollectionsOf(state).includes(collectionId)) return null;
  }
  const held = sceneHeldNodes(state);
  const moved: NodeId[] = [];
  const skipped: NodeId[] = [];
  for (const id of new Set(ids)) {
    if (!held.has(id)) {
      skipped.push(id);
      continue;
    }
    moved.push(id);
    const holding = collectionsHolding(state, id);
    for (const c of holding) {
      if (c === collectionId) continue;
      ops.push({
        type: 'disconnect',
        from: { node: id, socket: 'out' },
        to: { node: c, socket: 'members' },
      });
    }
    if (collectionId !== null && !holding.includes(collectionId)) {
      ops.push(...membershipOps(collectionId, [id]));
    }
  }
  return { ops, collectionId, moved, skipped };
}
