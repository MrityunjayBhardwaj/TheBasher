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
import type {
  Node,
  NodeRef,
  NodeTypeId,
  OperatorSection,
  SocketId,
  SocketTypeName,
} from '../core/dag/types';
import { getNodeType, listNodeTypes } from '../core/dag/registry';
import { inputAccepts } from '../core/dag/types';
import { operatorLaneOf } from '../core/dag/operatorLane';

const DATA = 'data';

/**
 * The socket carrying `type`'s CHAIN — the spine a stack walks down — or null if this
 * node type is not a chain node at all. Read from the node's own declaration
 * (`NodeDefinition.chain.input`, #396 / ns-2); never guessed from a socket name.
 *
 * THE LITERAL IT REPLACES was `const TARGET = 'target'`, and it was right for as long
 * as an operator had exactly one input. It stops being right the moment one has a
 * second input of the SAME type — a boolean's cutter, a deform's capture pose — because
 * then "the socket called `target`" and "the socket the stack descends" are two claims
 * that can disagree while everything still registers, connects and evaluates. Reading
 * the declaration is what makes the walk answer the second question.
 */
export function chainSocketOfType(type: NodeTypeId): SocketId | null {
  return getNodeType(type)?.chain?.input ?? null;
}

/** {@link chainSocketOfType} for a node instance. */
export function chainSocketOf(node: Node | undefined): SocketId | null {
  return node ? chainSocketOfType(node.type) : null;
}

/**
 * The LANE `node` stands on — the socket type flowing through its chain — or null if it is
 * not an operator. The registry lookup, and `operatorLaneOf` does the deriving (ns-2 step 6).
 *
 * THIS IS THE ONLY PLACE IN `src/app` THAT ANSWERS THE LANE QUESTION. Every predicate below
 * is one comparison against it, which is what makes them a family rather than four sets of
 * conditions that happen to agree. Before this, two of them re-derived the lane inline from
 * `chain.input` and `outputs.out.type`, and the comment on the second one apologised for
 * being byte-identical to the first — so the shape was already known and only the third
 * copy was missing.
 */
export function operatorLane(node: Node | undefined): SocketTypeName | null {
  return node ? operatorLaneOf(getNodeType(node.type)) : null;
}

/**
 * The registered operator types whose declaration says `section` — DERIVED, never listed
 * (ns-2 step 7). This is what `MODIFIER_NODE_TYPES` and `EFFECT_NODE_TYPES` used to be, and
 * what both "+ Add" menus used to spell a second and third time.
 *
 * 🔴 LAZY, AND THE THROW IS THE POINT (M5). `registerAllNodes()` is a FUNCTION called at
 * boot, so anything that read the registry at module scope would see it EMPTY and freeze an
 * empty answer — a menu offering nothing and an agent vocabulary naming nothing, both
 * silent, both indistinguishable from "this section genuinely has no members". So the
 * derivation runs per call, and an empty REGISTRY (not an empty section) throws by name.
 * That is the difference between a wrong answer and a refusal to answer.
 *
 * Returned sorted, so the set has one spelling. Menu ORDER is a presentation concern and
 * belongs to the panel, not here — see `ModifierStackControls`.
 */
export function operatorTypesInSection(section: OperatorSection): string[] {
  const all = listNodeTypes();
  if (all.length === 0) {
    throw new Error(
      `operatorTypesInSection('${section}') was called with an EMPTY registry. ` +
        `registerAllNodes() is called at boot, so this is a module-scope read that ran ` +
        `first — it would have returned [] and silently emptied a menu or an agent ` +
        `vocabulary. Derive lazily, at call time.`,
    );
  }
  return all.filter((type) => getNodeType(type)?.chain?.section === section).sort();
}

/** The MATERIAL-operator node types — the material half of the data lane (#394 S3c).
 *
 *  A TUPLE, not a `Set`, and that is load-bearing: `MaterialLaneType` is derived from it,
 *  so the per-field ownership switch in `resolveMaterialFieldOwner` closes on a `never`
 *  ([[V109]]). Adding a member here without teaching that switch what the new operator
 *  MASKS is a compile error — which is the only structural defence against the exact
 *  silent failure the lane re-mints: an operator that forces a field while a write road
 *  still aims at the layer below it, reporting success and changing nothing.
 *
 *  🔴 THE ONE MEMBERSHIP LIST THAT SURVIVES ns-2 step 7, and only because deleting it would
 *  delete a COMPILE error. Its three siblings (`MODIFIER_NODE_TYPES`, `EFFECT_NODE_TYPES`
 *  and both "+ Add" menus) are gone, derived from `chain.section`. This one cannot be: the
 *  derivation yields `string`, `MaterialLaneType` collapses with it, and the ownership
 *  switch's `never` — the only thing that stops a new material operator shipping with a
 *  write road still aimed at the layer below it — stops closing. A runtime derivation
 *  cannot buy back a compile-time exhaustiveness check.
 *  ⇒ it is KEPT, and pinned instead: `operatorMembership.gate.test.ts` asserts this tuple
 *  set-equals the registry-derived `'material'` set EXACTLY, with a minted liar proving the
 *  cross-check can fail. A list that cannot be derived gets a gate; it does not get trust.
 *
 *  SEPARATE from the modifier section on purpose: that section drives what the MODIFIER
 *  stack offers, and a material operator reshapes no geometry. Both are walked past by
 *  {@link isDataLaneOperator}, which asks about SHAPE and needs no list at all. */
