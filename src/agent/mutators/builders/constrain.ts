// constrain / unconstrain Mutators — the constraint family's verbs (#353, Slice A of #331).
//
// "Point the camera at the cube", "make the camera follow the path". A constraint is an
// EDGE-LESS pose operator: a node naming its `target` by param, ordered in the target's
// stack by an `order` field (constraintStack.ts). So these emit no connect — add, re-point
// and remove are field writes plus addNode/removeNode, like `addStrip`.
//
// THE KIND AXIS IS DERIVED. `type` is `z.enum` over ADDABLE_CONSTRAINTS — the panel's own
// "+ Add" list — and the param each kind points WITH (`aimNode`, `curve`) and the test for
// a usable pointee come from the same table. A new constraint kind joins that list and is
// speakable here with no mutator change and no new catalogue bytes.
//
// ONE AUTHORITY FOR THE OPS. A fresh constraint is `buildAddConstraintOps` (top-of-stack
// `order` via `nextConstraintOrder`), given a deterministic id so `build` stays pure; a
// removal is `buildRemoveConstraintOps`. The panel and the voice cannot drift.
//
// A SECOND REQUEST RE-POINTS; IT DOES NOT STACK. The decision `mutator.camera.trajectory`
// recorded (#774): two live Track-Tos on one object are not two aims — the fold is
// last-writer-wins by `order`, and the loser is still drawn in the panel, a displayed ≠
// rendered split. So a LIVE constraint of the same kind already on the target has its
// pointer re-aimed. A muted one is not reused: re-pointing it would change nothing on
// screen.
//
// A POINTEE THAT CANNOT RESOLVE IS REFUSED, NOT WRITTEN. Both kinds degrade silently: a
// Track-To whose `aimNode` has no world position aims at `aimPoint` (the origin), and a
// Follow-Path whose `curve` is not a curve contributes nothing. Each kind's `pointeeProblem` is
// the resolver's own test, so a plan the gates accept is one the viewport draws.
//
// REF: src/app/constraintStack.ts (ADDABLE_CONSTRAINTS, the builders);
//      src/app/nodeConstraints.ts (aimTargetWorld, the follow fold);
//      src/agent/mutators/builders/cameraTrajectory.ts (the re-point decision);
//      src/agent/mutators/builders/addStrip.ts (the edge-less template).

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { NodeId, Op } from '../../../core/dag/types';
import {
  ADDABLE_CONSTRAINTS,
  addableConstraint,
  buildAddConstraintOps,
  buildRemoveConstraintOps,
  liveConstraintOfType,
} from '../../../app/constraintStack';
import { relationalPoseStackForTarget } from '../../../app/nodeConstraints';
import { resolveWorldTransform } from '../../../app/resolveWorldTransform';
import { createEvaluatorCache, type EvaluatorCache } from '../../../core/dag/evaluator';

/** The kinds `constrain` speaks — ADDABLE_CONSTRAINTS, projected (exported for the pin). */
export const ConstraintType = z.enum(
  ADDABLE_CONSTRAINTS.map((c) => c.type) as [string, ...string[]],
);

const ConstrainSpec = z.object({
  /** The object the constraint moves (a camera, a light, a mesh…). */
  target: z.string().min(1),
  type: ConstraintType,
  /** What it points at: the node to aim at (TrackTo) or the path to ride (FollowPath). */
  to: z.string().min(1),
});
export type ConstrainSpec = z.infer<typeof ConstrainSpec>;

const UnconstrainSpec = z.object({
  target: z.string().min(1),
  /** Only this kind; omitted → every constraint on the target. */
  type: ConstraintType.optional(),
});
export type UnconstrainSpec = z.infer<typeof UnconstrainSpec>;

const EVAL_CTX = { time: { frame: 0, seconds: 0, normalized: 0 } };

/** The target must be something the resolver places, or no band it writes is drawn —
 *  the same filter the panel's target picker applies (`constrainedObjectOptions`). */
function targetProblem(state: DagState, target: string, cache: EvaluatorCache): string | null {
  if (!state.nodes[target]) return `target "${target}" not in DAG.`;
  if (resolveWorldTransform(state, target, EVAL_CTX, cache) === null) {
    return `target "${target}" (${state.nodes[target].type}) is not placed in the scene, so nothing a constraint writes would show.`;
  }
  return null;
}

