// operatorChain — the pure `target`-chain walk shared by every surface that has to
// ask "what is actually at the bottom of this operator stack?".
//
// EXTRACTED from `operatorStack.ts` (#516) because a second surface needed the walk
// and could not import it. `operatorStack` pulls in `sceneTreeWalk` (for labels) and
// `modifierGeometry` (for the offer predicate), and `sceneTreeWalk → activeCamera →
// resolveDataParamOwner` — so `resolveDataParamOwner` importing `operatorStack` closes
// a cycle. That constraint is stated at `resolveWorldTransform.ts:55` and relied on by
// `cameraNode.ts`; this module is the way to honour it WITHOUT minting a second walk,
// which is the drift the one-classifier rule exists to stop.
//
// LEAF BY CONSTRUCTION: it imports `core/dag` only. Nothing in `src/app` may be added
// to its imports — that is the entire property it is here to have.
//
// REF: src/app/operatorStack.ts (the wiring authority, which re-exports these);
//      src/app/resolveDataParamOwner.ts (the reach that needed it); issue #516.

import type { DagState } from '../core/dag/state';
import type { Node, NodeRef, NodeTypeId, SocketId } from '../core/dag/types';
import { getNodeType } from '../core/dag/registry';

const OUT = 'out';
const DATA = 'data';

/**
 * The socket carrying `type`'s CHAIN — the spine a stack walks down — or null if this
 * node type is not a chain node at all. Read from the node's own declaration
 * (`NodeDefinition.chainInput`, #396); never guessed from a socket name.
 *
 * THE LITERAL IT REPLACES was `const TARGET = 'target'`, and it was right for as long
 * as an operator had exactly one input. It stops being right the moment one has a
 * second input of the SAME type — a boolean's cutter, a deform's capture pose — because
 * then "the socket called `target`" and "the socket the stack descends" are two claims
 * that can disagree while everything still registers, connects and evaluates. Reading
 * the declaration is what makes the walk answer the second question.
 */
export function chainSocketOfType(type: NodeTypeId): SocketId | null {
  return getNodeType(type)?.chainInput ?? null;
}

/** {@link chainSocketOfType} for a node instance. */
export function chainSocketOf(node: Node | undefined): SocketId | null {
  return node ? chainSocketOfType(node.type) : null;
}

/** The geometry-operator (SOP / modifier) node types the modifier stack manages. A node
 *  is a modifier iff its type is registered here — new modifiers (Mirror, Subdiv…)
 *  register by adding their type, nothing else. They all share the Mesh `target`
 *  input / Mesh `out` output shape, which is what makes the sub-chain uniform. */
export const MODIFIER_NODE_TYPES: ReadonlySet<string> = new Set([
  'ArrayModifier',
  'MirrorModifier',
]);

/** The MATERIAL-operator node types — the material half of the data lane (#394 S3c).
 *
 *  A TUPLE, not a `Set`, and that is load-bearing: `MaterialLaneType` is derived from it,
 *  so the per-field ownership switch in `resolveMaterialFieldOwner` closes on a `never`
 *  ([[V109]]). Adding a member here without teaching that switch what the new operator
 *  MASKS is a compile error — which is the only structural defence against the exact
 *  silent failure the lane re-mints: an operator that forces a field while a write road
 *  still aims at the layer below it, reporting success and changing nothing.
 *
 *  SEPARATE from {@link MODIFIER_NODE_TYPES} on purpose: that set drives what the MODIFIER
 *  section offers, and a material operator reshapes no geometry. Both are walked past by
 *  {@link isDataLaneOperator}, which asks about SHAPE and needs neither list. */
export const MATERIAL_LANE_TYPES = ['SetMaterialOp', 'MaterialOverrideOp'] as const;
export type MaterialLaneType = (typeof MATERIAL_LANE_TYPES)[number];

export function isMaterialLaneOperator(node: Node | undefined): node is Node & {
  type: MaterialLaneType;
} {
  return !!node && (MATERIAL_LANE_TYPES as readonly string[]).includes(node.type);
}

