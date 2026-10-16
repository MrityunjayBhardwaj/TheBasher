// solverBind — the pure op-builders for authoring a Solver meta-op (Epic 2).
//
// A Solver owns a sub-network (cooked every frame by the replay seam) via TWO authored
// links, mirrored here as testable Op[] builders:
//   • `body`  — a WIRED edge: the sub-network's output node's `out` → Solver.body. The
//               seam cooks the closure of whatever is wired here. Set = rewire (disconnect
//               the old body edge, connect the new one); clear = disconnect.
//   • the LIVE input — the Solver's `sourceTransform` (a controller transform channel),
//               bound to the sub-network's `input` each frame. Same shape
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
import { wouldCreateCycle } from '../core/dag/state';
import type { NodeRef, Op } from '../core/dag/types';
import { missingParamPath } from './animatableParams';
import { driverParamDeps, nextDriverOrder } from './paramDrivers';
import { placeBuiltin } from './builtinTemplates';
import type { SpringNodeKey } from './springBody';

export { springBodyOps, type SpringNodeKey } from './springBody';

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

// ── The Spring preset — a one-click tuple-state Solver sub-network (S, #300) ───
//
// There is no canvas wire-drawing UI, so a Spring is authored as a PRESET: this pure
// builder dispatches the whole sub-network — the 2nd-order recurrence composed from
// Vec3Math nodes — plus the Solver and a vec ParamDriver that drives the target's
// position. The recurrence (semi-implicit Euler, per-frame k/c absorbing dt):
//   newVel = prevVel + k·(target − prevPos) − c·prevVel   (slot 1)
//   newPos = prevPos + newVel                             (slot 0)
// so the target (a controller Null's whole position, bound to `inputVec`) is
// followed with overshoot + settle. Lag/Spring becoming SAVED sub-networks (not node
// types) is the meta-op's whole point — this is the first such saved network.

export interface SpringRequest {
  /** The node whose position the spring drives. */
  targetId: string;
  /** The transform param driven (a Vector3). Default 'position'. */
  paramPath?: string;
  /** The controller node whose whole position is the spring's live target (a Null). */
  controllerId: string;
  /** Per-frame stiffness k (how hard it's pulled toward the target). */
  stiffness?: number;
  /** Per-frame damping c (how fast oscillation decays; c² < 4k ⇒ underdamped/overshoot). */
  damping?: number;
  /** The frame the recurrence is seeded from (spring starts at rest on the target). */
  seedFrame?: number;
  /** Fresh, unused node ids keyed by sub-network role — caller-supplied so the builder
   *  stays pure + deterministic (no Date.now/Math.random). */
  idFor: (key: SpringNodeKey) => string;
}

export type SpringBuildResult = { ok: true; ops: Op[] } | { ok: false; reason: string };

/** Default spring feel: moderately stiff, clearly under-damped (a visible overshoot
 *  that settles within ~2s). Tunable later; c² < 4k here so it oscillates. */
const DEFAULT_STIFFNESS = 0.12;
const DEFAULT_DAMPING = 0.14;

/**
 * The Op chain that builds a spring driving `targetId.paramPath` from `controllerId`,
 * or a rejection when it would create a driver cycle (G6 — the controller transitively
 * reading back the target). `dispatchAtomic` computes the inverse (removeNode/disconnect)
 * for undo, so the whole spring is one undo entry.
 */
export function buildSpringOps(state: DagState, req: SpringRequest): SpringBuildResult {
  const { targetId, controllerId, idFor } = req;
  const paramPath = req.paramPath ?? 'position';
  const k = req.stiffness ?? DEFAULT_STIFFNESS;
  const c = req.damping ?? DEFAULT_DAMPING;
  const seedFrame = req.seedFrame ?? 0;
  if (!targetId || !controllerId) return { ok: false, reason: 'missing target or controller' };
  // G6 — the driven target will depend on the controller through the spring's Solver.
  // Reject if the controller already (transitively) depends on the target.
  if (wouldCreateCycle(state, controllerId, targetId, driverParamDeps(state.nodes))) {
    return { ok: false, reason: 'spring would create a driver cycle' };
  }
  // #1552 — a spring on a path that certainly names no parameter would drive nothing.
  const missing = missingParamPath(state, targetId, paramPath, 'vec3', { mechanism: 'driver' });
  if (missing) return { ok: false, reason: `'${paramPath}' is not a parameter: ${missing.reason}` };

  const id = idFor;
  const wire = (from: NodeRef, to: NodeRef): Op => ({ type: 'connect', from, to });
  // #1559 — the spring is an instance of the built-in Spring template (`springBodyOps` is its
  // body), holding this spring's controller, start frame and feel.
  const spring = placeBuiltin(state, 'Spring', id('solver'), {
    sourceTransformVec: { node: controllerId },
    seedFrame,
    stiffness: k,
    damping: c,
  });
  if (!spring.ok) return spring;
  const ops: Op[] = [
    ...spring.ops,
    // The vec driver: target.paramPath ← the spring's output (the sprung position).
    {
      type: 'addNode',
      nodeId: id('driver'),
      nodeType: 'ParamDriver',
      // #315 — top of the band, like every other bind road (empty band → 0, byte-identical).
      params: {
        target: targetId,
        paramPath,
        blendMode: 'replace',
        order: nextDriverOrder(state.nodes, targetId, paramPath),
      },
    },
    wire({ node: id('solver'), socket: 'out' }, { node: id('driver'), socket: 'in' }),
  ];
  return { ok: true, ops };
}