export const MATERIAL_LANE_TYPES = ['SetMaterialOp', 'MaterialOverrideOp'] as const;
export type MaterialLaneType = (typeof MATERIAL_LANE_TYPES)[number];

/**
 * The lane factor is asked FIRST and the list only narrows within it — the tuple's own
 * comment above calls these "the material half of the data lane", and this is that sentence
 * made checkable rather than left as prose. The conjunct cannot create a false positive (a
 * narrowing never widens); what it buys is that a member which stops standing on
 * `ObjectData` stops being a material operator, instead of staying one by virtue of its
 * name still appearing in a literal.
 */
export function isMaterialLaneOperator(node: Node | undefined): node is Node & {
  type: MaterialLaneType;
} {
  if (!node || operatorLane(node) !== 'ObjectData') return false;
  return (MATERIAL_LANE_TYPES as readonly string[]).includes(node.type);
}

/** Predicate over the set of node types an OperatorStack instance manages. */
export type OperatorPredicate = (node: Node | undefined) => boolean;

/**
 * Is `node` a geometry modifier — a member of the MODIFIER stack?
 *
 * DERIVED FROM THE DECLARATION (ns-2 step 7). This was `MODIFIER_NODE_TYPES`, a
 * `ReadonlySet` that nothing derived and nothing checked, spelled a second time as the
 * panel's "+ Add" menu and a third time as the agent's enum. A modifier missing from it was
 * not a modifier as far as the stack walker was concerned, and nothing anywhere said so.
 *
 * WHY `chain.section` AND NOT `inspectorSections` — the candidate that separates the sets
 * today and is still wrong. `chain !== undefined` × `inspectorSections ∋ 'modifier'` returns
 * exactly the two modifiers with zero exemptions (measured, including `Object`, which
 * declares `'modifier'` and no chain and is excluded by the chain factor). It fails the
 * second test: forgetting `inspectorSections` on a new geometry modifier drops it out of the
 * modifier set SILENTLY, which is the identical asymmetry this step exists to end. It also
 * gives one declaration two meanings — *where does this param render* and *is this a
 * geometry modifier* — and correspondence has to be declared, never inferred from a field
 * that means something else. A derivation whose omission is silent has not retired a silent
 * site; it has moved one.
 */
export function isModifierNode(node: Node | undefined): boolean {
  return sectionOf(node) === 'modifier';
}

/**
 * Is `node` a video effect — a member of the EFFECT stack (epic #235 / spine 1e+)?
 *
 * DERIVED, for the same reason, from the same field. The set this replaces was
 * `EFFECT_NODE_TYPES`, whose own comment defined an effect as *"a typed `target: Image` /
 * `out: Image` operator on the same sub-chain engine as a geometry modifier"* — a claim
 * about the LANE that nothing checked. It is checked now, but as a **registration refusal**
 * rather than as a conjunct here: `assertChainDeclaration` refuses `section: 'effect'` on an
 * operator that does not stand on the Image lane. That placement is the whole difference.
 * A conjunct would make a mis-declared operator quietly fall out of its own stack; the
 * refusal makes it impossible to register, at the one moment the author is present.
 */
export function isEffectNode(node: Node | undefined): boolean {
  return sectionOf(node) === 'effect';
}

/** The stack section `node`'s type declares, or null if it declares no chain at all. */
function sectionOf(node: Node | undefined): OperatorSection | null {
  return (node && getNodeType(node.type)?.chain?.section) ?? null;
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
  return operatorLane(node) === 'ObjectData';
}

/**
 * Is `node` a SCENE-lane wrapper — `SceneObject` in on its spine, `SceneObject` out?
 * Transform and MaterialOverride today.
 *
 * ONE SOCKET TYPE APART FROM {@link isDataLaneOperator}, AND THAT IS NOW ALL IT IS. The
 * scene tree used to answer this with `node.type === 'Transform' || node.type ===
 * 'MaterialOverride'` — a hardcoded type list — and the fix for that was a second copy of
 * the derivation, which this comment used to describe as "byte-identical in shape, one
 * socket type up". Two copies of a derivation are a list waiting to happen by another
 * route: they drift the moment one of them learns something the other does not, and
 * nothing anywhere compares them. A future scene-lane wrapper is covered the day it
 * declares its spine, and now so is a future lane nobody has thought of.
 */
export function isSceneLaneWrapper(node: Node | undefined): boolean {
  return operatorLane(node) === 'SceneObject';
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
  return inputAccepts(getNodeType(node.type)?.inputs[DATA], 'ObjectData');
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
