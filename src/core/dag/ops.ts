// Op dispatcher — the ONLY mutation path on the DAG (V1, THESIS.md §50).
//
// Each op:
//   1. validates against current state (zod-checked at the entry, semantic
//      checks here).
//   2. computes its inverse from pre-state, so undo replays exact prior values.
//   3. applies the forward op atomically — partial mid-op state is never
//      observable.
//
// `applyOp` is pure: (state, op) → { next, inverse }. The store consumes this.
//
// REF: THESIS.md §9 (five primitives), §50, App. B; krama K2 (op dispatch
// lifecycle).

import { followableName, ownName } from './nodeName';
import { passRoleOf } from './passRole';
import { requireNodeType } from './registry';
import type { DagState } from './state';
import { getNode, hasNode, wouldCreateCycle } from './state';
import {
  carrySubnetworkOwners,
  newStatefulLeafRead,
  newSubnetworkViolation,
  reachesSubnetwork,
} from './subnetworks';
import type {
  InputBinding,
  InputDescriptor,
  Node,
  NodeId,
  NodeRef,
  Op,
  OutputDescriptor,
} from './types';
import { acceptedTypes, OpSchema, SpareParamSchema } from './types';
import { inputTakes, whyNotTaken } from './socketConversion';

/**
 * #1586 — the graph declining an edit: an operation it will not apply (`OpError`), or a batch
 * that would leave a reference pointing at a removed node. Its message is written for the
 * person who made the edit, so the app can show it; any other error from a dispatch (a
 * malformed operation) is a bug in the caller and is not one of these.
 */
export class GraphRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphRefusal';
  }
}

export class OpError extends GraphRefusal {
  constructor(
    message: string,
    readonly op: Op,
  ) {
    super(message);
    this.name = 'OpError';
  }
}

