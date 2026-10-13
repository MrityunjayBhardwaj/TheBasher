// #1353 — binding a mesh to an armature: the one plan the panel and the agent both run.
//
// A bind is two operators on the mesh's own stack, in this order from the bottom: Capture, which
// writes the weights, and the Armature modifier, which deforms by them. Both point at the same
// armature Object. Blender's "Parent › With Envelope Weights" does the same two things in one
// gesture — it makes the vertex groups and adds the Armature modifier (`armature_skinning.cc`,
// `add_verts_to_dgroups`; `object_relations.cc`, `parent_set`) — and, as there, the parent link
// is not part of it: where the mesh hangs in the scene is a separate fact.
//
// The same module answers the two questions the inspector asks of an operator already in a stack:
// which armature it points at (and how to point it at another), and what its capture did.
//
// REF: src/nodes/CaptureModifier.ts (`planCapture`); src/nodes/ArmatureModifier.ts;
//      src/app/operatorStack.ts (the one wiring road); issue #1353.

import type { DagState } from '../../core/dag/state';
import type { EvaluatorCache } from '../../core/dag/evaluator';
import type { NodeId, Op } from '../../core/dag/types';
import type { ObjectData, ObjectValue } from '../../nodes/types';
import { applyOp } from '../../core/dag/ops';
import { evaluate } from '../../core/dag/evaluator';
import { isArmatureObject } from '../armatureMode';
import { canModifyGeometry } from '../modifierGeometry';
import { buildAddModifierOps, enumerateModifierStack, resolveStackBase } from '../operatorStack';
import {
  captureSettingsOf,
  planCapture,
  type CaptureMethod,
  type CaptureSettings,
  type CapturePlan,
} from '../../nodes/CaptureModifier';
import { edgeSocket, edgeTarget } from './graphNodes';

/** The operators that take an armature Object on their `armature` input. */
export const ARMATURE_INPUT_TYPES: readonly string[] = ['CaptureModifier', 'ArmatureModifier'];

export interface BindSkinRequest {
  /** The mesh: its Object, its data node, or any operator in its stack. */
  readonly mesh: NodeId;
  /** The armature Object. */
  readonly armature: NodeId;
  /** Each left out takes the Capture node's own default. */
  readonly method?: CaptureMethod;
  readonly maxInfluences?: number;
  readonly dropoff?: number;
  readonly resolution?: number;
  readonly falloff?: number;
}

export type BindSkinPlan =
  | {
      readonly ok: true;
      readonly ops: Op[];
      readonly captureId: NodeId;
      readonly deformId: NodeId;
      /** What the capture will do on the mesh as it stands. */
      readonly capture: Extract<CapturePlan, { kind: 'captured' }>;
    }
  | { readonly ok: false; readonly reason: string };

/** A node's output value, or undefined when it cannot be evaluated (a cycle, a dangling edge). */
function valueOf(state: DagState, nodeId: NodeId, cache?: EvaluatorCache): unknown {
  try {
    return evaluate(state, nodeId, { cache }).value;
  } catch {
    return undefined;
  }
}

/** Every armature Object in the graph, in id order — what a bind can point at. */
export function armatureObjectsIn(state: DagState): NodeId[] {
  return Object.keys(state.nodes)
    .filter((id) => isArmatureObject(state, id))
    .sort();
}

/**
 * Plan binding `req.mesh` to `req.armature`, or say why not. Refused, by name: a mesh that is not
 * one, an armature that is not one, a mesh already bound, and a capture that would bind nothing
 * (`planCapture`'s own reasons — no deforming bone, a mesh that is not stored).
 */
