// #1451 — Collections (#397), read off the graph: which collections the scene holds, nested ones
// too, what each one holds, and what a hidden one hides. A Collection is membership by `members` edges and never a
// transform (`src/nodes/Collection.ts`), so every question about it is a read of those edges.
//
// HIDING. Blender hides a collection's objects with it, and hides each object on its own: a hidden
// parent's children still draw where it puts them (#1462, observed in Blender 5.1.1 headless). An
// object in several collections hides only when every one of them is hidden (#1481). And the
// viewport and the render are asked apart (#1503): the eye is the `viewport` param and the render
// has its own `render` param, on Objects, Groups and Collections alike. The viewport
// (`SceneFromDAG`) and the bone overlay (`collectSkeletonObjects`) ask `hiddenNodes(…, 'viewport')`;
// the render (`renderToImage`) honours `'render'` through the stamps `SceneFromDAG` writes.

import type { DagState } from '../core/dag/state';
import type { NodeId, Op } from '../core/dag/types';
import { collectionOps } from '../core/import/modelImport';
import { isCameraNode } from './cameraNode';
import { resolveRigLightSources } from './resolveRigLightSources';

const refsOf = (binding: unknown): NodeId[] =>
  (Array.isArray(binding) ? binding : binding ? [binding] : [])
    .map((r) => (r as { node?: unknown } | undefined)?.node)
    .filter((id): id is NodeId => typeof id === 'string');

/**
 * The collections the scene holds itself (its top level), in the scene's order. Empty with no
 * scene. Every collection in the scene, nested ones too, is `allCollectionsOf`.
 */
export function sceneCollectionsOf(state: DagState): NodeId[] {
  const sceneId = state.outputs.scene?.node;
  const scene = sceneId ? state.nodes[sceneId] : undefined;
  return refsOf(scene?.inputs?.collections).filter((id) => state.nodes[id]?.type === 'Collection');
}

/** #397 — the collections nested directly in `collectionId`, in its order. */
export function childCollectionsOf(state: DagState, collectionId: NodeId): NodeId[] {
  const node = state.nodes[collectionId];
  return node?.type === 'Collection'
    ? refsOf(node.inputs?.collections).filter((id) => state.nodes[id]?.type === 'Collection')
    : [];
}

/** One place a collection sits in the scene's tree: how deep, and which collection holds it. */
export interface CollectionPlace {
  readonly id: NodeId;
  /** 0 for one the scene holds itself. */
  readonly depth: number;
  /** The collection it is nested in; null for one the scene holds itself. */
  readonly parent: NodeId | null;
}

/**
 * #397 — the scene's collection tree, depth first in outliner order: each top collection, then
 * what nests in it. A collection nested in two places is listed at both, as Blender's outliner
 * (and its view layer) lists one per path — measured in Blender 5.1.1 headless: C in P and in Q
 * has the layer paths [P, C] and [Q, C]. The graph refuses a cycle, so the walk ends.
 */
export function collectionTreeOf(state: DagState): CollectionPlace[] {
  const out: CollectionPlace[] = [];
  const walk = (id: NodeId, depth: number, parent: NodeId | null, path: ReadonlySet<NodeId>) => {
    if (path.has(id)) return;
    out.push({ id, depth, parent });
    const below = new Set(path).add(id);
    for (const child of childCollectionsOf(state, id)) walk(child, depth + 1, id, below);
  };
  for (const id of sceneCollectionsOf(state)) walk(id, 0, null, new Set());
  return out;
}

/** #397 — every collection in the scene, nested ones too, once each, in outliner order. */
export function allCollectionsOf(state: DagState): NodeId[] {
  return [...new Set(collectionTreeOf(state).map((place) => place.id))];
}

/** The nodes a collection holds, in its order. */
export function collectionMembersOf(state: DagState, collectionId: NodeId): NodeId[] {
  const node = state.nodes[collectionId];
  return node?.type === 'Collection' ? refsOf(node.inputs?.members) : [];
}

/**
 * #1503 — what a visibility flag is for. Blender keeps the two apart: the eye is the viewport's,
 * and the render has its own toggle — measured in Blender 5.1.1 (Cycles, headless): an object
 * with its eye off still renders, and one with its render toggle off does not.
 */
export type VisibilityPurpose = 'viewport' | 'render';

/** The node types that carry the `viewport` and `render` params (#1503): what the eye can hide. */
export const VISIBILITY_TYPES: ReadonlySet<string> = new Set(['Object', 'Group', 'Collection']);

/**
 * #1503 — whether a node's own flag shows it for `purpose`. An absent flag shows it, so every
 * node saved before the flags existed, and every node nobody hid, reads as shown.
 */
