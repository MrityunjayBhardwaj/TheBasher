// solverBind — the pure op-builders for authoring a Solver meta-op (Epic 2).
//
// A Solver owns a sub-network (cooked every frame by the replay seam) via TWO authored
// links, mirrored here as testable Op[] builders:
//   • `body`  — a WIRED edge: the sub-network's output node's `out` → Solver.body. The
//               seam cooks the closure of whatever is wired here. Set = rewire (disconnect
//               the old body edge, connect the new one); clear = disconnect.
//   • the LIVE input — the Solver's `sourceTransform` (a controller transform channel),
//               injected into the sub-network's SolverInput leaves each frame. Same shape
//               + builder story as Lag's input (buildSetLagSourceOps is node-agnostic and
//               reused; the range is set by the shared buildSetDriverRemapOps).
//
// Binding a TARGET to the Solver needs NO builder here: the Solver exposes a Number `out`,
// so it already appears in driverSourceOptions and binds through the ordinary
// ParamDriverBind (the target's ⛓ affordance) → statefulSourceOf detects it → replaySolver.
//
// REF: src/nodes/Solver.ts; src/app/statefulOps.ts (replaySolver reads `body` + the
//      source); src/app/lagBind.ts / driverBind.ts (the reused source + range builders).

import type { DagState } from '../core/dag/state';
import type { NodeRef, Op } from '../core/dag/types';

const BODY = 'body';

/** The single ref wired to a node's `socket`, or null. */
function singleRef(
  node: { inputs?: Record<string, unknown> } | undefined,
  socket: string,
): NodeRef | null {
  const b = node?.inputs?.[socket];
  if (!b) return null;
  return (Array.isArray(b) ? (b[0] ?? null) : b) as NodeRef | null;
}

/**
 * Set (or clear, when `ref` is null) the sub-network output wired into a Solver's
 * `body`. Rewires: disconnect any existing body edge first, then connect the new source.
 * `dispatchAtomic` computes the inverse for undo. No-op if the Solver is missing, or the
 * new ref already equals the current body edge (keeps undo history tidy).
 */
export function buildSetSolverBodyOps(
  state: DagState,
  solverId: string,
  ref: NodeRef | null,
): Op[] {
  const node = state.nodes[solverId];
  if (!node) return [];
  const existing = singleRef(node, BODY);
  if (ref && existing && existing.node === ref.node && existing.socket === ref.socket) return [];
  if (!ref && !existing) return [];
  const ops: Op[] = [];
  if (existing) {
    ops.push({ type: 'disconnect', from: existing, to: { node: solverId, socket: BODY } });
  }
  if (ref) {
    ops.push({ type: 'connect', from: ref, to: { node: solverId, socket: BODY } });
  }
  return ops;
}
