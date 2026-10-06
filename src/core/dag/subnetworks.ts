// #1547 — a sub-network has ONE owner.
//
// A sub-network in Basher is not a stored container. It is the dependency closure behind a
// node's BODY sockets (an input declared `body: true`): the Solver's `body`/`bodies` today,
// the Rig node next. The graph stays flat (docs/OBJECT-DATA-SPLIT-DESIGN.md §2.2), so the
// guarantee Houdini gets from containment — a node lives in exactly one network, and the
// only way in is through the network's inputs — has to be a RULE here instead:
//
//   Every wire that leaves a node inside an owner's closure goes to another node inside
//   that closure, or into one of that owner's body sockets.
//
// That one sentence forbids a node shared by two sub-networks (it would feed the other
// owner's body from outside the first closure) and an outside node consuming a node inside
// (an edge leaving the closure). It still allows a node feeding two body sockets of the
// SAME owner — a spring's velocity step feeds both its position step and `bodies[1]` — and
// a sub-network nested inside another, whose whole closure lies inside the outer one.
//
// Only an edge can break the rule, so only the ops that add edges are checked (`connect`,
// and `addNode` with inputs). Removing an edge or a node only shrinks closures. A project
// saved before the rule may already break it; the check refuses only NEW violations, so
// such a project still loads and edits, and `subnetworkViolations` names what it holds.

import type { DagState } from './state';
import { edges } from './state';
import { getNodeType } from './registry';
import type { NodeId } from './types';

export interface SubnetworkViolation {
  /** The node inside the sub-network. */
  readonly inside: NodeId;
  /** The owner whose body sockets the closure sits behind. */
  readonly owner: NodeId;
  /** The node outside the closure that consumes `inside`. */
  readonly outside: NodeId;
  /** The socket on `outside` the wire enters. */
  readonly socket: string;
}

/** The body sockets a node type declares (empty for almost every type). */
function bodySocketsOf(type: string): readonly string[] {
  const def = getNodeType(type);
  if (!def) return [];
  return Object.entries(def.inputs)
    .filter(([, desc]) => desc.body === true)
    .map(([socket]) => socket);
}

/** Every node behind `owner`'s body sockets, walked upstream over wired inputs. */
export function subnetworkOf(state: DagState, owner: NodeId): Set<NodeId> {
  const node = state.nodes[owner];
  const closure = new Set<NodeId>();
  if (!node) return closure;
  const stack: NodeId[] = [];
  for (const socket of bodySocketsOf(node.type)) {
    const binding = node.inputs[socket];
    const refs = Array.isArray(binding) ? binding : binding ? [binding] : [];
    for (const ref of refs) stack.push(ref.node);
  }
  while (stack.length) {
    const id = stack.pop()!;
    if (closure.has(id)) continue;
    closure.add(id);
    const inner = state.nodes[id];
    if (!inner) continue;
    for (const binding of Object.values(inner.inputs)) {
      const refs = Array.isArray(binding) ? binding : binding ? [binding] : [];
      for (const ref of refs) if (!closure.has(ref.node)) stack.push(ref.node);
    }
  }
  return closure;
}

/** Every wire that leaves a sub-network other than into its owner's body sockets. */
export function subnetworkViolations(state: DagState): SubnetworkViolation[] {
  const owners: { id: NodeId; bodies: ReadonlySet<string> }[] = [];
  for (const node of Object.values(state.nodes)) {
    const sockets = bodySocketsOf(node.type);
    if (sockets.length > 0) owners.push({ id: node.id, bodies: new Set(sockets) });
  }
  if (owners.length === 0) return [];

  const consumers = new Map<NodeId, { consumer: NodeId; socket: string }[]>();
  for (const e of edges(state)) {
    const list = consumers.get(e.producer.node);
    if (list) list.push({ consumer: e.consumer, socket: e.socket });
    else consumers.set(e.producer.node, [{ consumer: e.consumer, socket: e.socket }]);
  }

  const out: SubnetworkViolation[] = [];
  for (const owner of owners) {
    const closure = subnetworkOf(state, owner.id);
    for (const inside of closure) {
      for (const { consumer, socket } of consumers.get(inside) ?? []) {
        if (closure.has(consumer)) continue;
        if (consumer === owner.id && owner.bodies.has(socket)) continue;
        out.push({ inside, owner: owner.id, outside: consumer, socket });
      }
    }
  }
  return out;
}

