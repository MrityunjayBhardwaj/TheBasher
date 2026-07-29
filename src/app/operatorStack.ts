// operatorStack — the OperatorStack abstraction (the lifted #203), the
// wiring+serialize half of [[V58]] (epic #201, #209). Blender's clean two-stack
// UX over Houdini's one-graph engine: a "stack" is sugar over a LINEAR sub-chain
// of typed operator nodes in the DAG (each operator's `target` input = the
// previous operator's `out`). add / remove / reorder / mute reduce to RE-WIRING
// (§2.2). This module owns ONLY that wiring + enumeration; the operators
// themselves are plain NodeDefinitions (V58 — no god-class above them).
//
// #209 instantiates it as the GEOMETRY stack (Mesh→Mesh modifiers). It is the
// SECOND operator consumer (the deferral via Vairagya is now earned): constraints
// were the first, but #204 proved a constraint resolves edge-LESS at the scene
// layer (it needs world position) — so the transform stack is NOT a sub-chain and
// this helper serves the GEOMETRY stack only. The polymorphism the design doc
// imagined collapses to "one sub-chain helper for the operators that ARE
// sub-chains" — modifiers are; constraints aren't.
//
// Every mutation is a pure Op[] (dispatchAtomic at the call site → save/undo/
// animate for free, V1), mirroring studioProfiles. removeNode's "refuse while
// consumed" rule (V1) is respected by disconnecting an edge before removing.
//
// REF: src/nodes/ArrayModifier.ts (the first operator); src/app/studioProfiles.ts
//      (the Op-builder template); docs/OPERATORS-AND-LIGHTING-DESIGN.md §2.2/§5;
//      vyapti V58.

import type { DagState } from '../core/dag/state';
import type { Node, NodeRef, Op } from '../core/dag/types';
import { getNodeType } from '../core/dag/registry';
import { canModifyGeometry } from './modifierGeometry';
import { nodeDisplayName } from './sceneTreeWalk';

/** The geometry-operator (SOP / modifier) node types this stack manages. A node
 *  is a modifier iff its type is registered here — new modifiers (Mirror, Subdiv…)
 *  register by adding their type, nothing else. They all share the Mesh `target`
 *  input / Mesh `out` output shape, which is what makes the sub-chain uniform. */
export const MODIFIER_NODE_TYPES: ReadonlySet<string> = new Set([
  'ArrayModifier',
  'MirrorModifier',
]);

/** The video-effect (Image→Image) node types — the [[V58]] lift to the Image socket
 *  (epic #235 / spine 1e+). An effect is a typed `target: Image`/`out: Image`
 *  operator on the SAME sub-chain engine as a geometry modifier; new effects
 *  register by adding their type here, nothing else. The stack helpers are socket-
 *  agnostic (they re-wire `target`/`out` edges) — only this predicate differs. */
export const EFFECT_NODE_TYPES: ReadonlySet<string> = new Set(['ColorCorrect']);

/** Predicate over the set of node types an OperatorStack instance manages. */
export type OperatorPredicate = (node: Node | undefined) => boolean;

export function isModifierNode(node: Node | undefined): boolean {
  return !!node && MODIFIER_NODE_TYPES.has(node.type);
}

export function isEffectNode(node: Node | undefined): boolean {
  return !!node && EFFECT_NODE_TYPES.has(node.type);
}

/** One entry in an operator stack, bottom (closest to the base) → top. */
export interface ModifierEntry {
  readonly nodeId: string;
  readonly type: string;
  readonly muted: boolean;
  readonly label: string;
}

const OUT = 'out';
const TARGET = 'target';
const DATA = 'data';

/**
 * Is `node` a POSER — an object that wears data through a `data` input? Derived from
 * the registry (it declares a `data` input carrying the `ObjectData` socket), never
 * matched against `type === 'Object'`: a type list is exactly the drift #377 measured
 * when the modifier's supported-source set named a retired type AND missed a live one
 * at the same time. A future poser is covered the day it declares the socket.
 */
function isPoserNode(node: Node | undefined): boolean {
  if (!node) return false;
  return getNodeType(node.type)?.inputs[DATA]?.type === 'ObjectData';
}

/** The single ref a (possibly list) input binding holds for `socket`, or null. */
function singleRef(node: Node | undefined, socket: string): NodeRef | null {
  const b = node?.inputs[socket];
  if (!b) return null;
  return Array.isArray(b) ? (b[0] ?? null) : b;
}

