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
 * The walk follows dependency edges upward from `producer`. By default those are
 * the wired `node.inputs` edges. #291 (Epic 1, G6): a driver/overlay dependency is
 * NOT a wired input edge — it is expressed via params (a driven target depends on
 * its source). Pass `paramDeps` (a `consumerId → [producerId, …]` adjacency of
 * those extra dependencies) so a driver cannot close a loop that the input-only
 * walk would miss. Omitting it preserves the exact pre-#291 behavior.
 *
 * REF: THESIS.md §10 (cycle detection by visited-set + depth limit).
 */
export function wouldCreateCycle(
  state: DagState,
  producer: NodeId,
  consumer: NodeId,
  depthLimit = 32,
  paramDeps?: Record<NodeId, NodeId[]>,
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
    // A node absent from `state.nodes` can still carry param dependencies below,
    // so we don't `continue` on a missing node — only skip its input edges.
    if (node) {
      for (const binding of Object.values(node.inputs)) {
        const refs = Array.isArray(binding) ? binding : [binding];
        for (const ref of refs) {
          if (!visited.has(ref.node)) stack.push({ id: ref.node, depth: depth + 1 });
        }
      }
    }
    // #291 — also traverse driver/overlay dependencies for this node.
    for (const dep of paramDeps?.[id] ?? []) {
      if (!visited.has(dep)) stack.push({ id: dep, depth: depth + 1 });
    }
  }
  return false;
}
