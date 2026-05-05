// Plain-object DAG state. The zustand store wraps this; the Op dispatcher
// reads/writes through pure functions so we can unit-test without React.
//
// Discipline: this module exports NO mutating functions. State changes flow
// through `applyOp` in ops.ts, never via direct field writes. (V1.)
//
// REF: THESIS.md §50.

import type { Node, NodeId, NodeRef } from './types';

export interface DagState {
  /** All nodes keyed by id. */
  nodes: Record<NodeId, Node>;
  /** Named output sockets exposed by the project (e.g. 'scene', 'render'). */
  outputs: Record<string, NodeRef>;
}

export function emptyDagState(): DagState {
  return { nodes: {}, outputs: {} };
}

export function getNode(state: DagState, id: NodeId): Node {
  const n = state.nodes[id];
  if (!n) throw new Error(`Node not found: ${id}`);
  return n;
}

export function hasNode(state: DagState, id: NodeId): boolean {
  return Object.prototype.hasOwnProperty.call(state.nodes, id);
}

/** Iterate every (consumerId, socket, producer) edge currently in the graph. */
export function* edges(
  state: DagState,
): Generator<{ consumer: NodeId; socket: string; producer: NodeRef }> {
  for (const consumer of Object.values(state.nodes)) {
    for (const [socket, binding] of Object.entries(consumer.inputs)) {
      if (Array.isArray(binding)) {
        for (const ref of binding) yield { consumer: consumer.id, socket, producer: ref };
      } else {
        yield { consumer: consumer.id, socket, producer: binding };
      }
    }
  }
}

/**
 * Cycle check: would adding edge `producer.node → consumer.node` form a cycle?
 * Returns true if a path already exists `consumer → ... → producer`.
 *
 * REF: THESIS.md §10 (cycle detection by visited-set + depth limit).
 */
export function wouldCreateCycle(
  state: DagState,
  producer: NodeId,
  consumer: NodeId,
  depthLimit = 32,
): boolean {
  if (producer === consumer) return true;
  const stack: Array<{ id: NodeId; depth: number }> = [{ id: producer, depth: 0 }];
  const visited = new Set<NodeId>();
  while (stack.length) {
    const { id, depth } = stack.pop()!;
    if (id === consumer) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    if (depth >= depthLimit) continue;
    const node = state.nodes[id];
    if (!node) continue;
    for (const binding of Object.values(node.inputs)) {
      const refs = Array.isArray(binding) ? binding : [binding];
      for (const ref of refs) {
        if (!visited.has(ref.node)) stack.push({ id: ref.node, depth: depth + 1 });
      }
    }
  }
  return false;
}