/** The video-effect (Image→Image) node types — the lift to the Image socket
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

/**
 * Is `node` ANY data-lane operator — a node that takes `ObjectData` and hands back
 * `ObjectData`, so it can stand between a data node and the Object that wears it?
 *
 * DERIVED FROM THE REGISTRY, never from a type list, and that is the whole point of
 * having it alongside {@link isModifierNode}. The two answer different questions: a
 * GEOMETRY modifier is a curated set (it drives what the modifier section offers);
 * "is something standing between me and the base data?" is a question about SHAPE,
 * and any node with that shape must be walked past whether or not it reshapes
 * geometry. A material operator is exactly such a node. Using the curated set for the
 * shape question is how a new operator silently stops the reach one hop short — the
 * same drift #377 measured when a supported-source list named a retired type and
 * missed a live one at once.
 */
export function isDataLaneOperator(node: Node | undefined): boolean {
  if (!node) return false;
  const def = getNodeType(node.type);
  if (!def) return false;
  // #396 — ask the node which socket is its SPINE instead of assuming `target`. The
  // question is still about SHAPE ("does `ObjectData` flow through this node?"), but it
  // is now asked of the input the node itself nominates. An operator with a second
  // `ObjectData` argument (a cutter) answers the same as a unary one, and correctly:
  // it IS on the lane. What changes is that the walk below then descends the right edge.
  const spine = def.chainInput;
  if (!spine) return false;
  return def.inputs[spine]?.type === 'ObjectData' && def.outputs[OUT]?.type === 'ObjectData';
}

/**
 * Is `node` a POSER — an object that wears data through a `data` input? Derived from
 * the registry (it declares a `data` input carrying the `ObjectData` socket), never
 * matched against `type === 'Object'`: a type list is exactly the drift #377 measured
 * when the modifier's supported-source set named a retired type AND missed a live one
 * at the same time. A future poser is covered the day it declares the socket.
 */
export function isPoserNode(node: Node | undefined): boolean {
  if (!node) return false;
  return getNodeType(node.type)?.inputs[DATA]?.type === 'ObjectData';
}

/** The single ref a (possibly list) input binding holds for `socket`, or null. */
export function singleRef(node: Node | undefined, socket: string): NodeRef | null {
  const b = node?.inputs[socket];
  if (!b) return null;
  return Array.isArray(b) ? (b[0] ?? null) : b;
}

/**
 * The BASE of a stack from any node in it: if `nodeId` is an operator, walk down its
 * `target` chain past operators to the first non-operator producer; if it is already
 * a producer, return it unchanged. Lets a surface find the same base whether the user
 * selected the base or one of the operators sitting on it.
 *
 * ONE walk, N policies — the predicate is the only thing that varies between the
 * modifier stack, the effect stack and the ownership reach. Copying the loop per
 * policy is what this signature exists to prevent.
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
    // Each hop descends THAT node's declared spine, not a shared literal — so a chain
    // of operators that name their spines differently still walks, and an operator's
    // non-spine arguments are stepped past rather than mistaken for the chain.
    const spine = chainSocketOf(state.nodes[cur]);
    if (!spine) break;
    const up = singleRef(state.nodes[cur], spine);
    if (!up) break; // dangling operator — treat it as the base
    cur = up.node;
  }
  return cur;
}

/**
 * The base DATA node below `nodeId`, walking past EVERY data-lane operator: step
 * through a poser's `data` input first, then down the `target` chain.
 *
 * This is {@link resolveStackBase}'s question asked with the shape predicate instead
 * of the curated modifier set, so it does not stop one hop short at an operator that
 * happens not to be a geometry modifier. `resolveDataParamOwner` is the caller that
 * needs it: since the stack moved onto the data lane, an Object's `data` input names
 * the TOP of the stack, so a single hop lands on an operator and reports that the
 * object owns no material and no size (#516, measured).
 *
 * A poser with no data (an Empty) has no chain, so it is its own base — the honest
 * answer, and the caller then finds no data param, which is correct.
 */
export function resolveDataLaneBase(state: DagState, nodeId: string): string {
  const node = state.nodes[nodeId];
  if (isPoserNode(node)) {
    const data = singleRef(node, DATA);
    if (!data) return nodeId;
    return resolveOperatorBase(state, data.node, isDataLaneOperator);
  }
  return resolveOperatorBase(state, nodeId, isDataLaneOperator);
}
