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
import { nodeDisplayName } from './sceneTreeWalk';

/** The geometry-operator (SOP / modifier) node types this stack manages. A node
 *  is a modifier iff its type is registered here — new modifiers (Mirror, Subdiv…)
 *  register by adding their type, nothing else. They all share the Mesh `target`
 *  input / Mesh `out` output shape, which is what makes the sub-chain uniform. */
export const MODIFIER_NODE_TYPES: ReadonlySet<string> = new Set(['ArrayModifier', 'MirrorModifier']);

export function isModifierNode(node: Node | undefined): boolean {
  return !!node && MODIFIER_NODE_TYPES.has(node.type);
}

/** One entry in a mesh's modifier stack, bottom (closest to the base) → top. */
export interface ModifierEntry {
  readonly nodeId: string;
  readonly type: string;
  readonly muted: boolean;
  readonly label: string;
}

const OUT = 'out';
const TARGET = 'target';

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
export function enumerateModifierStack(state: DagState, baseNodeId: string): ModifierEntry[] {
  const out: ModifierEntry[] = [];
  const seen = new Set<string>([baseNodeId]); // cycle guard (a DAG shouldn't, but be safe)
  let producer = baseNodeId;
  for (;;) {
    const consumer = findConsumer(state, producer, OUT);
    if (!consumer) break;
    const node = state.nodes[consumer.node];
    if (!isModifierNode(node) || consumer.socket !== TARGET || seen.has(consumer.node)) break;
    seen.add(consumer.node);
    out.push({ nodeId: node!.id, type: node!.type, muted: muted(node!), label: nodeDisplayName(node!) });
    producer = consumer.node;
  }
  return out;
}

/**
 * The BASE mesh of a stack from any node in it: if `nodeId` is a modifier, walk
 * down its `target` chain past modifiers to the first non-modifier producer (the
 * mesh); if it is already a mesh-producer, return it unchanged. Lets the inspector
 * show the SAME stack whether the user selected the base mesh or one of its
 * modifiers (the rendered arrayed mesh click-selects the top modifier).
 */
export function resolveStackBase(state: DagState, nodeId: string): string {
  let cur = nodeId;
  const seen = new Set<string>();
  while (isModifierNode(state.nodes[cur]) && !seen.has(cur)) {
    seen.add(cur);
    const up = singleRef(state.nodes[cur], TARGET);
    if (!up) break; // dangling modifier — treat it as the base
    cur = up.node;
  }
  return cur;
}

/** The top of the stack (the last producer) + where it feeds. lastProducer is the
 *  base when the stack is empty, else the topmost modifier. */
