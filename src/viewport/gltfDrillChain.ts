// Map the deep three.js object under the cursor to the ancestor chain of DAG
// node ids `[topPickId, child_root, …, child_leaf]` — the data half of #233
// nearest-surface leaf-pick (V75). The caller selects `chain[last]` on a plain
// click (the LEAF under the cursor) and walks toward `chain[0]` on Alt+click
// (select-up). (Historically this was UX#7 double-click drill-in; the chain
// math is identical, only the consumer changed.)
//
// A glTF import renders its whole SkeletonUtils clone under ONE selectable
// top-level wrapper (SceneChildNode), so the wrapper's own id is just the
// import's Group (`n_grp_…`), with the GltfAsset nested inside it. To address the
// actual sub-mesh under the cursor we must map the hit object back to its
// GltfChild DAG node.
//
// PRIMARY path (H90): each clone object that corresponds to a GltfChild carries
// `userData.basherGltfChildId`, stamped by `GltfAssetR` via the glTF node-INDEX
// correspondence (gltf.parser.associations × the persisted keyByGltfNodeIndex).
// We walk the hit object's ancestors and collect those stamped ids. This is
// immune to the producer-key ↔ clone-name divergence that, on a real export,
// leaves ~28% of meshes unaddressable by NAME (dedup-suffix mismatch +
// material-split `<unnamed>` sub-meshes). A material-split `<unnamed>` leaf has
// no stamp; its nearest stamped ancestor IS the correct drill target, which the
// ancestor walk picks up naturally. The stamps are globally unique GltfChild ids,
// so no per-asset scoping heuristic is needed.
//
// FALLBACK path: when no ancestor is stamped (pre-UX#7 saved projects that
// hydrated `keyByGltfNodeIndex` empty, or the flat unit fixtures), fall back to
// matching ancestor NAMES against `GltfAsset.params.nodeNameMap` — the original
// UX#7 behaviour. Zero regression for already-saved projects; re-import upgrades
// them to the robust id path.
//
// The chain is `[topPickId, child_root, …, child_leaf]` — chain[0] is whatever
// the top-level wrapper selects (the Group, or the GltfAsset itself when
// unwrapped), the top of the Alt+click select-up walk. The GltfAsset is not an
// explicit level (selecting it specifically is an outliner action).
//
// Pure + three-free at the type level (Obj3DLike) so it unit-tests without a
// real three.js scene or a GPU.

import type { DagState } from '../core/dag/state';
import type { NodeId } from '../core/dag/types';

/** The slice of a THREE.Object3D this resolver reads. Keeps the helper testable
 *  without importing three (V8-adjacent: a viewport util, not the DAG).
 *  `userData` carries the GltfAssetR stamps (H90); `[key: string]` keeps it
 *  assignable from a real `THREE.Object3D.userData` (an arbitrary bag). */
export interface Obj3DLike {
  name: string;
  parent: Obj3DLike | null;
  userData?: { basherGltfChildId?: string; [key: string]: unknown };
}

/**
 * Build the drill chain `[topPickId, child_root, …, child_leaf]` for the object
 * under the cursor. `topPickId` is the top-level node the wrapper already
 * selects on a single click (the import Group, or a bare GltfAsset). Returns
 * null when the hit object maps to no GltfChild of any asset — the caller then
 * falls back to a normal whole-node select.
 */
export function buildGltfDrillChain(
  state: DagState,
  topPickId: NodeId,
  hitObject: Obj3DLike | null,
): NodeId[] | null {
  // ancestor objects of the hit, leaf → root
  const ancestors: Obj3DLike[] = [];
  for (let o: Obj3DLike | null = hitObject; o; o = o.parent) ancestors.push(o);
  if (ancestors.length === 0) return null;

  // PRIMARY (H90) — stamped GltfChild ids, immune to glTF name divergence.
  const stamped: NodeId[] = []; // leaf → root
  for (const o of ancestors) {
    const id = o.userData?.basherGltfChildId;
    // an id stamped on a now-deleted node is skipped; dedup guards a child that
    // shares a stamp with its parent (none today — defensive).
    if (id && state.nodes[id] && !stamped.includes(id)) stamped.push(id);
  }
  if (stamped.length > 0) {
    stamped.reverse(); // root → leaf
    return [topPickId, ...stamped];
  }

  // FALLBACK — name-match against nodeNameMap (pre-UX#7 saves, flat fixtures).
  const names = ancestors.map((o) => o.name).filter((n) => n.length > 0);
  if (names.length === 0) return null;

  // Find the GltfAsset whose nodeNameMap best covers these names. Scoping by the
  // hit names handles the common single-import case; with several imports of the
  // same model (shared child names) the best-overlap pick is a heuristic — only
  // reached on un-stamped projects; the stamped path above has no such ambiguity.
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
  if (!bestMap || bestScore === 0) return null;

  const childIds: NodeId[] = []; // leaf → root
  for (const n of names) {
    const id = bestMap[n];
    if (id && state.nodes[id]) childIds.push(id); // skip stale/unmapped
  }
  if (childIds.length === 0) return null;

  childIds.reverse(); // root → leaf
  return [topPickId, ...childIds];
}
