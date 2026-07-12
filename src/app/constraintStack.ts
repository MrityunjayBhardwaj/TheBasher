// constraintStack — the AUTHORING half of the constraint (relational-CHOP) stack
// (#312). The CHOP counterpart of `operatorStack.ts`, and the contrast between the two
// files IS the design:
//
//   operatorStack (SOP) : a stack is a wired sub-chain. add/move/remove = RE-WIRING.
//   constraintStack(CHOP): a constraint is EDGE-LESS — it names its target by a param.
//                          A stack is the SET of pose operators sharing a `target`,
//                          ordered by an `order` FIELD. add/move/remove = FIELD WRITES.
//                          There is no wire to re-route ("modifiers are [sub-chains];
//                          constraints aren't" — operatorStack.ts).
//
// Enumeration is NOT duplicated here: it comes from `constraintStackForTarget`
// (nodeConstraints.ts) — the SAME scan + sort the resolvers fold — asked for its
// muted members too. That is deliberate: if the panel enumerated separately it could
// drift from the resolver, and the rows would stop matching what actually renders.
//
// Every mutation is a pure Op[] (dispatchAtomic at the call site → save/undo/animate
// for free, V1), mirroring operatorStack/studioProfiles.
//
// REF: src/app/nodeConstraints.ts (the shared enumeration + the fold);
//      src/app/ConstraintStackControls.tsx (the panel); src/app/operatorStack.ts (the
//      SOP twin); docs/RELATIONAL-OPERATORS-DESIGN.md §8.

import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { constraintStackForTarget, isRelationalPoseNode } from './nodeConstraints';
import type { StackRowEntry } from './OperatorStackRows';
import { nodeDisplayName } from './sceneTreeWalk';

/** The constraints the user can add from the "+ Add" menu. Follow-Path / Copy-Location
 *  join HERE (plus `isRelationalPoseNode` + registerAll) — as stack MEMBERS, never as a
 *  new bespoke panel. */
export const ADDABLE_CONSTRAINTS: ReadonlyArray<{ type: string; label: string }> = [
  { type: 'TrackTo', label: 'Track To' },
];

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * The rows for `targetId`'s Constraints panel — every member INCLUDING bypassed ones
 * (a muted row must still render so the user can re-enable it), bottom → top in the
 * SAME order the resolver folds them.
 */
export function constraintStackEntries(state: DagState, targetId: string): StackRowEntry[] {
  return constraintStackForTarget(state.nodes, targetId, true).map((m) => ({
    nodeId: m.nodeId,
    muted: m.muted,
    label: nodeDisplayName(state.nodes[m.nodeId]),
  }));
}

/** Add a constraint to the TOP of `targetId`'s stack: a new edge-less node carrying the
 *  `target` + an `order` above every current member. No wiring — that is the whole
 *  point of the species. Returns null if the target is unknown. */
export function buildAddConstraintOps(
  state: DagState,
  targetId: string,
  constraintType: string,
  explicitId?: string,
): { ops: Op[]; constraintId: string } | null {
  if (!state.nodes[targetId]) return null;
  const stack = constraintStackForTarget(state.nodes, targetId, true);
  const topOrder = stack.length > 0 ? stack[stack.length - 1].order : -1;
  const constraintId = explicitId ?? newId('con');
  return {
    ops: [
      {
        type: 'addNode',
        nodeId: constraintId,
        nodeType: constraintType,
        params: { target: targetId, order: topOrder + 1 },
      },
    ],
    constraintId,
  };
}

/** Bypass / un-bypass a constraint. (`mute` — the constraint's param name; a geometry
 *  modifier spells the same idea `muted`. The shared row component takes a normalized
 *  boolean, and each builder writes its own field.) */
export function buildToggleConstraintMuteOp(state: DagState, constraintId: string): Op | null {
  const node = state.nodes[constraintId];
  if (!node || !isRelationalPoseNode(node)) return null;
  const muted = (node.params as { mute?: unknown }).mute === true;
  return { type: 'setParam', nodeId: constraintId, paramPath: 'mute', value: !muted };
}

/**
 * Move a constraint one slot up (later) or down (earlier) in its target's stack.
 * A SWAP of the two members' `order` values — the edge-less analogue of the geometry
 * stack's re-wire. Written as two setParams so it is one undo entry and the resulting
 * orders stay a clean permutation (no drift from repeated moves).
 *
 * Uses the stack INCLUDING muted members, so a bypassed row reorders like any other —
 * what you see in the panel is what moves.
 */
export function buildMoveConstraintOps(
  state: DagState,
  constraintId: string,
  dir: 'up' | 'down',
): Op[] | null {
  const node = state.nodes[constraintId];
  if (!node || !isRelationalPoseNode(node)) return null;
  const targetId = (node.params as { target?: unknown }).target;
  if (typeof targetId !== 'string' || !targetId) return null;

  const stack = constraintStackForTarget(state.nodes, targetId, true);
  const i = stack.findIndex((m) => m.nodeId === constraintId);
  if (i < 0) return null;
  const j = dir === 'up' ? i + 1 : i - 1;
  if (j < 0 || j >= stack.length) return null; // already at the end — the UI disables this

  const a = stack[i];
  const b = stack[j];
  // Equal orders (every pre-stack project) would make a swap a no-op — assign the
  // NEIGHBOUR'S INDEX-derived slot instead so the move is always observable.
  const aOrder = a.order === b.order ? j : b.order;
  const bOrder = a.order === b.order ? i : a.order;
  return [
    { type: 'setParam', nodeId: a.nodeId, paramPath: 'order', value: aOrder },
    { type: 'setParam', nodeId: b.nodeId, paramPath: 'order', value: bOrder },
  ];
}

/** Remove a constraint. Edge-less → nothing to unwire; the node just goes. */
export function buildRemoveConstraintOps(state: DagState, constraintId: string): Op[] | null {
  const node = state.nodes[constraintId];
  if (!node || !isRelationalPoseNode(node)) return null;
  return [{ type: 'removeNode', nodeId: constraintId }];
}
