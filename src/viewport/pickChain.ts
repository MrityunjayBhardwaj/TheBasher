// Map the deep three.js object under the cursor to the ancestor chain of DAG
// node ids `[topPickId, …, leaf]` — the data half of #233 nearest-surface
// leaf-pick (V75). The caller selects `chain[last]` on a plain click (the LEAF
// under the cursor) and walks toward `chain[0]` on Alt+click (select-up).
// (Historically this was UX#7 double-click drill-in; the chain math is
// identical, only the consumer changed.)
//
// Only a TOP-LEVEL scene child is its own click target (SceneChildNode, whose
// wrapper group carries the pick id). Everything drawn beneath it — the Objects
// under an imported Group, a box inside a user's Group — reaches the handler
// through that one wrapper, so the hit object has to be mapped back to the DAG
// node that drew it.
//
// `RenderChild`, the one seam every NESTED scene node is drawn through, stamps
// `userData.basherNodeId` on the object it draws (#1075). This is the road a native
// import takes (Group → Object), and it is not about imports: any nested node is
// addressed the same way, which is Blender's rule — a click selects the object
// under the cursor, never its parent.
//
// Until #1053 a glTF clone had its own mapping here (a per-object child-id stamp
// written by the clone renderer, and a name match against the asset's name map).
// A kept clone import draws nothing, so there is nothing under it to click.
//
// Pure + three-free at the type level (Obj3DLike) so it unit-tests without a
// real three.js scene or a GPU.

import type { DagState } from '../core/dag/state';
import type { NodeId } from '../core/dag/types';

/** The slice of a THREE.Object3D this resolver reads. Keeps the helper testable
 *  without importing three (V8-adjacent: a viewport util, not the DAG).
 *  `userData` carries the stamp above; `[key: string]` keeps it assignable
 *  from a real `THREE.Object3D.userData` (an arbitrary bag). */
export interface Obj3DLike {
  name: string;
  parent: Obj3DLike | null;
  userData?: { basherNodeId?: string; [key: string]: unknown };
}

/** The `userData` key `RenderChild` writes: the id of the nested DAG node that
 *  drew this object. One constant so the writer and this reader cannot drift. */
export const DRAWN_NODE_ID_KEY = 'basherNodeId';

/**
 * Build the pick chain `[topPickId, …, leaf]` for the object under the cursor.
 * `topPickId` is the top-level node the wrapper selects on its own (the import
 * Group, a plain box). Returns null when the hit maps to no
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

  // Leaf → root. An id stamped on a now-deleted node is skipped; dedup guards a
  // node drawn through two nested wrappers.
  const ids: NodeId[] = [];
  for (const o of ancestors) {
    const drawnId = o.userData?.[DRAWN_NODE_ID_KEY];
    if (
      typeof drawnId === 'string' &&
      drawnId !== topPickId &&
      state.nodes[drawnId] &&
      !ids.includes(drawnId)
    ) {
      ids.push(drawnId);
    }
  }

  if (ids.length === 0) return null;
  ids.reverse(); // root → leaf
  return [topPickId, ...ids];
}