/** Every member — muted ones too — for a removal: a bypassed constraint is still one. */
function allMembers(state: DagState, target: string, type?: string): NodeId[] {
  return relationalPoseStackForTarget(state.nodes, target, true)
    .map((m) => m.nodeId)
    .filter((id) => type === undefined || state.nodes[id]?.type === type);
}

function freshId(base: string, used: ReadonlySet<string>): NodeId {
  let n = 1;
  while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

export const constrainMutator: MutatorDefinition<ConstrainSpec> = {
  name: 'mutator.constrain',
  description:
    'Aim an object at another (TrackTo) or move it along a path (FollowPath). ' +
    'A live constraint of the same type already on the target is re-pointed, not stacked. ' +
    'The target keeps its authored pose; the constraint overrides the band it writes.',
  spec: ConstrainSpec,
  specExample: { target: 'camera_id', type: 'TrackTo', to: 'node_id' },
  contract: {
    // Edge-less (V57): the constraint names its target and pointee by param.
    requiredEdges: [],
    // Nothing is required by TYPE: a camera, a light and a mesh are all constrainable, and a
    // split object is an Object posing its data. `preconditions` checks THESE ids instead.
    requiredNodeTypes: [],
    // A Track-To overrides rotation and a Follow-Path position, so neither is claimed. What
    // no constraint derives survives.
    preserves: ['scale', 'material', 'children', 'animation'],
  },
  buildClosureSpec(spec): ClosureSpec {
    // 'id-ref' from the target reaches the constraints already naming it — the re-point
    // case writes to one of those, so it must be in scope. A fresh constraint is a fresh
    // addNode, which the closure gate admits on its own.
    return { rootSelectors: [spec.target, spec.to], followedEdges: ['id-ref'] };
  },
  preconditions(spec, _closure, state) {
    // One cache for both checks: each resolves the render root, and nothing changes between them.
    const cache = createEvaluatorCache();
    const t = targetProblem(state, spec.target, cache);
    if (t) return { ok: false, reason: t };
    if (spec.to === spec.target) {
      return { ok: false, reason: `a ${spec.type} cannot point "${spec.target}" at itself.` };
    }
    if (!state.nodes[spec.to]) return { ok: false, reason: `"${spec.to}" not in DAG.` };
    const p = addableConstraint(spec.type)!.pointeeProblem(state, spec.to, cache);
    if (p) return { ok: false, reason: p };
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const kind = addableConstraint(spec.type)!;
    const existing = liveConstraintOfType(state, spec.target, spec.type);
    if (existing) {
      return [{ type: 'setParam', nodeId: existing, paramPath: kind.pointer, value: spec.to }];
    }
    const id = freshId(
      `${spec.target}_${spec.type.toLowerCase()}`,
      new Set(Object.keys(state.nodes)),
    );
    const built = buildAddConstraintOps(state, spec.target, spec.type, id)!;
    return built.ops.map((op) =>
      op.type === 'addNode'
        ? { ...op, params: { ...(op.params as object), [kind.pointer]: spec.to } }
        : op,
    );
  },
};

export const unconstrainMutator: MutatorDefinition<UnconstrainSpec> = {
  name: 'mutator.unconstrain',
  description:
    'Remove the constraints on an object — only those of `type` when given, else all. ' +
    'The object returns to its authored pose.',
  spec: UnconstrainSpec,
  specExample: { target: 'camera_id', type: 'TrackTo' },
  contract: {
    requiredEdges: [],
    requiredNodeTypes: [],
    // Removing a constraint hands the band back to the authored pose, so position and
    // rotation are exactly what changes.
    preserves: ['scale', 'material', 'children', 'animation'],
    lossy: [{ kind: 'delete', reason: 'Deletes the constraint nodes.' }],
  },
  buildClosureSpec(spec): ClosureSpec {
    return { rootSelectors: [spec.target], followedEdges: ['id-ref'] };
  },
  preconditions(spec, _closure, state) {
    if (!state.nodes[spec.target])
      return { ok: false, reason: `target "${spec.target}" not in DAG.` };
    if (allMembers(state, spec.target, spec.type).length === 0) {
      return {
        ok: false,
        reason: `"${spec.target}" has no ${spec.type ?? 'constraint'} to remove.`,
      };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    return allMembers(state, spec.target, spec.type).flatMap(
      (id) => buildRemoveConstraintOps(state, id) ?? [],
    );
  },
};
