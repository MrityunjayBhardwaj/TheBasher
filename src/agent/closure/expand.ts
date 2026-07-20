// Closure expansion — bounded BFS over a DagState from a ClosureSpec.
//
// Determinism: traversal is BFS in spec.rootSelectors order, then per-root
// in `followedEdges` order. The same (spec, dagState) pair always yields
// the same ClosureSet (same node order, same edge order).
//
// Cycle safety (P-1 mitigation): visited set guards against re-entry; a
// hard maxDepth cap (default 256) bounds traversal even if a future
// evaluator allows reference cycles. The current Op layer rejects cycles
// in connect, but the gate lives one layer up — defense in depth.
//
// EdgeKind semantics:
//   - 'parent'   — for each node N in the frontier, find every consumer C
//                  whose inputs reference N. Walk to C.
//   - 'children' — for each node N in the frontier, walk to every producer
//                  referenced by any of N's input sockets.
//   - socket-named — same as 'children' but only via the matching socket
//                  name. P3+ extends with 'animation', 'pass-input', etc.
//                  Today these fall through silently when no node carries
//                  the socket — safe forward declaration.
//
// REF: P2.5.2 PLAN §5 Wave A; vyapti V13.

import type { DagState } from '../../core/dag/state';
import type { NodeId } from '../../core/dag/types';
import type { ClosureEdge, ClosureSet, ClosureSpec, EdgeKind } from './types';
import { buildIdRefIndex, idRefsOutOf } from '../../core/dag/idRefSweep';

const DEFAULT_MAX_DEPTH = 256;

export class ClosurePreservationError extends Error {
  readonly target: NodeId;
  readonly closure: ClosureSet;

  constructor(target: NodeId, closure: ClosureSet) {
    const rootList = closure.spec.rootSelectors.join(', ');
    super(
      `Op targets node "${target}" outside the declared closure ` +
        `(roots: [${rootList}], ${closure.nodes.size} nodes reachable).`,
    );
    this.name = 'ClosurePreservationError';
    this.target = target;
    this.closure = closure;
  }
}

/**
 * Expand a ClosureSpec into a concrete ClosureSet against `state`.
 * Pure: same inputs → same output. No side effects, no DAG mutation.
 *
 * Each declared edge kind runs its OWN BFS from rootSelectors. Within a
 * single per-kind BFS, traversal continues only along that kind. This
 * yields "ancestors + descendants of root" semantics — `['parent']`
 * gives the consumer chain from each root; `['children']` gives the
 * producer subgraph; combining them is a UNION, not a free-mixing walk.
 *
 * If we let one kind transition to another mid-walk (e.g. parent →
 * children), siblings under a shared parent leak into the closure and
 * Wave A's "rotate selected can never touch a sibling" guarantee
 * collapses (V13 acceptance #2).
 */
export function expandClosure(spec: ClosureSpec, state: DagState): ClosureSet {
  const maxDepth = spec.maxDepth ?? DEFAULT_MAX_DEPTH;
  const visited = new Set<NodeId>();
  const edges: ClosureEdge[] = [];

  // Pre-build an inverse index: which consumers reference each producer?
  // This makes 'parent' walks O(1) per step instead of O(nodes).
  const consumersOf = buildConsumerIndex(state);
  // #421 — the inverse index of the id-reference universe, built once for the same
  // reason as `consumersOf`: an "who names me?" step must not be O(nodes).
  const idRefsInto = buildIdRefIndex(state.nodes);

  // Seed visited with every reachable root before any BFS — so a root
  // shows up in the closure even when no edge kind is declared.
  for (const root of spec.rootSelectors) {
    if (state.nodes[root]) visited.add(root);
  }

  // Run one BFS per declared edge kind. Each BFS reuses the shared
  // `visited` set for membership but uses a kind-local frontier so a
  // 'children' descendant is never followed via 'parent'.
  for (const kind of spec.followedEdges) {
    walkKind(spec.rootSelectors, kind, maxDepth, state, consumersOf, idRefsInto, visited, edges);
  }

  return {
    nodes: visited,
    edges,
    spec,
  };
}

function walkKind(
  roots: ReadonlyArray<NodeId>,
  kind: EdgeKind,
  maxDepth: number,
  state: DagState,
  consumersOf: Map<NodeId, Array<{ consumer: NodeId; socket: string }>>,
  idRefsInto: Map<NodeId, NodeId[]>,
  visited: Set<NodeId>,
  edges: ClosureEdge[],
): void {
  type FrontierEntry = { id: NodeId; depth: number };
  // Per-kind visited prevents re-walking inside this BFS while still
  // allowing other kinds' BFS to enter the same node.
  const seenInKind = new Set<NodeId>();
  // Per-kind edge set keyed by (from, to, kind) suppresses duplicate
  // pushes when a consumer binds the same producer through multiple
  // sockets (or symmetrically, when consumersOf records the same
  // consumer ↔ producer pair under multiple sockets). Distinct edges
  // like {A→B} and {C→B} remain — only true (from, to, kind) repeats
  // are dropped. Closes #20.
  const seenEdges = new Set<string>();
  const frontier: FrontierEntry[] = [];
  for (const root of roots) {
    if (state.nodes[root] && !seenInKind.has(root)) {
      seenInKind.add(root);
      frontier.push({ id: root, depth: 0 });
    }
  }

  let head = 0;
  while (head < frontier.length) {
    const { id, depth } = frontier[head++];
    if (depth >= maxDepth) continue;
    visitEdge(
      state,
      consumersOf,
      idRefsInto,
      id,
      kind,
      depth,
      seenInKind,
      seenEdges,
      visited,
      frontier,
      edges,
    );
  }
}