export function validateOp(op: unknown): Op {
  const parsed = OpSchema.safeParse(op);
  if (!parsed.success) {
    throw new Error(`Invalid op: ${parsed.error.message}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Path access helpers (dot-paths only in v0.5; brackets land with array params)
// ---------------------------------------------------------------------------

function splitPath(path: string): string[] {
  if (path === '') return [];
  return path.split('.');
}

function getAtPath(obj: unknown, path: string): unknown {
  const parts = splitPath(path);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function setAtPath(obj: unknown, path: string, value: unknown): unknown {
  const parts = splitPath(path);
  if (parts.length === 0) return value;
  // Clone-on-write down the path so we don't mutate the prior state object.
  const root: Record<string, unknown> =
    obj && typeof obj === 'object' ? { ...(obj as Record<string, unknown>) } : {};
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const existing = cur[key];
    const cloned: Record<string, unknown> =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {};
    cur[key] = cloned;
    cur = cloned;
  }
  cur[parts[parts.length - 1]] = value;
  return root;
}

// Root key of a param path, matching splitPath's dot-only resolution:
// 'material.base.color' → 'material', 'position' → 'position'. Used by
// applySetParam to detect a wrong-half write (#423).
function paramRootKey(path: string): string {
  const dot = path.indexOf('.');
  return dot === -1 ? path : path.slice(0, dot);
}

// ---------------------------------------------------------------------------
// Op apply
// ---------------------------------------------------------------------------

export interface ApplyResult {
  next: DagState;
  inverse: Op;
  /**
   * A surfaced no-op signal (#423). Set when an op was ACCEPTED (it applied and
   * has an inverse) but changed nothing because its target did not own the
   * written param — a non-strict schema stripped the key, so `safeParse`
   * succeeded and the write silently no-op'd. Accepted, not rejected
   * (REPORTABLE policy): the diff surface renders it so the user sees the
   * op-vs-subject mismatch before committing. Absent when the op did real work.
   */
  reportable?: Reportable;
}

/**
 * A surfaced no-op. `badge` is a kind id in the centralised badge registry
 * (`src/app/badges.ts`); core emits the opaque id and the app layer renders it
 * (label/tone/filtering live there — core stays UI-free).
 */
export interface Reportable {
  badge: string;
  nodeId: string;
  paramPath: string;
  reason: string;
  /** #1189 — the node that DOES own this param, when the write aimed at the wrong half
   *  of a split object. Never filled here: the core cannot see the data-lane walk. It is
   *  filled by the app-layer reader that renders the refusal (`createFork`), through the
   *  one ownership rule, `resolveDataParamOwner`. Absent when nothing owns it. */
  owner?: string;
}

export function applyOp(state: DagState, op: Op): ApplyResult {
  return applyWith(state, op, undefined);
}

// ── #1585 — a batch is applied on ONE copy of the graph ─────────────────────────
//
// An operation makes the next graph by copying the `nodes` record and changing one entry. One
// edit paying for that copy is fine. An import paying it per operation is not: 13,751
// operations into a graph growing to 5,019 nodes spent 6.4 s of 7.6 s copying (measured), and
// another 1.0 s reading every node after each rename to find the nodes that follow a name.
//
// `applyOps` copies the record once, on the first operation that writes, and every later one
// writes into that copy. Nothing outside can see the copy until `applyOps` returns it, and the
// graph it was given is never written, so a batch that throws half way leaves nothing behind.
// Each operation runs the same code and the same checks as `applyOp`; the only difference is
// where a write lands (`putNode`).

interface Draft {
  /** The batch's own copy of the record, made at its first write. */
  nodes: Record<NodeId, Node> | null;
  /** What each node this OPERATION wrote was before it (undefined: it was not there). Cleared
   *  per operation: it is how the graph before the operation is still known after the write. */
  readonly touched: Map<NodeId, Node | undefined>;
  /** Which nodes follow each node's name (`meta.nameFrom`), built the first time a name
   *  changes and kept true by every write after it. */
  followers: Map<NodeId, Set<NodeId>> | null;
  /** How many wires leave each node, built the first time a node is removed and kept true by
   *  every write after it: undoing an import removes thousands of nodes, and asking each
   *  time whether anything still consumes one meant reading every node's inputs. */
  consumed: Map<NodeId, number> | null;
}

export interface AppliedOp {
  /** The operation as validated: what an undo entry records as its forward. */
  readonly forward: Op;
  readonly inverse: Op;
  /** Whether the operation moved the graph (#1189: one that did not leaves no undo step). */
  readonly changed: boolean;
  readonly reportable?: Reportable;
}

/**
 * Validate and apply `ops` in order, as `validateOp` + `applyOp` would one by one, and return
 * the graph after the last with what each did. Throws what the first refused operation throws;
 * `state` is untouched either way. A batch that changes nothing returns `state` itself.
 */
export function applyOps(
  state: DagState,
  ops: readonly unknown[],
): { next: DagState; applied: AppliedOp[] } {
  const draft: Draft = { nodes: null, touched: new Map(), followers: null, consumed: null };
  const applied: AppliedOp[] = [];
  let working = state;
  for (const raw of ops) {
    const forward = validateOp(raw);
    draft.touched.clear();
    const { next, inverse, reportable } = applyWith(working, forward, draft);
    const step = { forward, inverse, changed: next !== working };
    applied.push(reportable ? { ...step, reportable } : step);
    working = next;
  }
  return { next: working, applied };
}

/** The graph with `id` set to `node`, or without it when `node` is undefined. The one place a
 *  write lands: a copy of the record for a single operation, the batch's own record for a batch. */
function putNode(
  state: DagState,
  draft: Draft | undefined,
  id: NodeId,
  node: Node | undefined,
): DagState {
  if (!draft) {
    if (node !== undefined) return { ...state, nodes: { ...state.nodes, [id]: node } };
    const { [id]: _removed, ...rest } = state.nodes;
    void _removed;
    return { ...state, nodes: rest };
  }
  if (draft.nodes === null) draft.nodes = { ...state.nodes };
  else if (state.nodes !== draft.nodes) throw new Error('applyOps: a write outside the batch');
  const nodes = draft.nodes;
  const prior = nodes[id];
  if (!draft.touched.has(id)) draft.touched.set(id, prior);
  if (draft.followers) refollow(draft.followers, id, prior?.meta?.nameFrom, node?.meta?.nameFrom);
  if (draft.consumed && prior?.inputs !== node?.inputs) {
    if (prior) countWires(draft.consumed, prior, -1);
    if (node) countWires(draft.consumed, node, 1);
  }
  if (node === undefined) delete nodes[id];
  else nodes[id] = node;
  return { ...state, nodes };
}

/** The graph as it was before the operation being applied wrote to it. */
function beforeWrites(state: DagState, draft: Draft | undefined): DagState {
  if (!draft || state.nodes !== draft.nodes || draft.touched.size === 0) return state;
  const nodes = { ...draft.nodes };
  for (const [id, prior] of draft.touched) {
    if (prior === undefined) delete nodes[id];
    else nodes[id] = prior;
  }
  return { ...state, nodes };
}

function countWires(consumed: Map<NodeId, number>, consumer: Node, by: 1 | -1): void {
  for (const binding of Object.values(consumer.inputs)) {
    for (const ref of Array.isArray(binding) ? binding : [binding]) {
      consumed.set(ref.node, (consumed.get(ref.node) ?? 0) + by);
    }
  }
}

function consumedIn(nodes: Readonly<Record<NodeId, Node>>): Map<NodeId, number> {
  const consumed = new Map<NodeId, number>();
  for (const node of Object.values(nodes)) countWires(consumed, node, 1);
  return consumed;
}

function followersOf(nodes: Readonly<Record<NodeId, Node>>): Map<NodeId, Set<NodeId>> {
  const followers = new Map<NodeId, Set<NodeId>>();
  for (const node of Object.values(nodes))
    refollow(followers, node.id, undefined, node.meta?.nameFrom);
  return followers;
}

function refollow(
  followers: Map<NodeId, Set<NodeId>>,
  id: NodeId,
  was: NodeId | undefined,
  now: NodeId | undefined,
): void {
  if (was === now) return;
  if (was !== undefined) followers.get(was)?.delete(id);
  if (now === undefined) return;
  const set = followers.get(now);
  if (set) set.add(id);
  else followers.set(now, new Set([id]));
}

function applyWith(state: DagState, op: Op, draft: Draft | undefined): ApplyResult {
  const result = applyUnguarded(state, op, draft);
  // #1583 — which nodes own a sub-network follows the graph through every operation, so the
  // rules below never have to walk the graph to find them.
  carrySubnetworkOwners(state, result.next, op);
  // #1547 — the two ops that can add an edge are the two that can put a node in two
  // sub-networks, or let something outside consume a node inside one.
  if (op.type === 'addNode' || op.type === 'connect') {
    return holdingSubnetworks(state, op, result, draft);
  }
  if (op.type === 'setParam') return holdingLeafNames(state, op, result, draft);
  return result;
}

function applyUnguarded(state: DagState, op: Op, draft: Draft | undefined): ApplyResult {
  switch (op.type) {
    case 'addNode':
      return applyAddNode(state, op, draft);
    case 'removeNode':
      return applyRemoveNode(state, op, draft);
    case 'connect':
      return applyConnect(state, op, draft);
    case 'disconnect':
      return applyDisconnect(state, op, draft);
    case 'setParam':
      return followNames(state, applySetParam(state, op, draft), op.nodeId, draft);
    case 'setMeta':
      return followNames(state, applySetMeta(state, op, draft), op.nodeId, draft);
    case 'setSpareParam':
      return applySetSpareParam(state, op, draft);
    case 'removeSpareParam':
      return applyRemoveSpareParam(state, op, draft);
  }
}

/** The nodes an edge-adding op wires FROM. */
function producersOf(op: Extract<Op, { type: 'addNode' | 'connect' }>): NodeId[] {
  if (op.type === 'connect') return [op.from.node];
  return Object.values(op.inputs ?? {}).flatMap((binding) =>
    (Array.isArray(binding) ? binding : [binding]).map((ref) => ref.node),
  );
}

/** #1547 — refuse an edge-adding op that leaves a sub-network with a second owner or an
 *  outside consumer. #1579 — or a Lag or Solver inside a Solver's sub-network reading that
 *  Solver's inputs. Only violations the op itself introduced are refused. #1583 — and only a
 *  wire whose producer ends up inside a sub-network is asked: no other wire can introduce one. */
function holdingSubnetworks(
  state: DagState,
  op: Extract<Op, { type: 'addNode' | 'connect' }>,
  result: ApplyResult,
  draft: Draft | undefined,
): ApplyResult {
  if (!reachesSubnetwork(result.next, producersOf(op))) return result;
  const before = beforeWrites(state, draft);
  const reason =
    newSubnetworkViolation(before, result.next) ?? newStatefulLeafRead(before, result.next);
  if (reason) throw new OpError(`${op.type}: ${reason}`, op);
  return result;
}

/** #1579 — a sub-network leaf reads the input its params name, so renaming that is the one way
 *  to make a Lag read the Solver around it without adding a wire. Asked only of a leaf, and
 *  (#1583) only of one that sits inside a sub-network. */
function holdingLeafNames(
  state: DagState,
  op: Extract<Op, { type: 'setParam' }>,
  result: ApplyResult,
  draft: Draft | undefined,
): ApplyResult {
  const node = state.nodes[op.nodeId];
  if (!node || requireNodeType(node.type).bodyInputLeaf !== true) return result;
  if (!reachesSubnetwork(result.next, [op.nodeId])) return result;
  const reason = newStatefulLeafRead(beforeWrites(state, draft), result.next);
  if (reason) throw new OpError(`setParam: ${reason}`, op);
  return result;
}

function applyAddNode(
  state: DagState,
  op: Extract<Op, { type: 'addNode' }>,
  draft: Draft | undefined,
): ApplyResult {
  if (hasNode(state, op.nodeId)) {
    throw new OpError(`addNode: id already exists: ${op.nodeId}`, op);
  }
  const def = requireNodeType(op.nodeType);
  const paramsParsed = def.paramSchema.safeParse(op.params);
  if (!paramsParsed.success) {
    throw new OpError(
      `addNode: params failed schema for ${op.nodeType}: ${paramsParsed.error.message}`,
      op,
    );
  }
  // #1580 — `inputs` is the second door a wire comes in by, and it used to be unguarded: a
  // pose into a Number socket, a socket the type does not have, a producer that is not in the
  // graph. Every wire here answers to the rule `connect` applies, one wire at a time.
  for (const [socket, binding] of Object.entries(op.inputs ?? {})) {
    const inputDesc = requireInput('addNode', op, op.nodeType, socket);
    const given = Array.isArray(binding);
    // A list on a single socket has no reading. The other way round is left alone: a lone
    // wire on a list socket is what `connect` itself reads as a list of one.
    if (given && inputDesc.cardinality !== 'list') {
      throw new OpError(
        `addNode: ${op.nodeType}.${socket} carries one wire and was given a list of ${binding.length}`,
        op,
      );
    }
    const held: NodeRef[] = [];
    for (const ref of given ? binding : [binding]) {
      // The node is not in the graph yet, so nothing can consume it: the only loop an
      // addNode can close is onto itself, and that needs no walk.
      if (ref.node === op.nodeId) {
        throw new OpError(`addNode: would create a cycle (${ref.node} → ${op.nodeId})`, op);
      }
      requireWire('addNode', op, state, op.nodeType, socket, inputDesc, ref, held);
      held.push(ref);
    }
  }
  const node: Node = {
    id: op.nodeId,
    type: op.nodeType,
    version: def.version,
    params: paramsParsed.data,
    inputs: op.inputs ?? {},
  };
  const next = putNode(state, draft, op.nodeId, node);
  const inverse: Op = { type: 'removeNode', nodeId: op.nodeId };
  return { next, inverse };
}

function applyRemoveNode(
  state: DagState,
  op: Extract<Op, { type: 'removeNode' }>,
  draft: Draft | undefined,
): ApplyResult {
  const node = getNode(state, op.nodeId);
  // Refuse if any other node still consumes this one — caller must disconnect
  // first. This keeps undo composable: removeNode does not silently dangle.
  // #1585 — in a batch the number of wires leaving each node is known, so only a node that
  // is consumed is searched for its consumer, to name it.
  const consumed = draft ? (draft.consumed ??= consumedIn(state.nodes)) : undefined;
  if (!consumed || (consumed.get(op.nodeId) ?? 0) > 0) {
    for (const consumer of Object.values(state.nodes)) {
      for (const binding of Object.values(consumer.inputs)) {
        const refs = Array.isArray(binding) ? binding : [binding];
        if (refs.some((r) => r.node === op.nodeId)) {
          throw new OpError(`removeNode: ${op.nodeId} is still consumed by ${consumer.id}`, op);
        }
      }
    }
  }
  // Also fail if it's a named output socket — caller must rewire outputs first.
  for (const [name, ref] of Object.entries(state.outputs)) {
    if (ref.node === op.nodeId) {
      throw new OpError(`removeNode: ${op.nodeId} is bound as output '${name}'`, op);
    }
  }
  const next = putNode(state, draft, op.nodeId, undefined);
  const inverse: Op = {
    type: 'addNode',
    nodeId: node.id,
    nodeType: node.type,
    params: node.params,
    inputs: node.inputs,
  };
  return { next, inverse };
}

/** The input `socket` of a `consumerType` node, or the refusal that it has none. */
function requireInput(
  door: 'addNode' | 'connect',
  op: Op,
  consumerType: string,
  socket: string,
): InputDescriptor {
  const inputDesc = requireNodeType(consumerType).inputs[socket];
  if (!inputDesc) {
    throw new OpError(`${door}: ${consumerType} has no input socket '${socket}'`, op);
  }
  return inputDesc;
}

/** #1580 — whether ONE wire may enter ONE input, for every operation that can create a wire
 *  (`addNode` through its `inputs`, and `connect`; `wireDoors.test.ts` derives that set). The
 *  refusal reads the same from either door apart from the operation's name.
 *
 *  `held` is what the socket holds before this wire: its wires in the graph for `connect`,
 *  the ones earlier in the same list for `addNode`.
 *
 *  Not here: the loop check. `connect` walks for it; an `addNode` cannot close one except onto
 *  itself, so it does not pay for a walk per wire on an import of thousands of nodes. */
function requireWire(
  door: 'addNode' | 'connect',
  op: Op,
  state: DagState,
  consumerType: string,
  socket: string,
  inputDesc: InputDescriptor,
  ref: NodeRef,
  held: readonly NodeRef[],
): OutputDescriptor {
  const producer = getNode(state, ref.node);
  const outputDesc = requireNodeType(producer.type).outputs[ref.socket];
  if (!outputDesc) {
    throw new OpError(`${door}: ${producer.type} has no output socket '${ref.socket}'`, op);
  }
  // #609 — MEMBERSHIP, not equality: an input socket may accept a SET of types.
  // The message names the whole accepted set, so a rejection says what WOULD have
  // been taken rather than only what was offered.
  // #1549 — or a type the socket does not take but that converts on the way in (a Number into
  // a Vector3). Anything else is refused with what would make it work.
  if (!inputTakes(inputDesc, outputDesc.type)) {
    throw new OpError(
      `${door}: type mismatch ${producer.type}.${ref.socket}:${outputDesc.type} → ${consumerType}.${socket}:${acceptedTypes(inputDesc).join('|')}` +
        ` — ${whyNotTaken(inputDesc, outputDesc.type)}`,
      op,
    );
  }
  // #608 — AT MOST ONE PRODUCER PER ROLE on a list socket. A list is the right
  // shape for "several passes feed this job" and the wrong shape for "two of them
  // are the depth pass": the reader downstream then has to pick one and report the
  // ambiguity, because nothing in the model ever said the role was unique. Refuse
  // it here, where the author is present and the message can name the incumbent,
  // rather than at read time when it is a mystery.
  //
  // Only ROLE-BEARING producers are constrained. A list of role-less images — the
  // ordered frames VideoStitch encodes — stays unconstrained, which is what makes
  // this a rule about roles rather than a cap on list length.
  if (inputDesc.cardinality === 'list' && outputDesc.role !== undefined) {
    for (const other of held) {
      if (passRoleOf(state, other) !== outputDesc.role) continue;
      throw new OpError(
        `${door}: ${consumerType}.${socket} already holds a ${outputDesc.role} pass ` +
          `("${other.node}"); a role may be bound once. Disconnect it first.`,
        op,
      );
    }
  }
  return outputDesc;
}

function applyConnect(
  state: DagState,
  op: Extract<Op, { type: 'connect' }>,
  draft: Draft | undefined,
): ApplyResult {
  const consumer = getNode(state, op.to.node);
  // The producer is looked up before the socket, as it always was: a wire from a node that is
  // not in the graph says so first.
  getNode(state, op.from.node);
  const inputDesc = requireInput('connect', op, consumer.type, op.to.socket);
  const ref: NodeRef = { node: op.from.node, socket: op.from.socket };
  const prior = consumer.inputs[op.to.socket];
  const held = Array.isArray(prior) ? prior : prior ? [prior] : [];
  requireWire('connect', op, state, consumer.type, op.to.socket, inputDesc, ref, held);
  if (wouldCreateCycle(state, op.from.node, op.to.node)) {
    throw new OpError(`connect: would create a cycle (${op.from.node} → ${op.to.node})`, op);
  }

  let nextBinding: InputBinding;
  let inverse: Op;
  let reportable: Reportable | undefined;

  if (inputDesc.cardinality === 'list') {
    const existing = Array.isArray(prior) ? [...prior] : prior ? [prior] : [];
    const insertAt = op.index === undefined ? existing.length : Math.min(op.index, existing.length);
    existing.splice(insertAt, 0, ref);
    nextBinding = existing;
    inverse = { type: 'disconnect', from: ref, to: op.to };
  } else {
    nextBinding = ref;
    if (prior && !Array.isArray(prior)) {
      // #759 — a single socket carries ONE edge, so binding a second producer
      // DISPLACES the first. That used to happen with NO trace at all: same
      // call shape, same success, nothing recording that an edge was dropped.
      // A director wiring a second producer in to watch the two combine got
      // the first one deleted; an agent proposing it had no signal, so the
      // plan validated, applied, and quietly did half of what it said.
      //
      // REPORTABLE, not refused — 🔴 AND THE REASON THAT USED TO SIT HERE IS FALSE.
      // It is quoted rather than deleted, because it was cited as settled fact:
      // *"under e2e load it turned a glTF import into a hard failure: some
      // production path races two writers onto one socket, and replace-by-default
      // had been papering over it... The race is real and is filed separately."*
      //
      // There is no such race. #781 rebuilt the refusal behind a flag and recorded
      // every displacement WITH A STACK — instrumenting the change's own predicate
      // instead of its outcome. `p233-leaf-pick-select` then failed with the refusal
      // ON while its page recorded ZERO displacements: the gate never fired, so it
      // cannot have caused that failure. A 741-test census found 20 displacements,
      // 14 declaring `replace: true`, 5 test scaffolding, 1 production — `Scene.
      // lightRig` (#789), which is not a race. The e2e failure that motivated the
      // choice was that spec's own load-flakiness: its wait was satisfied by R3F's
      // default camera rather than by the imported mesh, fixed under #781.
      //
      // ⚠️ SO THE BEHAVIOUR BELOW IS UNCHANGED AND ITS JUSTIFICATION IS OPEN (#956).
      // Reporting may still be right, but not for the reason stated here, and the
      // evidence now points the other way: refusing ran green across the unit tier
      // and across every production caller, because `setActiveCamera` and all three
      // `operatorStack` splice paths already emit an explicit `disconnect` first.
      // Left as it is rather than flipped on the strength of a comment audit —
      // changing it is a behavioural decision that wants its own measurement.
      //
      // Re-binding the edge that is already there displaces nothing, so it
      // reports nothing, and stays idempotent for callers re-asserting state.
      // `replace: true` is the caller declaring the displacement on purpose:
      // still applied, but no longer anonymous, so the badge stays a signal
      // rather than noise every deliberate rewire has to be read past.
      if ((prior.node !== ref.node || prior.socket !== ref.socket) && op.replace !== true) {
        reportable = {
          badge: 'displaced-edge',
          nodeId: consumer.id,
          paramPath: op.to.socket,
          reason: `disconnected "${prior.node}.${prior.socket}" — a single socket carries one edge`,
        };
      }
      // Disconnect the old single binding as part of the inverse so undo
      // restores it. We model this as a follow-up connect in the inverse.
      //
      // The inverse carries `replace` because it lands on the socket THIS op
      // just filled: undoing a displacement is itself a displacement, and it
      // is a deliberate one, so it declares itself rather than badging the
      // user's undo with a warning about a state THEY did not author.
      inverse = { type: 'connect', from: prior, to: op.to, replace: true };
    } else {
      inverse = { type: 'disconnect', from: ref, to: op.to };
    }
  }

  // #1191 — re-binding the producer a single socket already holds changes nothing, so it
  // hands back the same state (the #1189 contract, `sameParamValue` below). A list socket
  // is not covered: connecting there always inserts, so the list really does grow.
  const unchanged = sameParamValue(prior, nextBinding);
  const next = unchanged
    ? state
    : putNode(state, draft, consumer.id, {
        ...consumer,
        inputs: { ...consumer.inputs, [op.to.socket]: nextBinding },
      });
  return reportable ? { next, inverse, reportable } : { next, inverse };
}

