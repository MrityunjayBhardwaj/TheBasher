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

/** A fresh node id derived from `base`, guaranteed absent from `taken` (and added
 *  to it so successive calls don't collide). Deterministic → the duplicate builder
 *  is unit-testable without Date.now()/Math.random(). */
function freshId(base: string, taken: Set<string>): string {
  let id = `${base}_copy`;
  let n = 1;
  while (taken.has(id)) {
    n += 1;
    id = `${base}_copy${n}`;
  }
  taken.add(id);
  return id;
}

/** The hierarchy sockets the duplicate walk FOLLOWS to gather the subtree: a Group
 *  aggregates `children`; Transform/MaterialOverride wrap a single `target`. Any
 *  OTHER input (a shared material, a geometry source) is NOT followed — it stays
 *  shared by the clone (re-pointed to the same original node). */
const HIERARCHY_SOCKETS = ['children', 'target'];

function refsOf(binding: unknown): { node: string; socket: string }[] {
  if (Array.isArray(binding)) return binding as { node: string; socket: string }[];
  return binding ? [binding as { node: string; socket: string }] : [];
}

/**
 * Ops to DUPLICATE the scene subtree rooted at `rootId` (Blender Shift-D): deep-copy
 * the node + its hierarchy descendants (children / wrapper target) with fresh ids,
 * re-wire the internal edges among the clones, keep every NON-hierarchy input shared
 * with the original, and connect the new root as a sibling right AFTER the original.
 * Returns the ops (one atomic → one undo) + the new root id to select, or null when
 * the node isn't a wired scene child (nothing to duplicate-as-sibling).
 *
 * Undo-safe order: addNode all clones (empty inputs) → connect internal edges →
 * connect root to parent. The reverse (disconnect edges, then removeNode) never hits
 * the "removeNode refuses while consumed" rule. `meta` is intentionally NOT copied —
 * addNode carries none, and a duplicate showing its own id avoids two nodes claiming
 * the same explicit name (Blender's `.001` suffix is a documented non-goal).
 */
export function buildDuplicateNodeOps(
  state: DagState,
  rootId: NodeId,
): { ops: Op[]; newRootId: NodeId } | null {
  if (!state.nodes[rootId]) return null;

  // 1. The parent edge to clone the new root beside (first consumer of rootId).
  let parent: { node: string; socket: string; fromSocket: string; index: number } | null = null;
  for (const [consumerId, consumer] of Object.entries(state.nodes)) {
    for (const [socket, binding] of Object.entries(consumer.inputs)) {
      const refs = refsOf(binding);
      for (let i = 0; i < refs.length; i++) {
        if (refs[i]?.node === rootId && !parent) {
          parent = { node: consumerId, socket, fromSocket: refs[i].socket, index: i };
        }
      }
    }
  }
  if (!parent) return null;

  // 2. Subtree = root + hierarchy descendants (DFS over children/target).
  const subtree: NodeId[] = [];
  const seen = new Set<NodeId>();
  const visit = (id: NodeId) => {
    if (seen.has(id)) return;
    const node = state.nodes[id];
    if (!node) return;
    seen.add(id);
    subtree.push(id);
    for (const socket of HIERARCHY_SOCKETS) {
      for (const ref of refsOf(node.inputs[socket])) if (ref?.node) visit(ref.node);
    }
  };
  visit(rootId);

  // 3. Fresh ids for every clone.
  const taken = new Set(Object.keys(state.nodes));
  const idMap = new Map<NodeId, NodeId>();
  for (const id of subtree) idMap.set(id, freshId(id, taken));

  const ops: Op[] = [];
  // 4. addNode clones (empty inputs — edges are separate connect ops, undo-safe).
  for (const id of subtree) {
    const node = state.nodes[id];
    ops.push({
      type: 'addNode',
      nodeId: idMap.get(id)!,
      nodeType: node.type,
      params: structuredClone(node.params),
    });
  }
  // 5. Re-wire EVERY input edge of each clone: a ref into the subtree points to the
  //    matching clone; any other ref stays shared with the original.
  for (const id of subtree) {
    const node = state.nodes[id];
    for (const [socket, binding] of Object.entries(node.inputs)) {
      const refs = refsOf(binding);
      const isList = Array.isArray(binding);
      for (let i = 0; i < refs.length; i++) {
        const ref = refs[i];
        if (!ref?.node) continue;
        ops.push({
          type: 'connect',
          from: { node: idMap.get(ref.node) ?? ref.node, socket: ref.socket },
          to: { node: idMap.get(id)!, socket },
          ...(isList ? { index: i } : {}),
        });
      }
    }
  }
  // 6. Wire the clone root as a sibling immediately after the original.
  ops.push({
    type: 'connect',
    from: { node: idMap.get(rootId)!, socket: parent.fromSocket },
    to: { node: parent.node, socket: parent.socket },
    index: parent.index + 1,
  });

  return { ops, newRootId: idMap.get(rootId)! };
}