function visitEdge(
  state: DagState,
  consumersOf: Map<NodeId, Array<{ consumer: NodeId; socket: string }>>,
  idRefsInto: Map<NodeId, NodeId[]>,
  from: NodeId,
  kind: EdgeKind,
  depth: number,
  seenInKind: Set<NodeId>,
  seenEdges: Set<string>,
  visited: Set<NodeId>,
  frontier: Array<{ id: NodeId; depth: number }>,
  edges: ClosureEdge[],
): void {
  if (kind === 'parent') {
    const consumers = consumersOf.get(from);
    if (!consumers) return;
    for (const { consumer } of consumers) {
      enqueue(consumer, from, kind, depth, seenInKind, seenEdges, visited, frontier, edges);
    }
    return;
  }

  if (kind === 'id-ref') {
    // Both directions: whoever names `from`, and whoever `from` names. A delete
    // sweep needs the first (the channels/constraints owned by a doomed node) and
    // the second (the strips a doomed Track owns).
    for (const referrer of idRefsInto.get(from) ?? []) {
      enqueue(referrer, from, kind, depth, seenInKind, seenEdges, visited, frontier, edges);
    }
    const self = state.nodes[from];
    if (self) {
      for (const named of idRefsOutOf(self)) {
        enqueue(named, from, kind, depth, seenInKind, seenEdges, visited, frontier, edges);
      }
    }
    return;
  }

  // 'children' or a socket-named kind — walk producers referenced by
  // `from`'s inputs.
  const node = state.nodes[from];
  if (!node) return;

  for (const [socket, binding] of Object.entries(node.inputs)) {
    if (kind !== 'children' && socket !== kind) continue;
    const refs = Array.isArray(binding) ? binding : [binding];
    for (const ref of refs) {
      enqueue(ref.node, from, kind, depth, seenInKind, seenEdges, visited, frontier, edges);
    }
  }
}

function enqueue(
  next: NodeId,
  from: NodeId,
  kind: EdgeKind,
  depth: number,
  seenInKind: Set<NodeId>,
  seenEdges: Set<string>,
  visited: Set<NodeId>,
  frontier: Array<{ id: NodeId; depth: number }>,
  edges: ClosureEdge[],
): void {
  const edgeKey = `${from}${next}${kind}`;
  if (seenEdges.has(edgeKey)) return;
  seenEdges.add(edgeKey);
  edges.push({ from, to: next, kind });
  visited.add(next);
  if (seenInKind.has(next)) return;
  seenInKind.add(next);
  frontier.push({ id: next, depth: depth + 1 });
}

function buildConsumerIndex(
  state: DagState,
): Map<NodeId, Array<{ consumer: NodeId; socket: string }>> {
  const index = new Map<NodeId, Array<{ consumer: NodeId; socket: string }>>();
  for (const consumer of Object.values(state.nodes)) {
    for (const [socket, binding] of Object.entries(consumer.inputs)) {
      const refs = Array.isArray(binding) ? binding : [binding];
      for (const ref of refs) {
        let bucket = index.get(ref.node);
        if (!bucket) {
          bucket = [];
          index.set(ref.node, bucket);
        }
        bucket.push({ consumer: consumer.id, socket });
      }
    }
  }
  return index;
}

/**
 * Identify the node id an op targets for closure-preservation purposes.
 * Returns null when the op introduces fresh state (addNode of a new id)
 * — the gate allows those unconditionally, since closure preservation is
 * about not mutating outside the scope, not about banning growth.
 */
export function opTargetNodeId(op: import('../../core/dag/types').Op): NodeId | null {
  switch (op.type) {
    case 'addNode':
      // Caller decides whether this is a fresh addition (allowed) or a
      // re-add (gate-checked). isFreshAddNode() handles that.
      return op.nodeId;
    case 'removeNode':
      return op.nodeId;
    case 'setParam':
      return op.nodeId;
    case 'setMeta':
      // #224 — rename mutates an existing node's identity (meta.name), so it
      // is closure-checked exactly like setParam.
      return op.nodeId;
    case 'setHidden':
      // #227 S4 — visibility toggle mutates an existing node's meta, same as
      // setMeta/setParam → closure-checked on the target node.
      return op.nodeId;
    case 'setSpareParam':
    case 'removeSpareParam':
      // #291 — spare-param mutation targets an existing node's `spare` collection,
      // closure-checked exactly like setParam/setMeta.
      return op.nodeId;
    case 'connect':
    case 'disconnect':
      return op.to.node;
  }
}

/**
 * True when this op introduces a node id that didn't already exist in
 * `priorState`. Used by the closure-preservation gate to allow additive
 * ops that grow the graph rather than mutate existing nodes.
 */
export function isFreshAddNode(
  op: import('../../core/dag/types').Op,
  priorState: DagState,
): boolean {
  if (op.type !== 'addNode') return false;
  return !Object.prototype.hasOwnProperty.call(priorState.nodes, op.nodeId);
}

/** Re-export for ergonomic imports. */
export { DEFAULT_MAX_DEPTH };