/**
 * The node + input-socket that consumes `(fromNode, fromSocket)`. Scans every
 * node's input bindings (single or list) for a ref back to the producer. Returns
 * the FIRST consumer found — the stack model assumes a linear chain (one consumer
 * per modifier `out`); a fan-out mesh is outside v1 scope (the UI builds chains).
 */
export function findConsumer(
  state: DagState,
  fromNode: string,
  fromSocket: string = OUT,
): { node: string; socket: string } | null {
  for (const node of Object.values(state.nodes)) {
    for (const [socket, binding] of Object.entries(node.inputs)) {
      const refs = Array.isArray(binding) ? binding : binding ? [binding] : [];
      for (const ref of refs) {
        if (ref.node === fromNode && ref.socket === fromSocket) {
          return { node: node.id, socket };
        }
      }
    }
  }
  return null;
}

function muted(node: Node): boolean {
  return (node.params as { muted?: unknown }).muted === true;
}

/**
 * The modifier stack on `baseNodeId`: walk forward from the base through the
 * Mesh→Mesh modifier sub-chain (base.out → m1.target, m1.out → m2.target, …),
 * collecting each modifier until the chain reaches a NON-modifier consumer (the
 * Scene / Transform / Group that renders the result). Bottom → top order. Pure.
 */
export function enumerateOperatorStack(
  state: DagState,
  baseNodeId: string,
  isOp: OperatorPredicate,
): ModifierEntry[] {
  const out: ModifierEntry[] = [];
  const seen = new Set<string>([baseNodeId]); // cycle guard (a DAG shouldn't, but be safe)
  let producer = baseNodeId;
  for (;;) {
    const consumer = findConsumer(state, producer, OUT);
    if (!consumer) break;
    const node = state.nodes[consumer.node];
    if (!isOp(node) || consumer.socket !== TARGET || seen.has(consumer.node)) break;
    seen.add(consumer.node);
    out.push({
      nodeId: node!.id,
      type: node!.type,
      muted: muted(node!),
      label: nodeDisplayName(node!),
    });
    producer = consumer.node;
  }
  return out;
}

/** The geometry-modifier stack on `baseNodeId` (bottom → top). The geometry
 *  instantiation of {@link enumerateOperatorStack}. */
export function enumerateModifierStack(state: DagState, baseNodeId: string): ModifierEntry[] {
  return enumerateOperatorStack(state, baseNodeId, isModifierNode);
}

/** The Image→Image effect stack on `baseNodeId` (bottom → top). The video-effect
 *  instantiation of {@link enumerateOperatorStack}. */
export function enumerateEffectStack(state: DagState, baseNodeId: string): ModifierEntry[] {
  return enumerateOperatorStack(state, baseNodeId, isEffectNode);
}

/**
 * The BASE mesh of a stack from any node in it: if `nodeId` is a modifier, walk
 * down its `target` chain past modifiers to the first non-modifier producer (the
 * mesh); if it is already a mesh-producer, return it unchanged. Lets the inspector
 * show the SAME stack whether the user selected the base mesh or one of its
 * modifiers (the rendered arrayed mesh click-selects the top modifier).
 */
export function resolveOperatorBase(
  state: DagState,
  nodeId: string,
  isOp: OperatorPredicate,
): string {
  let cur = nodeId;
  const seen = new Set<string>();
  while (isOp(state.nodes[cur]) && !seen.has(cur)) {
    seen.add(cur);
    const up = singleRef(state.nodes[cur], TARGET);
    if (!up) break; // dangling operator — treat it as the base
    cur = up.node;
  }
  return cur;
}

/**
 * The base mesh DATA of a geometry-modifier stack from any node in it — the data node,
 * any modifier in the chain, or the OBJECT that poses the result.
 *
 * #415 — the stack moved onto the data lane (`BoxData → Array → Object`), so the base
 * is the DATA node, one hop further up than it used to be. From an Object the walk now
 * starts by stepping THROUGH its `data` input; from a modifier or the data node itself
 * it is the generic `target`-chain walk, unchanged. That extra hop is what makes the
 * Object the thing the user selects while the stack still resolves — the panel is on
 * the Object (it declares the 'modifier' section), the operators are on its data.
 *
 * An Object with no data (an Empty) has no stack, so it is its own base — the caller
 * then enumerates an empty stack, which is the honest answer.
 */
export function resolveStackBase(state: DagState, nodeId: string): string {
  const node = state.nodes[nodeId];
  if (isPoserNode(node)) {
    const data = singleRef(node, DATA);
    if (!data) return nodeId; // an Empty — nothing on the data lane to modify
    return resolveOperatorBase(state, data.node, isModifierNode);
  }
  return resolveOperatorBase(state, nodeId, isModifierNode);
}

