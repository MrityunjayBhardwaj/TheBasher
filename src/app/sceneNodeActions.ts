// Shared scene-node action op-builders (#227). ONE authority for the ops that
// delete (and later duplicate) scene nodes, so the keyboard shortcut, the outliner
// context menu, and any future surface all dispatch the SAME ops — the "one write
// authority, N callers" shape (cf. V65 select handler, V69 rename op). Pure: a
// function of (state, ids) → Op[]; the caller dispatches + manages selection.

import type { DagState } from '../core/dag/state';
import type { NodeId, Op } from '../core/dag/types';

/**
 * Ops to delete `ids` in one atomic batch (→ one undo). `removeNode` refuses to
 * remove a node whose output is still consumed, so every consumer edge into a
 * deleted node is disconnected FIRST (consumers also being deleted are skipped —
 * their own removeNode handles them). Mirrors the long-standing Delete-key path,
 * now shared so the context menu can't drift from it.
 */
export function buildDeleteNodesOps(state: DagState, ids: readonly NodeId[]): Op[] {
  const idSet = new Set(ids);
  const ops: Op[] = [];
  for (const nodeId of ids) {
    for (const [consumerId, consumer] of Object.entries(state.nodes)) {
      if (idSet.has(consumerId)) continue; // being deleted too — its removeNode covers it
      for (const [socketName, binding] of Object.entries(consumer.inputs)) {
        const refs = Array.isArray(binding) ? binding : binding ? [binding] : [];
        for (const ref of refs) {
          if (ref && ref.node === nodeId) {
            ops.push({
              type: 'disconnect',
              from: { node: nodeId, socket: ref.socket },
              to: { node: consumerId, socket: socketName },
            });
          }
        }
      }
    }
    ops.push({ type: 'removeNode', nodeId });
  }
  return ops;
}