function applyDisconnect(
  state: DagState,
  op: Extract<Op, { type: 'disconnect' }>,
  draft: Draft | undefined,
): ApplyResult {
  const consumer = getNode(state, op.to.node);
  const def = requireNodeType(consumer.type);
  const inputDesc = def.inputs[op.to.socket];
  if (!inputDesc) {
    throw new OpError(`disconnect: ${consumer.type} has no input socket '${op.to.socket}'`, op);
  }
  const prior = consumer.inputs[op.to.socket];
  if (prior === undefined) {
    throw new OpError(`disconnect: nothing connected at ${consumer.id}.${op.to.socket}`, op);
  }
  const inputs = { ...consumer.inputs };
  if (Array.isArray(prior)) {
    const idx = prior.findIndex((r) => r.node === op.from.node && r.socket === op.from.socket);
    if (idx === -1) {
      throw new OpError(
        `disconnect: ${op.from.node}.${op.from.socket} not bound at ${consumer.id}.${op.to.socket}`,
        op,
      );
    }
    const nextList = [...prior.slice(0, idx), ...prior.slice(idx + 1)];
    if (nextList.length === 0) {
      delete inputs[op.to.socket];
    } else {
      inputs[op.to.socket] = nextList;
    }
  } else {
    if (prior.node !== op.from.node || prior.socket !== op.from.socket) {
      throw new OpError(
        `disconnect: bound producer is ${prior.node}.${prior.socket}, not ${op.from.node}.${op.from.socket}`,
        op,
      );
    }
    delete inputs[op.to.socket];
  }
  const nextNode: Node = { ...consumer, inputs };
  const next = putNode(state, draft, consumer.id, nextNode);
  const inverse: Op = { type: 'connect', from: op.from, to: op.to };
  return { next, inverse };
}

