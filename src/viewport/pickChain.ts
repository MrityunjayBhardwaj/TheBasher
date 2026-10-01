// Map the deep three.js object under the cursor to the ancestor chain of DAG
// node ids `[topPickId, …, leaf]` — the data half of #233 nearest-surface
// leaf-pick (V75). The caller selects `chain[last]` on a plain click (the LEAF
// under the cursor) and walks toward `chain[0]` on Alt+click (select-up).
// (Historically this was UX#7 double-click drill-in; the chain math is
// identical, only the consumer changed.)
//
// Only a TOP-LEVEL scene child is its own click target (SceneChildNode, whose
// wrapper group carries the pick id). Everything drawn beneath it — the Objects
// under an imported Group, a box inside a user's Group, a glTF clone's sub-meshes
// — reaches the handler through that one wrapper, so the hit object has to be
// mapped back to the DAG node that drew it. Two producers write that mapping:
//
// 1. DRAWN NODES (#1075) — `RenderChild`, the one seam every NESTED scene node is
//    drawn through, stamps `userData.basherNodeId` on the object it draws. This is
//    the road a native import takes (Group → Object), and it is not about imports:
//    any nested node is addressed the same way, which is Blender's rule — a click
//    selects the object under the cursor, never its parent.
//
// 2. THE glTF CLONE (H90) — NOTHING STAMPS THIS ANY MORE. Until #1053 the clone
//    renderer drew a whole SkeletonUtils copy under one `GltfAsset`, so its
//    sub-meshes were not DAG-drawn nodes, and it stamped
//    `userData.basherGltfChildId` via the glTF node-INDEX correspondence
//    (gltf.parser.associations × the persisted keyByGltfNodeIndex), immune to the
//    producer-key ↔ clone-name divergence that leaves ~28% of a real export's
//    meshes unaddressable by NAME. A material-split `<unnamed>` leaf has no stamp;
//    its nearest stamped ancestor IS the target, which the ancestor walk finds.
//    FALLBACK when no clone object is stamped (pre-UX#7 saved projects that
//    hydrated `keyByGltfNodeIndex` empty, or the flat unit fixtures): match
//    ancestor NAMES against `GltfAsset.params.nodeNameMap` — the original UX#7
//    behaviour.
//
// The `GltfAsset` node itself is drawn nested (under the import's Group), so it
// carries a drawn-node stamp too — and is skipped: selecting the asset
// specifically is an outliner action, not a level of the select-up walk. That
// keeps the clone road's chain exactly what it was before drawn nodes were
// stamped (#1053 retires the clone).
//
// Pure + three-free at the type level (Obj3DLike) so it unit-tests without a
// real three.js scene or a GPU.

import type { DagState } from '../core/dag/state';
import type { NodeId } from '../core/dag/types';

/** The slice of a THREE.Object3D this resolver reads. Keeps the helper testable
 *  without importing three (V8-adjacent: a viewport util, not the DAG).
 *  `userData` carries the two stamps above; `[key: string]` keeps it assignable
 *  from a real `THREE.Object3D.userData` (an arbitrary bag). */
export interface Obj3DLike {
  name: string;
  parent: Obj3DLike | null;
  userData?: { basherNodeId?: string; basherGltfChildId?: string; [key: string]: unknown };
}

/** The `userData` key `RenderChild` writes: the id of the nested DAG node that
 *  drew this object. One constant so the writer and this reader cannot drift. */
export const DRAWN_NODE_ID_KEY = 'basherNodeId';

/**
 * Build the pick chain `[topPickId, …, leaf]` for the object under the cursor.
 * `topPickId` is the top-level node the wrapper selects on its own (the import
 * Group, a bare GltfAsset, a plain box). Returns null when the hit maps to no
 * node below the top-level one — the caller then selects `topPickId` itself.
 */
export function buildPickChain(
  state: DagState,
  topPickId: NodeId,
  hitObject: Obj3DLike | null,
): NodeId[] | null {
  // ancestor objects of the hit, leaf → root
  const ancestors: Obj3DLike[] = [];
  for (let o: Obj3DLike | null = hitObject; o; o = o.parent) ancestors.push(o);
  if (ancestors.length === 0) return null;

  // One walk, both stamps, in tree order (leaf → root). An id stamped on a
  // now-deleted node is skipped; dedup guards an object carrying both stamps for
  // one node and a node drawn through two nested wrappers.
  const ids: NodeId[] = [];
  let cloneStamped = false;
  for (const o of ancestors) {
    const cloneId = o.userData?.basherGltfChildId;
    if (cloneId && state.nodes[cloneId] && !ids.includes(cloneId)) {
      ids.push(cloneId);
      cloneStamped = true;
    }
    const drawnId = o.userData?.[DRAWN_NODE_ID_KEY];
    if (
      typeof drawnId === 'string' &&
      drawnId !== topPickId &&
      state.nodes[drawnId] &&
      state.nodes[drawnId].type !== 'GltfAsset' &&
      !ids.includes(drawnId)
    ) {
      ids.push(drawnId);
    }
  }

  // FALLBACK — no clone object stamped: name-match against nodeNameMap. The clone
  // sits inside the GltfAsset, below every drawn node on the path, so its ids go
  // on the leaf side.
  if (!cloneStamped) ids.unshift(...cloneIdsByName(state, ancestors));

  if (ids.length === 0) return null;
  ids.reverse(); // root → leaf
  return [topPickId, ...ids];
}

/** The pre-UX#7 clone mapping: ancestor names looked up in the `nodeNameMap` of
 *  the GltfAsset that best covers them. Leaf → root. */
function cloneIdsByName(state: DagState, ancestors: readonly Obj3DLike[]): NodeId[] {
  const names = ancestors.map((o) => o.name).filter((n) => n.length > 0);
  if (names.length === 0) return [];

  // Find the GltfAsset whose nodeNameMap best covers these names. Scoping by the
  // hit names handles the common single-import case; with several imports of the
  // same model (shared child names) the best-overlap pick is a heuristic — only
  // reached on un-stamped projects; the stamped path has no such ambiguity.
  let bestMap: Record<string, string> | null = null;
  let bestScore = 0;
  for (const node of Object.values(state.nodes)) {
    if (node.type !== 'GltfAsset') continue;
    const map = (node.params as { nodeNameMap?: Record<string, string> }).nodeNameMap;
    if (!map) continue;
    let score = 0;
    for (const n of names) if (map[n]) score++;
    if (score > bestScore) {
      bestScore = score;
      bestMap = map;
    }
  }
  if (!bestMap || bestScore === 0) return [];

  const childIds: NodeId[] = []; // leaf → root
  for (const n of names) {
    const id = bestMap[n];
    if (id && state.nodes[id]) childIds.push(id); // skip stale/unmapped
  }
  return childIds;
}