const keyOf = (v: SubnetworkViolation) =>
  `${v.owner}\u0000${v.inside}\u0000${v.outside}\u0000${v.socket}`;

/**
 * The first violation `after` holds that `before` did not, or null. The reason a write is
 * refused: it names the node, the sub-network it belongs to, and the outside consumer.
 */
export function newSubnetworkViolation(before: DagState, after: DagState): string | null {
  const now = subnetworkViolations(after);
  if (now.length === 0) return null;
  const had = new Set(subnetworkViolations(before).map(keyOf));
  const fresh = now.find((v) => !had.has(keyOf(v)));
  if (!fresh) return null;
  const ownerType = after.nodes[fresh.owner]?.type ?? 'node';
  return (
    `"${fresh.inside}" is inside the sub-network of ${ownerType} "${fresh.owner}", so it can't ` +
    `also feed "${fresh.outside}" (${fresh.socket}), which is outside it. A node belongs to one ` +
    'sub-network: duplicate it for the other use.'
  );
}

// ── #1548 — the sub-network's named inputs ──────────────────────────────────────
//
// An owner declares named inputs (`bodyInputs`); inside its sub-network a body-input leaf
// (`bodyInputLeaf: true` — `BodyInput`, `BodyInputVec`) reads one by name. Cooking the
// sub-network binds a value to each name: these two functions turn that binding into the
// evaluator's `overrides`, so no owner has to know which leaf types exist.

/** One body-input leaf of a sub-network: the input it reads and the element of it. */
export interface BodyInputLeaf {
  readonly id: NodeId;
  readonly input: string;
  readonly slot: number;
}

/**
 * The body-input leaves that read `owner`'s inputs: every leaf in its sub-network that is not
 * inside a NESTED owner's sub-network (those read the nested owner's inputs). A leaf whose
 * name the owner doesn't declare, or declares with a different type than the leaf outputs,
 * is left out: it reads its default.
 */
export function bodyInputLeavesOf(state: DagState, owner: NodeId): BodyInputLeaf[] {
  const ownerNode = state.nodes[owner];
  const declared = ownerNode ? getNodeType(ownerNode.type)?.bodyInputs : undefined;
  if (!declared) return [];
  const closure = subnetworkOf(state, owner);
  const nested = new Set<NodeId>();
  for (const id of closure) {
    const inner = state.nodes[id];
    if (inner && bodySocketsOf(inner.type).length > 0)
      for (const n of subnetworkOf(state, id)) nested.add(n);
  }
  const out: BodyInputLeaf[] = [];
  for (const id of closure) {
    if (nested.has(id)) continue;
    const node = state.nodes[id];
    const def = node ? getNodeType(node.type) : undefined;
    if (!node || !def?.bodyInputLeaf) continue;
    const params = node.params as { input?: unknown; slot?: unknown };
    if (typeof params.input !== 'string') continue;
    const want = declared[params.input];
    const outType = Object.values(def.outputs)[0]?.type;
    if (!want || want.type !== outType) continue;
    const slot = typeof params.slot === 'number' ? params.slot : 0;
    out.push({ id, input: params.input, slot });
  }
  return out;
}

/**
 * The evaluator `overrides` that bind `values` (input name → value) to `leaves`. A `list`
 * input binds element `slot`; a slot past its end, or a name with no value, stays unbound
 * and the leaf reads its default.
 */
export function bindBodyInputs(
  state: DagState,
  owner: NodeId,
  leaves: readonly BodyInputLeaf[],
  values: Readonly<Record<string, unknown>>,
): Map<NodeId, unknown> {
  const ownerNode = state.nodes[owner];
  const declared = (ownerNode && getNodeType(ownerNode.type)?.bodyInputs) || {};
  const overrides = new Map<NodeId, unknown>();
  for (const leaf of leaves) {
    if (!Object.prototype.hasOwnProperty.call(values, leaf.input)) continue;
    const value = values[leaf.input];
    if (declared[leaf.input]?.cardinality === 'list') {
      if (!Array.isArray(value) || leaf.slot >= value.length) continue;
      overrides.set(leaf.id, value[leaf.slot]);
    } else {
      overrides.set(leaf.id, value);
    }
  }
  return overrides;
}