export function ownShown(
  node: { params?: unknown } | undefined,
  purpose: VisibilityPurpose,
): boolean {
  return (
    (node?.params as Partial<Record<VisibilityPurpose, unknown>> | undefined)?.[purpose] !== false
  );
}

/**
 * #1503 — the op that sets a node's own flag for `purpose`, or null when it already reads that
 * way (a write that changes nothing would still leave an undo step, #1191). Showing it clears the
 * flag rather than writing `true`, so a save keeps only the flags someone turned off.
 */
export function setShownOp(
  state: DagState,
  nodeId: NodeId,
  purpose: VisibilityPurpose,
  shown: boolean,
): Op | null {
  const node = state.nodes[nodeId];
  if (!node || !VISIBILITY_TYPES.has(node.type) || ownShown(node, purpose) === shown) return null;
  return { type: 'setParam', nodeId, paramPath: purpose, value: shown ? undefined : false };
}

/**
 * #397 — which of the scene's collections are shown for `purpose`: one whose own flag is on, on
 * at least one path from the scene down to it with every collection on the path shown. Blender
 * 5.1.1 (headless): O in A and in B-under-Parent hides with A and Parent off, B itself on
 * (2026-10-04); and C nested in both P and Q keeps its objects with P off, hides them with P and
 * Q off (2026-10-05).
 */
function shownCollections(state: DagState, purpose: VisibilityPurpose): ReadonlySet<NodeId> {
  const shown = new Set<NodeId>();
  const tree = collectionTreeOf(state);
  // Depth first, so a parent's place is decided before the places under it.
  const placeShown: boolean[] = [];
  tree.forEach((place, i) => {
    let parentShown = true;
    if (place.parent !== null) {
      for (let j = i - 1; j >= 0; j--) {
        if (tree[j].depth === place.depth - 1) {
          parentShown = placeShown[j];
          break;
        }
      }
    }
    placeShown[i] = parentShown && ownShown(state.nodes[place.id], purpose);
    if (placeShown[i]) shown.add(place.id);
  });
  return shown;
}

/**
 * #1481 — every node its collections hide for `purpose`: one in at least one of the scene's
 * collections, with every collection holding it hidden. Blender 5.1.1 (headless, 2026-10-04): O in
 * A and B stays visible with A hidden and hides with A and B, for the viewport toggle and the
 * render toggle alike. A node in no collection belongs to the scene itself, which nothing here
 * hides.
 */
export function hiddenByCollection(
  state: DagState,
  purpose: VisibilityPurpose,
): ReadonlySet<NodeId> {
  const shownIn = new Set<NodeId>();
  const heldBy = new Set<NodeId>();
  const shownCols = shownCollections(state, purpose);
  for (const id of allCollectionsOf(state)) {
    const shown = shownCols.has(id);
    for (const member of collectionMembersOf(state, id)) {
      heldBy.add(member);
      if (shown) shownIn.add(member);
    }
  }
  return new Set([...heldBy].filter((member) => !shownIn.has(member)));
}

/**
 * #1462 #1503 — every node that is hidden itself for `purpose`: by its own flag, or by the
 * collections holding it. Never what hangs under one — Blender hides an object alone, and its
 * children keep drawing. The viewport asks for `'viewport'`, the render for `'render'`.
 */