function applySetParam(
  state: DagState,
  op: Extract<Op, { type: 'setParam' }>,
  draft: Draft | undefined,
): ApplyResult {
  const node = getNode(state, op.nodeId);
  const def = requireNodeType(node.type);
  const prior = getAtPath(node.params, op.paramPath);
  const nextParams = setAtPath(node.params, op.paramPath, op.value);
  // Re-validate the whole params object — cheap for v0.5 schemas, and the
  // only sound way to honor cross-field constraints.
  const parsed = def.paramSchema.safeParse(nextParams);
  if (!parsed.success) {
    throw new OpError(
      `setParam: params failed schema for ${node.type}: ${parsed.error.message}`,
      op,
    );
  }
  // #1189 — A WRITE THAT CHANGES NOTHING HANDS BACK THE SAME STATE OBJECT. Everything
  // downstream keys on the reference: the store's undo push, the unsaved flag and
  // autosave (`installDirtyTracking` in boot.ts). A fresh object with identical
  // contents read as an edit to all three — measured: a stripped write and a same-value
  // write each left an undo step and the unsaved dot. So "nothing changed" is decided
  // HERE, once, by the one function that knows, and said in the only language those
  // readers already speak. The inverse is still returned (a caller may hold it), and the
  // stripped-write flag below still fires: the refusal stays visible, it just no longer
  // commits.
  const unchanged = sameParamValue(node.params, parsed.data);
  const inverse: Op = {
    type: 'setParam',
    nodeId: op.nodeId,
    paramPath: op.paramPath,
    value: prior,
  };
  // #423 — wrong-half write. `setAtPath` happily creates a key this node's schema
  // does not own; a non-strict schema then STRIPS it, so `safeParse` succeeds and
  // the write silently no-op'd. Detect the strip and mark the op REPORTABLE —
  // accepted, but surfaced instead of silent. A legitimate same-value write keeps
  // its value through the parse and is never flagged.
  //
  // 🔴 #1008 — THE TEST IS THE WHOLE PATH, NOT THE ROOT KEY. #423 compared the ROOT
  // key before and after the parse, which is exactly the depth its own case needed
  // and no deeper. A key nested under a root the schema DOES own leaves that root in
  // place: zod strips the unknown leaf, the root survives, the check looks at the
  // root, sees it, and says nothing. Measured — `Object.size` was reported while
  // `Object.overridden.bogus` returned success and changed nothing.
  //
  // Reading the value AT THE PATH covers both with one rule: a missing root means
  // the whole path is missing, so the root case behaves exactly as before, and every
  // depth below it is covered without a second rule to remember.
  //
  // ⚠️ A DELIBERATE `undefined` WRITE IS NOT A STRIP. `idRefSweep` clears a dangling
  // reference by setting its path to `undefined`; treating "no value at the path"
  // as a defect would badge the product's own cleanup.
  if (op.value !== undefined && getAtPath(parsed.data, op.paramPath) === undefined) {
    // 🔴 #1192 — A REFUSED WRITE COMMITS NOTHING, INCLUDING WHAT THE PATH WALK BUILT ON
    // THE WAY DOWN. `setAtPath` creates each missing container to reach the leaf, so a
    // refused `overridden.bogus` on a node whose `overridden` was absent left an empty
    // `overridden: {}` behind — a real content change, so `sameParamValue` above says
    // "changed" and the store committed it: one undo step and an unsaved dot for a write
    // the user was told was ignored. Measured, and it is the ONLY shape of it: a census
    // across the unit tier (a log here when `next !== state`) found exactly one hit, the
    // row in `ops.reportable.test.ts` that documented the residue.
    //
    // So the refusal hands back the state it was given, and the write below is never made
    // (#1585: in a batch a write lands in place, so one made and then set aside would stay).
    // The strip is only detectable AFTER the parse, which is why this cannot be folded into
    // the `unchanged` check above.
    const rootKey = paramRootKey(op.paramPath);
    const rootSurvived =
      rootKey === '' || Object.prototype.hasOwnProperty.call(parsed.data as object, rootKey);
    return {
      next: state,
      inverse,
      reportable: {
        badge: 'stripped-write',
        nodeId: op.nodeId,
        paramPath: op.paramPath,
        // 🔴 THE REASON MUST NOT RESTATE THE PATH. The badge that renders this
        // already opens with `Ignored <paramPath> on <nodeId>`, so a reason quoting
        // the path again reads as "Ignored overridden.bogus on n — 'overridden.bogus'
        // is not a parameter of Object" — observed in the DiffBar, invisible to every
        // assertion, because a test that checks the string CONTAINS the path passes
        // twice as happily as once.
        //
        // So each case says the thing the opening clause did not: a root miss under a
        // NESTED path names the segment that failed, which is new information; every
        // other case has nothing to add but the node type.
        reason:
          rootSurvived || rootKey === op.paramPath
            ? `${node.type} has no such parameter`
            : `${node.type} has no parameter '${rootKey}'`,
      },
    };
  }
  const next = unchanged ? state : putNode(state, draft, node.id, { ...node, params: parsed.data });
  return { next, inverse };
}