/**
 * The OBJECT a geometry-modifier stack feeds, from any node in it — walk FORWARD along
 * `out` past the rest of the chain to the poser that wears the result. Null when the
 * chain is dangling (no consumer yet) or feeds something that is not a poser.
 *
 * This is the exact INVERSE of {@link resolveStackBase}, and #415 is why both exist:
 * pre-flip the modifier sat downstream of the Object, so everything about pose was
 * found by walking DOWN to the base. Post-flip the pose lives downstream instead, so
 * a surface that needs "where does this modified geometry actually sit?" — the gizmo,
 * the read road — has to walk UP. Getting the direction wrong lands on the data node,
 * which has no transform at all, so it fails visibly rather than subtly.
 */
export function resolveStackObject(state: DagState, nodeId: string): string | null {
  let cur = nodeId;
  const seen = new Set<string>([nodeId]);
  for (;;) {
    const consumer = findConsumer(state, cur, OUT);
    if (!consumer) return null; // dangling chain — nothing wears it yet
    if (isModifierNode(state.nodes[consumer.node])) {
      if (seen.has(consumer.node)) return null; // cycle guard
      seen.add(consumer.node);
      cur = consumer.node;
      continue;
    }
    return consumer.socket === DATA && isPoserNode(state.nodes[consumer.node])
      ? consumer.node
      : null;
  }
}

/** The base Image source of an effect stack from any node in it (an effect or the
 *  source itself). Lets the UI add/enumerate the SAME stack from the Layer's source
 *  whether or not effects are already spliced on. */
export function resolveEffectBase(state: DagState, nodeId: string): string {
  return resolveOperatorBase(state, nodeId, isEffectNode);
}

/** The top of the stack (the last producer) + where it feeds. lastProducer is the
 *  base when the stack is empty, else the topmost operator. */