export function planBindSkin(
  state: DagState,
  req: BindSkinRequest,
  cache?: EvaluatorCache,
): BindSkinPlan {
  if (!state.nodes[req.mesh]) return { ok: false, reason: `"${req.mesh}" is not in the scene.` };
  if (!state.nodes[req.armature]) {
    return { ok: false, reason: `"${req.armature}" is not in the scene.` };
  }
  if (!isArmatureObject(state, req.armature)) {
    return {
      ok: false,
      reason: `"${req.armature}" is not an armature: a bind needs an Object whose data is a skeleton.`,
    };
  }
  const base = resolveStackBase(state, req.mesh);
  if (!canModifyGeometry(state, base, cache)) {
    return { ok: false, reason: `"${req.mesh}" has no mesh to bind.` };
  }
  const stack = enumerateModifierStack(state, base);
  const bound = stack.find((entry) => ARMATURE_INPUT_TYPES.includes(entry.type));
  if (bound) {
    return {
      ok: false,
      reason: `"${req.mesh}" is already bound (its stack has "${bound.nodeId}"): remove it, or point it at another armature.`,
    };
  }
  // What the capture would read: the top of the stack as it stands, and the armature Object.
  const top = stack.length > 0 ? stack[stack.length - 1].nodeId : base;
  const params: CaptureSettings = captureSettingsOf({
    method: req.method,
    maxInfluences: req.maxInfluences,
    dropoff: req.dropoff,
    resolution: req.resolution,
    falloff: req.falloff,
  });
  const capture = planCapture(
    valueOf(state, top, cache) as ObjectData | undefined,
    valueOf(state, req.armature, cache) as ObjectValue | undefined,
    params,
  );
  if (capture.kind === 'refused') return { ok: false, reason: capture.reason };

  const armatureEdge = { node: req.armature, socket: 'out' };
  const ops: Op[] = [];
  let next = state;
  const run = (op: Op) => {
    next = applyOp(next, op).next;
    ops.push(op);
  };
  const made = buildAddModifierOps(next, base, 'CaptureModifier', params);
  if (!made) return { ok: false, reason: `"${req.mesh}" has no mesh to bind.` };
  made.ops.forEach(run);
  run({ type: 'connect', from: armatureEdge, to: { node: made.modifierId, socket: 'armature' } });
  const deform = buildAddModifierOps(next, base, 'ArmatureModifier');
  if (!deform) return { ok: false, reason: `"${req.mesh}" has no mesh to bind.` };
  deform.ops.forEach(run);
  run({ type: 'connect', from: armatureEdge, to: { node: deform.modifierId, socket: 'armature' } });
  return { ok: true, ops, captureId: made.modifierId, deformId: deform.modifierId, capture };
}

/** The armature Object `nodeId` (a Capture or an Armature modifier) points at, or null. */
export function armatureOf(state: DagState, nodeId: NodeId): NodeId | null {
  return edgeTarget(state.nodes[nodeId], 'armature');
}

/** The ops that point `nodeId`'s `armature` input at `armature`, or at nothing (null). */
export function setArmatureOps(state: DagState, nodeId: NodeId, armature: NodeId | null): Op[] {
  const to = { node: nodeId, socket: 'armature' };
  const current = armatureOf(state, nodeId);
  if (current === armature) return [];
  const ops: Op[] = [];
  if (current !== null) {
    const socket = edgeSocket(state.nodes[nodeId], 'armature');
    ops.push({ type: 'disconnect', from: { node: current, socket }, to });
  }
  if (armature !== null) ops.push({ type: 'connect', from: { node: armature, socket: 'out' }, to });
  return ops;
}

/**
 * What the Capture at `nodeId` did, read the way its own `evaluate` reads it: the value on its
 * spine and the armature Object on its second input, through `planCapture`.
 */
export function captureStatusOf(
  state: DagState,
  nodeId: NodeId,
  cache?: EvaluatorCache,
): CapturePlan | null {
  const node = state.nodes[nodeId];
  if (node?.type !== 'CaptureModifier') return null;
  const target = edgeTarget(node, 'target');
  const armature = armatureOf(state, nodeId);
  return planCapture(
    target === null ? undefined : (valueOf(state, target, cache) as ObjectData | undefined),
    armature === null ? undefined : (valueOf(state, armature, cache) as ObjectValue | undefined),
    captureSettingsOf(node.params as Partial<CaptureSettings>),
  );
}

/** One sentence for a capture's result — the line the inspector prints under the operator. */
export function captureStatusText(plan: CapturePlan): string {
  if (plan.kind === 'refused') return `Nothing is captured: ${plan.reason}`;
  const said = [`${plan.points} points bound to ${plan.bones} bone${plan.bones === 1 ? '' : 's'}.`];
  if (plan.unbound > 0) {
    said.push(`${plan.unbound} of them are held by no bone and stay at rest.`);
  }
  const heat = plan.method === 'heat';
  if (plan.unreached > 0) {
    said.push(
      heat
        ? `${plan.unreached} are on parts with no bone in sight from inside, and are bound by nearness instead.`
        : `${plan.unreached} could not be reached through the mesh's inside and are bound by straight-line distance instead.`,
    );
  }
  if (plan.outside.length > 0) {
    const one = plan.outside.length === 1;
    const shown = plan.outside.slice(0, OUTSIDE_NAMED).join(', ');
    const more = plan.outside.length - OUTSIDE_NAMED;
    const why = heat
      ? `${plan.outside.length} bone${one ? ' holds' : 's hold'} no point`
      : `${plan.outside.length} bone${one ? ' lies' : 's lie'} outside the mesh's volume, so nothing is measured from ${one ? 'it' : 'them'}`;
    said.push(`${why}: ${shown}${more > 0 ? ` and ${more} more` : ''}.`);
  }
  return said.join(' ');
}

/** How many outside bones the status line names before it counts the rest. */
const OUTSIDE_NAMED = 3;

/** Did the capture bind every point the way its method measures, from every bone? */
export function captureIsWhole(plan: CapturePlan): boolean {
  return (
    plan.kind === 'captured' &&
    plan.unbound === 0 &&
    plan.unreached === 0 &&
    plan.outside.length === 0
  );
}