/**
 * #1189 — structural equality over param values, CONSERVATIVE by construction: plain
 * objects, arrays and primitives (`Object.is`, so NaN equals NaN and -0 differs from 0)
 * are compared by content; anything else — a typed array, a class instance, a Map — only
 * by reference. So it can answer "different" for two equal exotic values (the write then
 * commits as before), and can never answer "same" for two different ones, which is the
 * direction that would silently drop an edit.
 *
 * #1191 — also the one comparison for the other ops that can be asked to change nothing:
 * `connect`'s binding, `setMeta`'s whole meta, `setSpareParam`'s param.
 */
function sameParamValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!sameParamValue(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b) || !isPlainRecord(a) || !isPlainRecord(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !sameParamValue(a[k], b[k])) return false;
  }
  return true;
}

function isPlainRecord(v: object): v is Record<string, unknown> {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// #291 (Epic 1 Inc 0) — spare params live in `node.spare`, validated by the ONE
// shared SpareParamSchema (NOT the node's fixed per-type paramSchema, which would
// strip them — the H28 mechanism). setParam stays strict and untouched.
function applySetSpareParam(
  state: DagState,
  op: Extract<Op, { type: 'setSpareParam' }>,
  draft: Draft | undefined,
): ApplyResult {
  const node = getNode(state, op.nodeId);
  const parsed = SpareParamSchema.safeParse(op.param);
  if (!parsed.success) {
    throw new OpError(
      `setSpareParam: invalid spare param "${op.key}" on ${node.id}: ${parsed.error.message}`,
      op,
    );
  }
  const prior = node.spare?.[op.key];
  // #1191 — the value it already holds changes nothing: the same state (#1189 contract).
  const next = sameParamValue(prior, parsed.data)
    ? state
    : putNode(state, draft, node.id, {
        ...node,
        spare: { ...(node.spare ?? {}), [op.key]: parsed.data },
      });
  // Inverse: restore the prior value if the key existed, else remove the new key.
  const inverse: Op = prior
    ? { type: 'setSpareParam', nodeId: op.nodeId, key: op.key, param: prior }
    : { type: 'removeSpareParam', nodeId: op.nodeId, key: op.key };
  return { next, inverse };
}

function applyRemoveSpareParam(
  state: DagState,
  op: Extract<Op, { type: 'removeSpareParam' }>,
  draft: Draft | undefined,
): ApplyResult {
  const node = getNode(state, op.nodeId);
  const prior = node.spare?.[op.key];
  if (!prior) {
    throw new OpError(`removeSpareParam: no spare param "${op.key}" on ${node.id}`, op);
  }
  const nextSpare = { ...(node.spare ?? {}) };
  delete nextSpare[op.key];
  // Normalize an emptied collection back to `undefined` so a node whose last spare
  // param was removed serializes byte-identical to one that never had any.
  const nextNode: Node = {
    ...node,
    spare: Object.keys(nextSpare).length > 0 ? nextSpare : undefined,
  };
  const next = putNode(state, draft, node.id, nextNode);
  const inverse: Op = { type: 'setSpareParam', nodeId: op.nodeId, key: op.key, param: prior };
  return { next, inverse };
}

/**
 * #1122 — copy a changed name onto every node that follows it.
 *
 * Runs inside the one reducer, so each road that changes a name — the inspector's `setParam`
 * (whose path is a variable no search can list), a re-cook's bake, an agent's batch, undo and
 * redo — carries its followers with it, and every reader of `meta.name` stays true without
 * knowing links exist. The inverse needs nothing extra: undoing the source's change replays
 * through here and copies the old name back.
 *
 * One hop. A follower's own followers are not walked, so a hand-edited loop cannot spin.
 */
function followNames(
  prev: DagState,
  result: ApplyResult,
  sourceId: NodeId,
  draft: Draft | undefined,
): ApplyResult {
  // In a batch the write has already landed in `prev`'s record, so what the source was is
  // what the write recorded.
  const before = draft?.touched.has(sourceId) ? draft.touched.get(sourceId) : prev.nodes[sourceId];
  const after = result.next.nodes[sourceId];
  if (!before || !after || ownName(before) === ownName(after)) return result;
  const name = followableName(after);
  if (name === undefined) return result;
  const stale = (node: Node | undefined): node is Node =>
    node !== undefined &&
    node.id !== sourceId &&
    node.meta?.nameFrom === sourceId &&
    node.meta.name !== name;
  const renamed = (node: Node): Node => ({ ...node, meta: { ...node.meta, name } });
  if (draft) {
    // #1585 — the followers are known, not searched for: reading every node after every
    // rename was 1.0 s of a 5,019-node import.
    const followers = (draft.followers ??= followersOf(result.next.nodes));
    let next = result.next;
    for (const id of [...(followers.get(sourceId) ?? [])]) {
      const node = next.nodes[id];
      if (stale(node)) next = putNode(next, draft, id, renamed(node));
    }
    return next === result.next ? result : { ...result, next };
  }
  let nodes = result.next.nodes;
  for (const node of Object.values(nodes)) {
    if (stale(node)) nodes = { ...nodes, [node.id]: renamed(node) };
  }
  return nodes === result.next.nodes ? result : { ...result, next: { ...result.next, nodes } };
}

function applySetMeta(
  state: DagState,
  op: Extract<Op, { type: 'setMeta' }>,
  draft: Draft | undefined,
): ApplyResult {
  // #224 — rename. `meta` is node identity data, not a per-type param, so this
  // bypasses paramSchema (validated only by OpSchema's `name: string?`). Other
  // meta fields (graph `position`) are preserved; an undefined name DELETES the
  // override key so the label cleanly falls back to the node id.
  const node = getNode(state, op.nodeId);
  const prior = node.meta?.name;
  const priorFrom = node.meta?.nameFrom;
  const meta = { ...node.meta };
  // #1122 — with a link, the name is the linked node's when it has one (so re-arming a link on
  // undo cannot restore a name the source has since moved past); without one, the link goes.
  const linked =
    op.nameFrom !== undefined && op.nameFrom !== op.nodeId
      ? followableName(state.nodes[op.nameFrom])
      : undefined;
  if (op.nameFrom !== undefined && op.nameFrom !== op.nodeId) {
    meta.nameFrom = op.nameFrom;
  } else {
    delete meta.nameFrom;
  }
  const name = linked ?? op.name;
  if (name === undefined) {
    delete meta.name;
  } else {
    meta.name = name;
  }
  // An empty meta object is normalized away so a renamed-then-cleared node is
  // byte-identical to one that was never named (keeps save diffs minimal).
  const nextMeta = Object.keys(meta).length === 0 ? undefined : meta;
  // #1191 — judged on the WHOLE resulting meta, not on the name alone: a write that keeps
  // the name but drops a `nameFrom` link, or clears a name, is a change; one that lands on
  // exactly the meta already there is not, and hands back the same state (#1189 contract).
  const next = sameParamValue(node.meta, nextMeta)
    ? state
    : putNode(state, draft, node.id, { ...node, meta: nextMeta });
  const inverse: Op = {
    type: 'setMeta',
    nodeId: op.nodeId,
    name: prior,
    ...(priorFrom !== undefined ? { nameFrom: priorFrom } : {}),
  };
  return { next, inverse };
}
