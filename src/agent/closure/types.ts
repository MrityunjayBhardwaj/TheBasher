// Closure types — the set of nodes a Mutator (or an inferred turn-level
// edit) is allowed to touch.
//
// A ClosureSpec is the declarative side: roots + which edge kinds to
// follow + a depth cap. expandClosure resolves it against a DagState
// into a concrete ClosureSet (set of nodeIds + the traversed edges).
//
// EdgeKind is direction-typed:
//   - 'parent'   — walk consumer-side: any node that lists root in its inputs.
//   - 'children' — walk producer-side: any node referenced by root's inputs
//                  (under any socket).
//   - socket-named kinds ('time', 'animation', 'pass-input', 'camera',
//     'lights') — walk only via the named input socket. Reserved for
//     P3+ usage; safe to declare today, falls through if no node has the
//     matching socket.
//
// REF: P2.5.2 PLAN §5 Wave A; vyapti V13 (closure preservation, NOT YET
// IMPLEMENTED until Wave A lands).

import type { NodeId } from '../../core/dag/types';

export type EdgeKind =
  | 'parent'
  | 'children'
  // socket-named edge kinds (P3+ — declared now for forward compat):
  | 'camera'
  | 'lights'
  | 'time'
  | 'animation'
  | 'pass-input';

export interface ClosureSpec {
  /** Root node ids the closure expands from. */
  rootSelectors: NodeId[];
  /** Edge kinds to follow during BFS expansion. */
  followedEdges: EdgeKind[];
  /** Cap on traversal depth. Defaults to 256 (P-1 mitigation). */
  maxDepth?: number;
}

export interface ClosureEdge {
  from: NodeId;
  to: NodeId;
  kind: EdgeKind;
}

export interface ClosureSet {
  /** All node ids inside the closure (includes the roots). */
  nodes: ReadonlySet<NodeId>;
  /** Edges traversed during expansion, in BFS order. */
  edges: ReadonlyArray<ClosureEdge>;
  /** The spec that produced this set — preserved for debugging + display. */
  spec: ClosureSpec;
}
