// worldChildren — who hangs from whom, read off the parent inputs (#1810, #1824).
//
// A child names its parent: its parent input (an input marked `world`) reads the parent's world
// output. Nothing on the parent names the child. This module turns that around once per node
// table, so a parent can be asked for its children: the evaluator fills an input marked
// `gathersChildren` from it, the cycle check walks it, and the scene tree (`sceneHierarchy.ts`)
// builds its edges from it. One reverse index, so those three cannot disagree about who is whose
// child or in what order.
//
// Order is node-table order, the order a saved file lists its nodes in. A file conversion that
// turns a `children` wire list into parent inputs keeps the outliner's order by keeping its
// children in that order in the table.

import { getNodeType, registryEpoch } from './registry';
import type { Node, NodeId, NodeRef, Op } from './types';

/** As much of the graph as this reads. */
export interface WorldChildrenGraph {
  readonly nodes: Readonly<
    Record<string, { readonly type: string; readonly inputs?: Readonly<Record<string, unknown>> }>
  >;
}

interface Index {
  readonly epoch: number;
  readonly parentOf: ReadonlyMap<NodeId, NodeId>;
  readonly childrenOf: ReadonlyMap<NodeId, readonly NodeId[]>;
}

const EMPTY: readonly NodeId[] = Object.freeze([]);
const memo = new WeakMap<object, Index>();

/** The parent `node`'s world input reads, or null. A list binding is not a parent. */
function parentRefOf(node: {
  readonly type: string;
  readonly inputs?: Readonly<Record<string, unknown>>;
}): NodeRef | null {
  const def = getNodeType(node.type);
  if (!def) return null;
  for (const [socket, into] of Object.entries(def.inputs)) {
    if (into.world !== true) continue;
    const binding = node.inputs?.[socket] as NodeRef | NodeRef[] | undefined;
    if (!binding || Array.isArray(binding) || typeof binding.node !== 'string') continue;
    return binding;
  }
  return null;
}

function indexOf(graph: WorldChildrenGraph): Index {
  const hit = memo.get(graph.nodes);
  // Which inputs are parent inputs is the registry's answer, so a re-registered type rebuilds.
  if (hit && hit.epoch === registryEpoch()) return hit;
  const parentOf = new Map<NodeId, NodeId>();
  const childrenOf = new Map<NodeId, NodeId[]>();
  for (const [id, node] of Object.entries(graph.nodes)) {
    const ref = parentRefOf(node);
    if (!ref || ref.socket !== 'world' || !graph.nodes[ref.node]) continue;
    parentOf.set(id, ref.node);
    (childrenOf.get(ref.node) ?? childrenOf.set(ref.node, []).get(ref.node)!).push(id);
  }
  const index = { epoch: registryEpoch(), parentOf, childrenOf };
  memo.set(graph.nodes, index);
  return index;
}

/**
 * Drop what is known of `nodes`. A batch of operations writes one copy of the record in place
 * (`putNode` in `ops.ts`), so an index taken part way through a batch (a `connect` asks for one)
 * would otherwise be read back for the finished graph, missing every parent wired after it.
 */
export function forgetWorldChildren(nodes: object): void {
  memo.delete(nodes);
}

/** The node whose world `id`'s parent input reads, or null when it hangs from nothing. */
export function worldParentOf(graph: WorldChildrenGraph, id: NodeId): NodeId | null {
  return indexOf(graph).parentOf.get(id) ?? null;
}

/** The nodes whose parent input reads `id`'s world, in node-table order. */
export function worldChildrenOf(graph: WorldChildrenGraph, id: NodeId): readonly NodeId[] {
  return indexOf(graph).childrenOf.get(id) ?? EMPTY;
}

/** The parent input of `nodeType` (its input marked `world`), or null when it has none and so can
 *  hang from a parent only by a wire into the parent's list. */
export function parentSocketOf(nodeType: string): string | null {
  const def = getNodeType(nodeType);
  if (!def) return null;
  for (const [socket, into] of Object.entries(def.inputs)) {
    if (into.world === true) return socket;
  }
  return null;
}

/** The input socket of `nodeType` marked `gathersChildren`, or null. */
export function gatheringSocketOf(nodeType: string): string | null {
  const def = getNodeType(nodeType);
  if (!def) return null;
  for (const [socket, into] of Object.entries(def.inputs)) {
    if (into.gathersChildren === true) return socket;
  }
  return null;
}

/**
 * `node`'s inputs with its gathering list extended by the nodes whose parent input reads its
 * world, after the wires and skipping any already wired. The node's own inputs when it gathers
 * nothing. The evaluator resolves these, and every reader that lines a parent's evaluated
 * `children` up with node ids (`childEdges`) reads the same list, so index i is the same child.
 */
export function withGatheredChildren(
  graph: WorldChildrenGraph,
  id: NodeId,
  node: { readonly type: string; readonly inputs: Node['inputs'] },
): Node['inputs'] {
  const socket = gatheringSocketOf(node.type);
  if (!socket) return node.inputs;
  const gathered = worldChildrenOf(graph, id);
  if (gathered.length === 0) return node.inputs;
  const prior = node.inputs[socket];
  const wired = Array.isArray(prior) ? prior : prior ? [prior] : [];
  const held = new Set(wired.map((r) => r.node));
  const extra = gathered.filter((c) => !held.has(c)).map((c) => ({ node: c, socket: 'out' }));
  return { ...node.inputs, [socket]: [...wired, ...extra] };
}

/**
 * `node`'s inputs as a walk DOWN the scene tree reads them: its gathered children included
 * (`withGatheredChildren`) and its own parent input left out, since that wire leads up to its parent,
 * not down to something it holds. For the walks that ask "what does this node hold or read" by
 * following input wires, which before #1824 found a group's children among its inputs.
 */
export function inputsBelow(
  graph: WorldChildrenGraph,
  id: NodeId,
  node: { readonly type: string; readonly inputs: Node['inputs'] },
): Node['inputs'] {
  const inputs = withGatheredChildren(graph, id, node);
  const up = parentSocketOf(node.type);
  if (!up || inputs[up] === undefined) return inputs;
  const { [up]: _up, ...rest } = inputs;
  void _up;
  return rest;
}

/** True when `holderId` takes `childId` on `socket` through the child's parent input: the socket is
 *  the holder's gathering list and the child has a parent input. */
export function attachesByParentInput(
  graph: WorldChildrenGraph,
  holderId: NodeId,
  socket: string,
  childId: NodeId,
): boolean {
  const holder = graph.nodes[holderId];
  const child = graph.nodes[childId];
  if (!holder || !child) return false;
  return gatheringSocketOf(holder.type) === socket && parentSocketOf(child.type) !== null;
}

/**
 * #1824 — the op that hangs `childId` from `holderId` on `socket`: the holder's world into the
 * child's parent input when the holder gathers on `socket` and the child has a parent input (the
 * only way such a child may hang there, `connect` refuses the wire), otherwise a wire into the
 * holder's list, at `index` when given. Both nodes must be in `graph`.
 */
export function attachOp(
  graph: WorldChildrenGraph,
  childId: NodeId,
  holderId: NodeId,
  socket: string,
  index?: number,
): Op {
  if (attachesByParentInput(graph, holderId, socket, childId)) {
    return {
      type: 'connect',
      from: { node: holderId, socket: 'world' },
      to: { node: childId, socket: parentSocketOf(graph.nodes[childId]!.type)! },
    };
  }
  return {
    type: 'connect',
    from: { node: childId, socket: 'out' },
    to: { node: holderId, socket },
    ...(index === undefined ? {} : { index }),
  };
}
