// Map the deep three.js object under the cursor to a drill chain of DAG node
// ids — the data half of UX-backlog #7 (double-click drill-in).
//
// A glTF import renders its whole SkeletonUtils clone under ONE selectable
// top-level wrapper (SceneChildNode), so a viewport click on any sub-mesh
// selects only that top node — which is the import's Group (`n_grp_…`), with the
// GltfAsset nested inside it. But every cloned object keeps its glTF `.name`, and
// `GltfAsset.params.nodeNameMap` maps that sanitised name → the GltfChild DAG
// node id (built at import by buildGltfImportOps). So the hit object IS
// addressable: collect the hit object's ancestor names, find the GltfAsset whose
// nodeNameMap covers them, and recover the nested GltfChild hierarchy.
//
// The chain is `[topPickId, child_root, …, child_leaf]` — chain[0] is whatever
// the top-level wrapper selects (the Group, or the GltfAsset itself when
// unwrapped), so Esc pops back to "the whole model". The GltfAsset is not an
// explicit drill level (selecting it specifically is an outliner action).
//
// Pure + three-free at the type level (Obj3DLike) so it unit-tests without a
// real three.js scene or a GPU.

import type { DagState } from '../core/dag/state';
import type { NodeId } from '../core/dag/types';

/** The slice of a THREE.Object3D this resolver reads. Keeps the helper testable
 *  without importing three (V8-adjacent: a viewport util, not the DAG). */
export interface Obj3DLike {
  name: string;
  parent: Obj3DLike | null;
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
  // ancestor names of the hit, leaf → root
  const names: string[] = [];
  for (let o: Obj3DLike | null = hitObject; o; o = o.parent) {
    if (o.name) names.push(o.name);
  }
  if (names.length === 0) return null;

  // Find the GltfAsset whose nodeNameMap best covers these names. Scoping by the
  // hit names handles the common single-import case; with several imports of the
  // same model (shared child names) the best-overlap pick is a heuristic — a
  // known limitation, refine via clone→asset identity if it ever bites.
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