export function hiddenNodes(state: DagState, purpose: VisibilityPurpose): ReadonlySet<NodeId> {
  const out = new Set<NodeId>(hiddenByCollection(state, purpose));
  for (const node of Object.values(state.nodes)) {
    if (VISIBILITY_TYPES.has(node.type) && !ownShown(node, purpose)) out.add(node.id);
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
  return typeof id === 'string' && allCollectionsOf(state).includes(id) ? id : null;
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

/** The scene's collections that hold `id`, nested ones too, in outliner order. */
export function collectionsHolding(state: DagState, id: NodeId): NodeId[] {
  return allCollectionsOf(state).filter((c) => collectionMembersOf(state, c).includes(id));
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
  const taken = new Set(allCollectionsOf(state).map((id) => state.nodes[id].meta?.name));
  if (!taken.has('Collection')) return 'Collection';
  for (let i = 1; ; i++) {
    const name = `Collection.${String(i).padStart(3, '0')}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * #1451 — New Collection, as Blender's: an empty collection named `newCollectionName`, held by
 * `parent` — one of the scene's collections (#397), or the scene itself when null or not one of
 * them. Blender's outliner nests it in the selected collection, else the scene
 * (`outliner_collections.cc` `collection_new_exec`, v5.1.1); its Move to Collection menu makes one
 * in the level it is picked from. Null with no scene. Membership comes later — an import into it
 * once it is active, or moving objects in (`moveToCollectionOps`).
 */
export function newCollectionOps(
  state: DagState,
  parent: NodeId | null = null,
): { ops: Op[]; collectionId: NodeId } | null {
  const sceneId = state.outputs.scene?.node;
  if (!sceneId) return null;
  const holder = parent !== null && allCollectionsOf(state).includes(parent) ? parent : sceneId;
  let collectionId: NodeId;
  do {
    collectionId = `n_collection_${Math.floor(Math.random() * 36 ** 6).toString(36)}`;
  } while (state.nodes[collectionId]);
  return { ops: collectionOps(collectionId, newCollectionName(state), [], holder), collectionId };
}

/**
 * #397 — the scene's objects: what a collection can hold and an eye can hide. Every node the scene
 * holds through its `children` and `lights` bands, at any depth, every camera (#1453 — a camera
 * floats outside the scene's bands, and Blender lists it in a collection like any object), and the
 * active lighting profile's lights (#1480 — `resolveRigLightSources`, the lights the rig band
 * draws). Their drawers all honour `hiddenNodes`: the scene's children, the lights band and its
 * helpers, the rig band, and the camera frustums.
 */
export function collectableNodes(state: DagState): ReadonlySet<NodeId> {
  const sceneId = state.outputs.scene?.node;
  const out = new Set<NodeId>();
  const scene = sceneId ? state.nodes[sceneId] : undefined;
  const stack = [...refsOf(scene?.inputs?.children), ...refsOf(scene?.inputs?.lights)];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id) || !state.nodes[id]) continue;
    out.add(id);
    stack.push(...refsOf(state.nodes[id].inputs?.children));
  }
  if (scene) for (const id of Object.keys(state.nodes)) if (isCameraNode(state, id)) out.add(id);
  for (const id of resolveRigLightSources(state)) if (state.nodes[id]) out.add(id);
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
  /** The ids given that are not scene objects (`collectableNodes`): data, collections, … */
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
    if (collectionId !== null && !allCollectionsOf(state).includes(collectionId)) return null;
  }
  const held = collectableNodes(state);
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

/**
 * #397 — what deleting collections hands on, as Blender's Delete (not Delete Hierarchy) does
 * (`BKE_collection_delete`, `collection.cc`, v5.1.1, `hierarchy == false`): each deleted
 * collection's members and nested collections join every collection it sat in. One the scene held
 * itself hands its nested collections to the scene, and its members to nothing — the scene
 * collection is no collection here. A parent being deleted too passes them on up to its own.
 * Nothing in `deleted` is handed on, and nothing joins where it already is.
 */
export function collectionDeleteRelinkOps(state: DagState, deleted: ReadonlySet<NodeId>): Op[] {
  const sceneId = state.outputs.scene?.node;
  if (!sceneId) return [];
  const tree = collectionTreeOf(state);
  const parentsOf = (id: NodeId) => [
    ...new Set(tree.filter((p) => p.id === id).map((p) => p.parent)),
  ];
  // The surviving places a deleted collection hands on to: null is the scene.
  const heirsOf = (id: NodeId, seen: Set<NodeId>): (NodeId | null)[] =>
    parentsOf(id).flatMap((p) => {
      if (p === null || !deleted.has(p)) return [p];
      if (seen.has(p)) return [];
      seen.add(p);
      return heirsOf(p, seen);
    });
  const ops: Op[] = [];
  const joined = new Set<string>();
  const join = (from: NodeId, to: NodeId, socket: 'members' | 'collections', already: NodeId[]) => {
    const key = `${from}>${to}.${socket}`;
    if (already.includes(from) || joined.has(key)) return;
    joined.add(key);
    ops.push({ type: 'connect', from: { node: from, socket: 'out' }, to: { node: to, socket } });
  };
  for (const id of allCollectionsOf(state)) {
    if (!deleted.has(id)) continue;
    const heirs = [...new Set(heirsOf(id, new Set([id])))];
    for (const heir of heirs) {
      const to = heir ?? sceneId;
      const held = heir === null ? sceneCollectionsOf(state) : childCollectionsOf(state, heir);
      for (const child of childCollectionsOf(state, id)) {
        if (!deleted.has(child)) join(child, to, 'collections', held);
      }
      if (heir === null) continue;
      const members = collectionMembersOf(state, heir);
      for (const member of collectionMembersOf(state, id)) {
        if (!deleted.has(member)) join(member, heir, 'members', members);
      }
    }
  }
  return ops;
}