function stackTail(
  state: DagState,
  baseNodeId: string,
): { lastProducer: string; consumer: { node: string; socket: string } | null } {
  const stack = enumerateModifierStack(state, baseNodeId);
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
export function buildAddModifierOps(
  state: DagState,
  baseNodeId: string,
  modifierType: string,
  params: Record<string, unknown> = {},
  explicitId?: string,
): AddModifierResult | null {
  if (!state.nodes[baseNodeId]) return null;
  const { lastProducer, consumer } = stackTail(state, baseNodeId);
  // The UI lets the registry mint a random id; the agent passes a deterministic
  // one (the closure spec needs the id before build, and the LLM references it).
  const modifierId = explicitId ?? newId('mod');

  const ops: Op[] = [{ type: 'addNode', nodeId: modifierId, nodeType: modifierType, params }];
  if (consumer) {
    // Splice the modifier between the current top producer and its consumer.
    ops.push(
      { type: 'disconnect', from: { node: lastProducer, socket: OUT }, to: { node: consumer.node, socket: consumer.socket } },
      { type: 'connect', from: { node: lastProducer, socket: OUT }, to: { node: modifierId, socket: TARGET } },
      { type: 'connect', from: { node: modifierId, socket: OUT }, to: { node: consumer.node, socket: consumer.socket } },
    );
  } else {
    // Base not consumed yet — just feed it into the modifier (out left dangling).
    ops.push({ type: 'connect', from: { node: lastProducer, socket: OUT }, to: { node: modifierId, socket: TARGET } });
  }
  return { ops, modifierId };
}

/**
 * Remove a modifier from its stack, splicing the chain closed: its upstream
 * producer (feeding `target`) is re-wired directly to its downstream consumer
 * (the node consuming its `out`). Disconnect both edges before `removeNode`
 * (V1 refuse-while-consumed). Returns null when the node isn't a modifier.
 */
export function buildRemoveModifierOps(state: DagState, modifierId: string): Op[] | null {
  const node = state.nodes[modifierId];
  if (!isModifierNode(node)) return null;
  const upstream = singleRef(node, TARGET); // producer feeding this modifier
  const consumer = findConsumer(state, modifierId, OUT); // node consuming this modifier

  const ops: Op[] = [];
  if (upstream) {
    ops.push({ type: 'disconnect', from: { node: upstream.node, socket: upstream.socket }, to: { node: modifierId, socket: TARGET } });
  }
  if (consumer) {
    ops.push({ type: 'disconnect', from: { node: modifierId, socket: OUT }, to: { node: consumer.node, socket: consumer.socket } });
  }
  // Splice closed: re-wire the producer directly to the consumer (skip the gap).
  if (upstream && consumer) {
    ops.push({ type: 'connect', from: { node: upstream.node, socket: upstream.socket }, to: { node: consumer.node, socket: consumer.socket } });
  }
  ops.push({ type: 'removeNode', nodeId: modifierId });
  return ops;
}

/** Toggle a modifier's mute (the stack bypass — V58). One keyframeable setParam:
 *  a muted modifier passes its source through unchanged at evaluate. */
export function buildToggleModifierMuteOp(state: DagState, modifierId: string): Op | null {
  const node = state.nodes[modifierId];
  if (!isModifierNode(node)) return null;
  return { type: 'setParam', nodeId: modifierId, paramPath: 'muted', value: !muted(node!) };
}

/**
 * Move a modifier one slot up (toward the top / consumer) or down (toward the
 * base) by swapping it with its adjacent neighbour — pure re-wiring (reorder =
 * re-wire, §2.2). Returns null when the move isn't possible (not a modifier, or
 * already at the end in that direction). The base mesh is found by walking the
 * `target` chain down to the first non-modifier producer.
 */
export function buildMoveModifierOps(
  state: DagState,
  modifierId: string,
  dir: 'up' | 'down',
): Op[] | null {
  const node = state.nodes[modifierId];
  if (!isModifierNode(node)) return null;

  // Find the base (walk `target` down past modifiers) so we can enumerate order.
  let base = modifierId;
  for (;;) {
    const up = singleRef(state.nodes[base], TARGET);
    if (!up || !isModifierNode(state.nodes[up.node])) {
      base = up ? up.node : base;
      break;
    }
    base = up.node;
  }
  const stack = enumerateModifierStack(state, base);
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
    { type: 'disconnect', from: { node: below.node, socket: below.socket }, to: { node: lowerId, socket: TARGET } },
    { type: 'disconnect', from: { node: lowerId, socket: OUT }, to: { node: upperId, socket: TARGET } },
  ];
  if (above) {
    ops.push({ type: 'disconnect', from: { node: upperId, socket: OUT }, to: { node: above.node, socket: above.socket } });
  }
  ops.push(
    { type: 'connect', from: { node: below.node, socket: below.socket }, to: { node: upperId, socket: TARGET } },
    { type: 'connect', from: { node: upperId, socket: OUT }, to: { node: lowerId, socket: TARGET } },
  );
  if (above) {
    ops.push({ type: 'connect', from: { node: lowerId, socket: OUT }, to: { node: above.node, socket: above.socket } });
  }
  return ops;
}
