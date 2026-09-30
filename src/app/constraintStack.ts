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

import { createEvaluatorCache, type EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import type { ParamOption } from '../nodes/paramWidget';
import {
  relationalPoseStackForTarget,
  isRelationalPoseNode,
  nextConstraintOrder,
} from './nodeConstraints';
import type { StackRowEntry } from './OperatorStackRows';
import { resolveWorldTransform } from './resolveWorldTransform';
import { readCurveSampleAt } from './curveSampleSource';
import { nodeDisplayName } from './sceneTreeWalk';
import { characterNodeNames } from './characterParts';

/** A constraint kind the user can add, and what it POINTS WITH.
 *
 *  #353 — `pointer` is the param naming the other node (the aim subject, the path) and
 *  `pointeeProblem` is the RESOLVER's own test for whether that node can serve, or why not.
 *  Both kinds degrade silently on a bad pointee — a Track-To whose `aimNode` has no world
 *  position aims at `aimPoint` (`aimTargetWorld`), a Follow-Path whose `curve` samples
 *  nothing contributes nothing to the fold — so a road that writes a pointee must ask first.
 *  They live on the row so the agent's `mutator.constrain` reads its whole vocabulary from
 *  here: a kind added to this list is speakable with no mutator change. */
export interface AddableConstraint {
  readonly type: string;
  readonly label: string;
  readonly pointer: string;
  readonly pointeeProblem: (
    state: DagState,
    nodeId: string,
    cache: EvaluatorCache,
  ) => string | null;
}

const EVAL_AT_ZERO = { time: { frame: 0, seconds: 0, normalized: 0 } };

/** The constraints the user can add from the "+ Add" menu. Follow-Path / Copy-Location
 *  join HERE (plus `isRelationalPoseNode` + registerAll) — as stack MEMBERS, never as a
 *  new bespoke panel. */
export const ADDABLE_CONSTRAINTS: ReadonlyArray<AddableConstraint> = [
  {
    type: 'TrackTo',
    label: 'Track To',
    pointer: 'aimNode',
    pointeeProblem: (state, id, cache) =>
      resolveWorldTransform(state, id, EVAL_AT_ZERO, cache) === null
        ? `"${id}" has no place in the scene to aim at.`
        : null,
  },
  {
    type: 'FollowPath',
    label: 'Follow Path',
    pointer: 'curve',
    pointeeProblem: (state, id, cache) =>
      readCurveSampleAt(state, id, 0, EVAL_AT_ZERO, cache) === null
        ? `"${id}" is not a path — a Follow-Path needs a Curve object to ride.`
        : null,
  },
];

/**
 * #1404 — the constraint a second request should RE-POINT rather than stack a rival beside: the
 * LIVE member of `type` on `targetId` that the fold lets win, i.e. the top of the stack. One
 * answer, because two roads asked it separately and answered differently (first by sorted id,
 * muted included — which could re-aim a bypassed constraint and change nothing on screen, or
 * the one the fold lets LOSE). Null when there is none, and the caller adds one.
 */
export function liveConstraintOfType(
  state: DagState,
  targetId: string,
  type: string,
): string | null {
  const live = relationalPoseStackForTarget(state.nodes, targetId).filter(
    (m) => state.nodes[m.nodeId]?.type === type,
  );
  return live.length > 0 ? live[live.length - 1].nodeId : null;
}

/** The addable row for `type`, or undefined. */
export function addableConstraint(type: string): AddableConstraint | undefined {
  return ADDABLE_CONSTRAINTS.find((c) => c.type === type);
}

/**
 * #1065 — the picker for a constraint's `target`, the object it constrains: every node the
 * resolver can place in the world.
 *
 * Both bands start there. The aim asks `resolveWorldTransform` for the constrained object first
 * and returns nothing without it (`resolveConstraintRotation`), and a followed position only
 * shows on a node the renderer places. So that is the filter, not "carries a `position`" (the
 * aim picker's `transformable`): measured on the default scene plus one of every primitive,
 * `transformable` offered an unwired Group and Transform, which are placed nowhere, and left
 * out the AmbientLight, which is placed. On the two example projects the two lists agree.
 *
 * One evaluator cache for the whole scan, so the render root is evaluated once, not per node.
 */
export function constrainedObjectOptions(state: DagState): ParamOption[] {
  const ctx = { time: { frame: 0, seconds: 0, normalized: 0 } };
  const cache = createEvaluatorCache();
  const out: ParamOption[] = [];
  for (const node of Object.values(state.nodes)) {
    if (resolveWorldTransform(state, node.id, ctx, cache) === null) continue;
    out.push({ value: node.id, label: nodeDisplayName(state.nodes, node.id) });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * The rows for `targetId`'s Constraints panel — every member INCLUDING bypassed ones
 * (a muted row must still render so the user can re-enable it), bottom → top in the
 * SAME order the resolver folds them.
 */
/** #1284 — the parts a Track-To (`constraintId`) can aim at inside its aim target: every glTF node
 *  of the character its `aimNode` stands for (its bones among them). None when the
 *  aim target is not a character — the empty value then aims at the object itself. */
export function characterPartOptions(state: DagState, constraintId: string): ParamOption[] {
  const aimNode = (state.nodes[constraintId]?.params as { aimNode?: unknown } | undefined)?.aimNode;
  if (typeof aimNode !== 'string' || !aimNode) return [];
  return characterNodeNames(state, aimNode).map((name) => ({ value: name, label: name }));
}

export function constraintStackEntries(state: DagState, targetId: string): StackRowEntry[] {
  // #339 — the TYPE-AGNOSTIC scan: an object has ONE constraint stack, and the panel is
  // its view. Reading a single band's view here would render a stack that silently omits
  // every member of the other one — a Follow-Path a director could neither see, reorder,
  // bypass nor remove, while it moved the object.
  return relationalPoseStackForTarget(state.nodes, targetId, true).map((m) => ({
    nodeId: m.nodeId,
    muted: m.muted,
    label: nodeDisplayName(state.nodes, m.nodeId),
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
  const constraintId = explicitId ?? newId('con');
  return {
    ops: [
      {
        type: 'addNode',
        nodeId: constraintId,
        nodeType: constraintType,
        // #317 — the top-of-stack rule now has ONE home (`nextConstraintOrder`), shared
        // with the sidecar creation sites (camera look-at, studio lights) so every road
        // that adds a constraint lands it on top the same way. Pose twin of nextDriverOrder.
        params: { target: targetId, order: nextConstraintOrder(state.nodes, targetId) },
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

  // #339 — the type-agnostic scan, for the same reason the panel uses it: the rows the
  // user is reordering are the WHOLE stack. Moving against a single band's view would
  // compute the neighbour from a different list than the one on screen.
  const stack = relationalPoseStackForTarget(state.nodes, targetId, true);
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