function stackTail(
  state: DagState,
  baseNodeId: string,
  isOp: OperatorPredicate,
): { lastProducer: string; consumer: { node: string; socket: string } | null } {
  const stack = enumerateOperatorStack(state, baseNodeId, isOp);
  const lastProducer = stack.length ? stack[stack.length - 1].nodeId : baseNodeId;
  return { lastProducer, consumer: findConsumer(state, lastProducer, OUT) };
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export interface AddModifierResult {
  readonly ops: Op[];
  readonly modifierId: string;
}

/**
 * Insert a new modifier at the TOP of `baseNodeId`'s stack (closest to the final
 * consumer, so it operates on the cumulative result below it). Re-wire: the
 * current top producer's `out` is detached from its consumer and routed THROUGH
 * the new modifier; the modifier's `out` takes the producer's old place. When the
 * base feeds nothing yet (not in the scene), just wire base.out → newMod.target
 * (the new modifier's out is left for the caller to place). Returns null only when
 * baseNodeId is unknown.
 */
export function buildAddOperatorOps(
  state: DagState,
  baseNodeId: string,
  operatorType: string,
  isOp: OperatorPredicate,
  params: Record<string, unknown> = {},
  explicitId?: string,
  idPrefix = 'op',
): AddModifierResult | null {
  if (!state.nodes[baseNodeId]) return null;
  const { lastProducer, consumer } = stackTail(state, baseNodeId, isOp);
  // The UI lets the registry mint a random id; the agent passes a deterministic
  // one (the closure spec needs the id before build, and the LLM references it).
  const modifierId = explicitId ?? newId(idPrefix);

  const ops: Op[] = [{ type: 'addNode', nodeId: modifierId, nodeType: operatorType, params }];
  if (consumer) {
    // Splice the operator between the current top producer and its consumer.
    ops.push(
      {
        type: 'disconnect',
        from: { node: lastProducer, socket: OUT },
        to: { node: consumer.node, socket: consumer.socket },
      },
      {
        type: 'connect',
        from: { node: lastProducer, socket: OUT },
        to: { node: modifierId, socket: TARGET },
      },
      {
        type: 'connect',
        from: { node: modifierId, socket: OUT },
        to: { node: consumer.node, socket: consumer.socket },
      },
    );
  } else {
    // Base not consumed yet — just feed it into the operator (out left dangling).
    ops.push({
      type: 'connect',
      from: { node: lastProducer, socket: OUT },
      to: { node: modifierId, socket: TARGET },
    });
  }
  return { ops, modifierId };
}

/**
 * Insert a geometry modifier at the top of `baseNodeId`'s stack, where `baseNodeId` is
 * the mesh DATA node (pass `resolveStackBase(state, selectedId)`).
 *
 * #415 — THE FLIP ONTO THE DATA LANE NEEDED NO CHANGE HERE, and that is the design
 * claim paying out rather than a coincidence. {@link buildAddOperatorOps} splices into
 * `topProducer.out → consumer` without naming either side, so moving the stack from
 * `Object.out → mod.target → Scene.children` to `Data.out → mod.target → Object.data`
 * changed only what `resolveStackBase` RESOLVES; the re-wiring authority is identical.
 * One wiring road means the panel, the agent op and the migration cannot disagree —
 * which is precisely what a temporary dual-socket shim would have re-introduced.
 *
 * #498 — AND THAT IS WHY THE REFUSAL GOES HERE rather than in the panel's `onAdd`.
 * A camera Object offered "+ Array" and clicking it SUCCEEDED: an `ArrayModifier` was
 * minted and spliced into `CameraData → ArrayModifier → Object.data`, inert but real and
 * persistable. The predicate that would have refused it was already being computed one
 * layer up and used only to pick a warning banner. Gating the panel alone would have left
 * the agent's `addModifier` op free to mint the same graph, so the check belongs at the
 * one authority both of them go through — the same argument that made this function
 * survive the #415 flip untouched, applied to the accept instead of the wiring.
 *
 * Returns null for a source that cannot be reshaped, which is what every caller already
 * does on a null (the panel skips the dispatch; the agent's precondition reports it).
 * `canModifyGeometry` refuses curve, light and camera data alike — a curve is a REAL gap
 * (#349) rather than a category error, but adding a modifier to one today would still
 * mint an inert node, so the accept is the same and only the affordance differs.
 */
export function buildAddModifierOps(
  state: DagState,
  baseNodeId: string,
  modifierType: string,
  params: Record<string, unknown> = {},
  explicitId?: string,
): AddModifierResult | null {
  if (!canModifyGeometry(state, baseNodeId)) return null;
  return buildAddOperatorOps(
    state,
    baseNodeId,
    modifierType,
    isModifierNode,
    params,
    explicitId,
    'mod',
  );
}

/** Insert a video effect at the top of the Image source's effect stack (closest to
 *  the Layer, so it runs on the cumulative result below it). `baseNodeId` is the
 *  base Image source (the MediaClip) — pass `resolveEffectBase(state, layerSourceId)`. */
export function buildAddEffectOps(
  state: DagState,
  baseNodeId: string,
  effectType: string,
  params: Record<string, unknown> = {},
  explicitId?: string,
): AddModifierResult | null {
  return buildAddOperatorOps(state, baseNodeId, effectType, isEffectNode, params, explicitId, 'fx');
}

/**
 * Remove a modifier from its stack, splicing the chain closed: its upstream
 * producer (feeding `target`) is re-wired directly to its downstream consumer
 * (the node consuming its `out`). Disconnect both edges before `removeNode`
 * (V1 refuse-while-consumed). Returns null when the node isn't a modifier.
 */
export function buildRemoveOperatorOps(
  state: DagState,
  operatorId: string,
  isOp: OperatorPredicate,
): Op[] | null {
  const node = state.nodes[operatorId];
  if (!isOp(node)) return null;
  const upstream = singleRef(node, TARGET); // producer feeding this operator
  const consumer = findConsumer(state, operatorId, OUT); // node consuming this operator

  const ops: Op[] = [];
  if (upstream) {
    ops.push({
      type: 'disconnect',
      from: { node: upstream.node, socket: upstream.socket },
      to: { node: operatorId, socket: TARGET },
    });
  }
  if (consumer) {
    ops.push({
      type: 'disconnect',
      from: { node: operatorId, socket: OUT },
      to: { node: consumer.node, socket: consumer.socket },
    });
  }
  // Splice closed: re-wire the producer directly to the consumer (skip the gap).
  if (upstream && consumer) {
    ops.push({
      type: 'connect',
      from: { node: upstream.node, socket: upstream.socket },
      to: { node: consumer.node, socket: consumer.socket },
    });
  }
  ops.push({ type: 'removeNode', nodeId: operatorId });
  return ops;
}

/** Remove a geometry modifier from its stack, splicing the chain closed. */
export function buildRemoveModifierOps(state: DagState, modifierId: string): Op[] | null {
  return buildRemoveOperatorOps(state, modifierId, isModifierNode);
}

/** Remove a video effect from its stack, splicing the Image chain closed. */
export function buildRemoveEffectOps(state: DagState, effectId: string): Op[] | null {
  return buildRemoveOperatorOps(state, effectId, isEffectNode);
}

/** Toggle an operator's mute (the stack bypass — V58). One keyframeable setParam:
 *  a muted operator passes its source through unchanged at evaluate. */
export function buildToggleOperatorMuteOp(
  state: DagState,
  operatorId: string,
  isOp: OperatorPredicate,
): Op | null {
  const node = state.nodes[operatorId];
  if (!isOp(node)) return null;
  return { type: 'setParam', nodeId: operatorId, paramPath: 'muted', value: !muted(node!) };
}

export function buildToggleModifierMuteOp(state: DagState, modifierId: string): Op | null {
  return buildToggleOperatorMuteOp(state, modifierId, isModifierNode);
}

export function buildToggleEffectMuteOp(state: DagState, effectId: string): Op | null {
  return buildToggleOperatorMuteOp(state, effectId, isEffectNode);
}

/**
 * Move a modifier one slot up (toward the top / consumer) or down (toward the
 * base) by swapping it with its adjacent neighbour — pure re-wiring (reorder =
 * re-wire, §2.2). Returns null when the move isn't possible (not a modifier, or
 * already at the end in that direction). The base mesh is found by walking the
 * `target` chain down to the first non-modifier producer.
 */
export function buildMoveOperatorOps(
  state: DagState,
  modifierId: string,
  dir: 'up' | 'down',
  isOp: OperatorPredicate,
): Op[] | null {
  const node = state.nodes[modifierId];
  if (!isOp(node)) return null;

  // Find the base (walk `target` down past operators) so we can enumerate order.
  let base = modifierId;
  for (;;) {
    const up = singleRef(state.nodes[base], TARGET);
    if (!up || !isOp(state.nodes[up.node])) {
      base = up ? up.node : base;
      break;
    }
    base = up.node;
  }
  const stack = enumerateOperatorStack(state, base, isOp);
  const idx = stack.findIndex((m) => m.nodeId === modifierId);
  if (idx < 0) return null;
  // 'up' = toward the consumer = higher index; 'down' = toward the base = lower.
  const swapIdx = dir === 'up' ? idx + 1 : idx - 1;
  if (swapIdx < 0 || swapIdx >= stack.length) return null;

  // Normalise to (lower, upper) adjacent pair where lower.out → upper.target.
  const lowerId = stack[Math.min(idx, swapIdx)].nodeId;
  const upperId = stack[Math.max(idx, swapIdx)].nodeId;
  const below = singleRef(state.nodes[lowerId], TARGET); // producer feeding `lower`
  const above = findConsumer(state, upperId, OUT); // node consuming `upper`
  if (!below) return null;

  // Before: below → lower.target ; lower.out → upper.target ; upper.out → above
  // After:  below → upper.target ; upper.out → lower.target ; lower.out → above
  const ops: Op[] = [
    {
      type: 'disconnect',
      from: { node: below.node, socket: below.socket },
      to: { node: lowerId, socket: TARGET },
    },
    {
      type: 'disconnect',
      from: { node: lowerId, socket: OUT },
      to: { node: upperId, socket: TARGET },
    },
  ];
  if (above) {
    ops.push({
      type: 'disconnect',
      from: { node: upperId, socket: OUT },
      to: { node: above.node, socket: above.socket },
    });
  }
  ops.push(
    {
      type: 'connect',
      from: { node: below.node, socket: below.socket },
      to: { node: upperId, socket: TARGET },
    },
    {
      type: 'connect',
      from: { node: upperId, socket: OUT },
      to: { node: lowerId, socket: TARGET },
    },
  );
  if (above) {
    ops.push({
      type: 'connect',
      from: { node: lowerId, socket: OUT },
      to: { node: above.node, socket: above.socket },
    });
  }
  return ops;
}

/** Move a geometry modifier one slot up/down its stack. */
export function buildMoveModifierOps(
  state: DagState,
  modifierId: string,
  dir: 'up' | 'down',
): Op[] | null {
  return buildMoveOperatorOps(state, modifierId, dir, isModifierNode);
}

/** Move a video effect one slot up/down its stack. */
export function buildMoveEffectOps(
  state: DagState,
  effectId: string,
  dir: 'up' | 'down',
): Op[] | null {
  return buildMoveOperatorOps(state, effectId, dir, isEffectNode);
}
