// idRefSweep — the ONE walker over the id-reference universe (#421, #424).
//
// Basher's graph has two halves. Edges carry the render tree, and `removeNode`
// already guards those: it refuses while a node is "still consumed by" another
// (ops.ts:143), so an edge can never dangle. The OTHER half travels in params —
// the V57 edge-less sidecars (keyframe channels, constraints, drivers, NLA strips)
// name their subject by id, not by wire. That half has never had a guard, so every
// delete could silently strand it.
//
// The stated intent at the op layer is already the right one — "removeNode does not
// silently dangle" (ops.ts:142). This module is that same invariant applied to the
// half the edge walk cannot see. It is deliberately a PURE function of
// (nodes, removedIds) → ops, with no store/registry side effects, so both delete
// authorities (the UI's `buildDeleteNodesOps` and the agent's `mutator.deleteNode`)
// can consume it and cannot drift — the divergence #424 is about.
//
// What each node type declares lives on `NodeDefinition.idRefs` (types.ts), NOT
// hardcoded here: a sweep with a hand-maintained field list is exactly the thing
// #421 warns goes stale at the next node kind.
//
// REF: src/core/dag/types.ts (the `idRefs` declaration + role/owns semantics);
//      src/app/sceneNodeActions.ts (the UI authority); issues #421, #424, #431.

import { getNodeType, registryEpoch } from './registry';
import type { DagState } from './state';
import { subnetworkOf, subnetworkOwnersOf } from './subnetworks';
import type { NodeDefinition, NodeId, Op } from './types';

/** Minimal node shape this walker reads (a DagState node subset). */
interface NodeLike {
  readonly id: string;
  readonly type: string;
  readonly params?: unknown;
  readonly meta?: { readonly name?: string; readonly nameFrom?: string };
}

type NodeTable = Readonly<Record<string, NodeLike>>;
type IdRefRow = NonNullable<NodeDefinition['idRefs']>[number];

/**
 * The node whose name `node` follows (`meta.nameFrom`, #1122), or undefined (#1553). It is an id
 * held outside params, so no `idRefs` row can declare it; it is read here so the walker that
 * answers "what points at this node" answers for it too.
 */
export function nameSourceOf(node: NodeLike): string | undefined {
  const from = node.meta?.nameFrom;
  return typeof from === 'string' && from ? from : undefined;
}

function atPath(params: unknown, path: string): unknown {
  let cur: unknown = params;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** The node ids a single declared ref currently points at (0, 1 or many). A 'keyed' row is
 *  read by `idsOfRef`, which knows the graph; here it names nothing. */
function refIdsAt(params: unknown, path: string, shape: string): string[] {
  const raw = atPath(params, path);
  if (shape === 'idList') {
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string' && !!v) : [];
  }
  if (shape === 'ref') {
    const node = (raw as { node?: unknown } | undefined)?.node;
    return typeof node === 'string' && node ? [node] : [];
  }
  // 'id' and 'nested' both resolve to a plain string at `path`.
  return typeof raw === 'string' && raw ? [raw] : [];
}

/** The keys at `path` (a 'keyed' row), or none. */
function keysAt(params: unknown, path: string): { readonly value?: unknown }[] {
  const raw = atPath(params, path);
  return Array.isArray(raw) ? (raw as { readonly value?: unknown }[]) : [];
}

/**
 * Whether `node` keys a param its `target` declares as a plain id (#1669), so that each of its
 * keys names a node. A camera switch's `active` names its camera, so the channel keying it (the
 * film's cuts) names one camera per key. The same channel type keying a prompt holds text.
 */
function keysHoldIds(node: NodeLike, nodes: NodeTable): boolean {
  const p = node.params as { target?: unknown; paramPath?: unknown } | undefined;
  const target = typeof p?.target === 'string' ? nodes[p.target] : undefined;
  if (!target) return false;
  return (getNodeType(target.type)?.idRefs ?? []).some(
    (r) => r.shape === 'id' && r.path === p!.paramPath,
  );
}

/**
 * The node ids one declared row of `node` names, read against `nodes`. Every reader of the
 * reference universe comes through here, so a 'keyed' row, whose keys are ids only when its
 * target says so, is seen by delete, duplicate, the commit check and the agent alike (#1669).
 */
export function idsOfRef(node: NodeLike, ref: IdRefRow, nodes: NodeTable): string[] {
  if (ref.shape !== 'keyed') return refIdsAt(node.params, ref.path, ref.shape);
  if (!keysHoldIds(node, nodes)) return [];
  const out: string[] = [];
  for (const key of keysAt(node.params, ref.path)) {
    if (typeof key.value === 'string' && key.value && !out.includes(key.value)) {
      out.push(key.value);
    }
  }
  return out;
}

/**
 * Whether `node`'s schema takes `''` at `path` (#1551). The sweep clears a plain id to the empty
 * string, which is what an unbound `target` or `aimNode` already holds. A schema that refuses it
 * (`Scene.activeCollection` is `z.string().min(1).optional()`) is cleared to absent instead:
 * `setParam` re-validates the whole params object, so an empty the schema refuses would throw
 * and take the entire delete with it.
 */
function acceptsEmptyString(node: NodeLike, path: string): boolean {
  const def = getNodeType(node.type);
  if (!def) return true;
  const trial = structuredClone(node.params);
  setAtPath(trial, path, '');
  return def.paramSchema.safeParse(trial).success;
}

/**
 * Everything deleting `seedIds` implies for the id-reference universe.
 *
 * `remove` is the seeds plus every node transitively pulled in — the 'subject'
 * referrers that are owned BY a removed node (a channel whose target is gone) and
 * the `owns` referents a removed node owned (a Track's strips). Computed to a
 * FIXPOINT: deleting an object removes the strips placed on it, and removing a strip
 * must in turn drop it from its Track's list. One pass is not enough.
 *
 * `ops` clears the 'argument' refs of nodes that SURVIVE — emitted only after the
 * removal set is final, so a node that is itself being removed never gets a pointless
 * (and invalid, since the node is gone) setParam.
 */
export function idRefSweep(
  nodes: NodeTable,
  seedIds: readonly NodeId[],
): { remove: Set<NodeId>; ops: Op[] } {
  const remove = new Set<NodeId>(seedIds);

  // 1. Fixpoint over both directions of ownership.
  for (let changed = true; changed; ) {
    changed = false;
    for (const node of Object.values(nodes)) {
      const refs = getNodeType(node.type)?.idRefs;
      if (!refs) continue;
      const selfRemoved = remove.has(node.id);
      for (const ref of refs) {
        const targets = idsOfRef(node, ref, nodes);
        // Downward: this node is going, so take what it owns with it.
        if (selfRemoved && ref.owns) {
          for (const t of targets) {
            if (nodes[t] && !remove.has(t)) {
              remove.add(t);
              changed = true;
            }
          }
          continue;
        }
        // Upward: the referent is going, and this node is owned by it.
        if (!selfRemoved && ref.role === 'subject' && targets.some((t) => remove.has(t))) {
          remove.add(node.id);
          changed = true;
        }
      }
    }
  }

  // 2. Clear dangling 'argument' refs on the survivors.
  const ops: Op[] = [];
  for (const node of Object.values(nodes)) {
    if (remove.has(node.id)) continue;
    // #1553 — a node following a removed node's name keeps the name it has and stops
    // following: a `setMeta` without `nameFrom` is exactly that.
    const source = nameSourceOf(node);
    if (source !== undefined && remove.has(source)) {
      ops.push({ type: 'setMeta', nodeId: node.id, name: node.meta?.name });
    }
    const refs = getNodeType(node.type)?.idRefs;
    if (!refs) continue;
    for (const ref of refs) {
      if (ref.role !== 'argument') continue;
      const targets = idsOfRef(node, ref, nodes);
      if (!targets.some((t) => remove.has(t))) continue;
      if (ref.shape === 'keyed') {
        // #1669 — the keys naming a removed node go, the rest stay as they were: deleting a
        // camera deletes its cuts, and the shot before runs on through them.
        ops.push({
          type: 'setParam',
          nodeId: node.id,
          paramPath: ref.path,
          value: keysAt(node.params, ref.path).filter(
            (k) => !(typeof k.value === 'string' && remove.has(k.value)),
          ),
        });
      } else if (ref.shape === 'idList') {
        // Drop the removed members, keep the rest in order.
        ops.push({
          type: 'setParam',
          nodeId: node.id,
          paramPath: ref.path,
          value: targets.filter((t) => !remove.has(t)),
        });
      } else if (ref.shape === 'ref') {
        // A whole `{ node }` param — the schema has it `.optional()`, so absent
        // is the natural empty.
        ops.push({ type: 'setParam', nodeId: node.id, paramPath: ref.path, value: undefined });
      } else {
        // 'id' and 'nested': clear the STRING in place. For 'nested' this
        // deliberately keeps the sibling fields (`sourceTransform.channel`,
        // `sourceSpare.key`) — dropping the whole object would silently switch a
        // driver back to its wired `in` road.
        ops.push({
          type: 'setParam',
          nodeId: node.id,
          paramPath: ref.path,
          value: acceptsEmptyString(node, ref.path) ? '' : undefined,
        });
      }
    }
  }

  return { remove, ops };
}

/**
 * Inverse index of the id-reference universe: for each referenced node id, the ids
 * of the nodes naming it. Built once per traversal so an "who points at me?" walk is
 * O(1) per step instead of O(nodes) — the same reason `expandClosure` pre-builds its
 * consumer index for edges.
 */
export function buildIdRefIndex(nodes: NodeTable): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const node of Object.values(nodes)) {
    const refs = getNodeType(node.type)?.idRefs;
    if (!refs) continue;
    for (const ref of refs) {
      for (const target of idsOfRef(node, ref, nodes)) {
        const list = index.get(target);
        if (list) {
          if (!list.includes(node.id)) list.push(node.id);
        } else {
          index.set(target, [node.id]);
        }
      }
    }
  }
  return index;
}

/**
 * The ids `node` names, SPLIT BY WHAT THE REFERENCE MEANS (#733).
 *
 * `role` is already the declared answer to "the referent was deleted — what happens to
 * me?", and that is the same question a reachability walk needs:
 *   • 'subject'  — this node is a sidecar OWNED BY the referent and meaningless without
 *                  it (a channel's target, a constraint's constrained object). Its effect
 *                  reaches the scene THROUGH the referent's own resolution, so a live
 *                  referent makes this node both live and consumed.
 *   • 'argument' — this node merely reads a referent that exists independently (the curve
 *                  a Follow-Path follows). That is an input, like a wired edge.
 *
 * Exported so a reader needing the distinction does not re-walk the declaration and
 * drift from `idRefsOutOf`; both read `NodeDefinition.idRefs` and nothing else.
 */
export function idRefsByRole(
  node: NodeLike,
  nodes: NodeTable,
): { subject: string[]; argument: string[] } {
  const out = { subject: [] as string[], argument: [] as string[] };
  for (const ref of getNodeType(node.type)?.idRefs ?? []) {
    const bucket = ref.role === 'subject' ? out.subject : out.argument;
    for (const target of idsOfRef(node, ref, nodes)) {
      if (!bucket.includes(target)) bucket.push(target);
    }
  }
  return out;
}

/** The node ids `node` names through its declared refs (the outward direction). */
export function idRefsOutOf(node: NodeLike, nodes: NodeTable): string[] {
  const out: string[] = [];
  for (const ref of getNodeType(node.type)?.idRefs ?? []) {
    for (const target of idsOfRef(node, ref, nodes)) {
      if (!out.includes(target)) out.push(target);
    }
  }
  return out;
}

/**
 * The FIRST id-reference in `nodes` that names a node not present — or null when the
 * id-reference universe is whole (#435).
 *
 * This is the FINAL-STATE form of "does not silently dangle". The edge guard in
 * `removeNode` is per-op because edges are always explicitly torn down; an id-ref is a
 * param that can legitimately outlive a removeNode within one batch — a batch may remove a
 * node and re-add one under the SAME id (Apply-Transform did, #412, until #1476 kept the
 * Object in place), so a channel/constraint naming that id is momentarily dangling
 * mid-batch yet whole once the batch settles. The invariant that actually matters is therefore about the COMMITTED
 * state, not any transient: after a batch, no node points at a missing id. Checked at the
 * commit chokepoint (`dispatchAtomic`), only when a removeNode is present — the sole op
 * that can turn a live ref into a dangling one.
 */
export function findDanglingIdRef(nodes: NodeTable): { node: string; missing: string } | null {
  return danglingIdRefs(nodes)[0] ?? null;
}

/** Every id-reference in `nodes` that names a node not present, as referrer and missing id. */
export function danglingIdRefs(nodes: NodeTable): { node: string; missing: string }[] {
  const out: { node: string; missing: string }[] = [];
  for (const node of Object.values(nodes)) {
    for (const target of idRefsOutOf(node, nodes)) {
      if (!nodes[target]) out.push({ node: node.id, missing: target });
    }
    // #1553 — a followed name is an id too, and its source can be removed like any other.
    const source = nameSourceOf(node);
    if (source !== undefined && !nodes[source]) out.push({ node: node.id, missing: source });
  }
  return out;
}

/**
 * The first dangling id-reference in `after` that `before` did not already hold (#1571), or
 * null. A commit is refused for what IT strands, not for what the project arrived with: a
 * reference saved before its param was declared (#1551), or written by an `addNode` naming an
 * id that never existed, would otherwise make every later delete of anything throw.
 */
export function findNewDanglingIdRef(
  before: NodeTable,
  after: NodeTable,
): { node: string; missing: string } | null {
  const now = danglingIdRefs(after);
  if (now.length === 0) return null;
  const was = new Set(danglingIdRefs(before).map((d) => `${d.node}\0${d.missing}`));
  return now.find((d) => !was.has(`${d.node}\0${d.missing}`)) ?? null;
}

/**
 * The nodes OWNED BY any node in `ids` through a SUBJECT idRef — a keyframe channel
 * whose target is being duplicated, a constraint on it, a driver of it, a strip
 * placed on it (#434). This is the copy-direction twin of the delete sweep's upward
 * walk: the exact set delete REMOVES when a subject's referent goes, reused to decide
 * what a duplicate must CLONE alongside its subtree. Argument-only referrers are
 * excluded — a constraint that merely AIMS AT a duplicated object belongs to a
 * different object and is not copied.
 */
export function subjectReferrersInto<T extends NodeLike>(
  nodes: Readonly<Record<string, T>>,
  ids: ReadonlySet<string>,
): T[] {
  const out: T[] = [];
  for (const node of Object.values(nodes)) {
    if (ids.has(node.id)) continue; // a subtree node is cloned by the main walk, not here
    const refs = getNodeType(node.type)?.idRefs;
    if (!refs) continue;
    const owned = refs.some(
      (r) => r.role === 'subject' && idsOfRef(node, r, nodes).some((t) => ids.has(t)),
    );
    if (owned) out.push(node);
  }
  return out;
}

function setAtPath(obj: unknown, path: string, value: unknown): void {
  const segs = path.split('.');
  let cur = obj as Record<string, unknown>;
  for (let i = 0; i < segs.length - 1; i++) cur = cur[segs[i]] as Record<string, unknown>;
  cur[segs[segs.length - 1]] = value;
}

/**
 * A deep copy of `node`'s params with every declared id rewritten by `remap`. The
 * copy-direction counterpart to the sweep's clear: where the sweep empties a dangling
 * ref, this REPOINTS it. Callers pass `id => idMap.get(id) ?? id`, so a subject ref
 * into the cloned subtree lands on the clone while an argument ref to a SHARED node (a
 * followed curve, a played Action) is left pointing at the original — the exact rule
 * the edge rewire applies to wired inputs. Only refs that currently hold a value are
 * touched, and a nested id is rewritten in place so its siblings (`sourceTransform`'s
 * `channel`, `sourceSpare`'s `key`) survive.
 */
export function remapIdRefs(
  node: NodeLike,
  remap: (id: string) => string,
  nodes: NodeTable,
): unknown {
  const params = structuredClone(node.params);
  const refs = getNodeType(node.type)?.idRefs;
  if (!refs) return params;
  for (const ref of refs) {
    const cur = idsOfRef(node, ref, nodes);
    if (cur.length === 0) continue;
    if (ref.shape === 'keyed') {
      // #1669 — each key naming a node is re-pointed in place, its time and easing kept.
      for (const key of keysAt(params, ref.path) as { value?: unknown }[]) {
        if (typeof key.value === 'string' && key.value) key.value = remap(key.value);
      }
    } else if (ref.shape === 'idList') {
      setAtPath(params, ref.path, cur.map(remap));
    } else if (ref.shape === 'ref') {
      // `<path>` is the `{ node }` object; rewrite `.node` so any siblings survive.
      setAtPath(params, `${ref.path}.node`, remap(cur[0]));
    } else {
      // 'id' — a plain string at `path`; 'nested' — a string already ending in `.node`.
      setAtPath(params, ref.path, remap(cur[0]));
    }
  }
  return params;
}

// ── #1560 — what a WIRE owns ───────────────────────────────────────────────────────────────
//
// A reference says what it owns in its `idRefs` row. A wire says it on the socket it enters
// (`InputDescriptor.owns`, `body`), and delete and duplicate both ask here, so neither keeps a
// list of socket names of its own. Two lists is how an Object's stack came to be copied whole by
// one verb and half-deleted by the other (#1620).

/** How the node holding `socket` relates to what is wired into it. See `InputDescriptor.owns`. */
export type WireOwnership = 'always' | 'stack' | 'body';

export function wireOwnership(nodeType: string, socket: string): WireOwnership | null {
  const def = getNodeType(nodeType);
  const decl = def?.inputs?.[socket];
  if (!def || !decl) return null;
  if (decl.body) return 'body';
  if (decl.owns) return decl.owns;
  // An operator's declared spine is the stack it sits on (13 types, all through `chain`).
  return def.chain?.input === socket ? 'stack' : null;
}

/** The socket `nodeType` reads the rest of its stack on, or null when it sits on none. */
export function stackSocketOf(nodeType: string): string | null {
  const def = getNodeType(nodeType);
  if (!def) return null;
  for (const socket of Object.keys(def.inputs ?? {})) {
    if (wireOwnership(nodeType, socket) === 'stack') return socket;
  }
  return null;
}

// ── #1553 — every relationship of a node, from one query ─────────────────────────────
//
// A node relates to others four ways: a wire (`inputs`), a declared reference in a param
// (`idRefs`), a followed name (`meta.nameFrom`), and membership of a sub-network (the closure
// behind an owner's body sockets, src/core/dag/subnetworks.ts). Each already had a reader; no
// caller could ask for all four, and name followers had none outside the reducer. `relationsOf`
// composes the readers that exist and adds nothing of its own to walk.
//
// Wires and references stay separate lists, as Houdini keeps `inputs()` / `outputs()` apart
// from `references()` / `dependents()`: a wire carries a value, a reference names a node.

/** A wire, seen from the node asked about. */
export interface WireRelation {
  /** The node at the other end. */
  readonly node: NodeId;
  /** The input socket the wire enters, on whichever node consumes it. */
  readonly socket: string;
  /** The output socket the wire leaves, on whichever node produces it. */
  readonly output: string;
}

/** A declared reference, seen from the node asked about. */
export interface RefRelation {
  /** The node at the other end. */
  readonly node: NodeId;
  /** The param path on the REFERRER that holds the id. */
  readonly path: string;
  readonly role: 'subject' | 'argument';
  readonly owns: boolean;
}

export interface NodeRelations {
  /** What this node consumes by wire. */
  readonly wiresIn: readonly WireRelation[];
  /** What consumes this node by wire. */
  readonly wiresOut: readonly WireRelation[];
  /** The nodes this one names in a param. */
  readonly refsOut: readonly RefRelation[];
  /** The nodes that name this one in a param. */
  readonly refsIn: readonly RefRelation[];
  /** The node whose name this one follows, or null. */
  readonly follows: NodeId | null;
  /** The nodes following this one's name. */
  readonly followers: readonly NodeId[];
  /** The sub-network owners whose closure holds this node (outermost last when nested). */
  readonly insideSubnetworkOf: readonly NodeId[];
  /** The nodes in this node's own sub-network; empty unless it owns one. */
  readonly subnetwork: readonly NodeId[];
  /** Every reference cycle this node sits on, each as the ids in dependency order. */
  readonly cycles: readonly (readonly NodeId[])[];
}

interface RelationIndex {
  readonly epoch: number;
  readonly wiresOut: ReadonlyMap<NodeId, WireRelation[]>;
  readonly refsIn: ReadonlyMap<NodeId, RefRelation[]>;
  readonly followers: ReadonlyMap<NodeId, NodeId[]>;
  readonly memberOf: ReadonlyMap<NodeId, NodeId[]>;
  readonly subnetworks: ReadonlyMap<NodeId, NodeId[]>;
  cycles: readonly (readonly NodeId[])[] | null;
}

// Built once per graph and kept beside its `nodes` record, the way `subnetworkOwnersOf` keeps
// the owners: every write makes a new record, so a held index can never describe another graph.
const relationIndexByNodes = new WeakMap<DagState['nodes'], RelationIndex>();

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function wiresInto(node: { readonly inputs: DagState['nodes'][string]['inputs'] }): WireRelation[] {
  const out: WireRelation[] = [];
  for (const [socket, binding] of Object.entries(node.inputs)) {
    for (const ref of Array.isArray(binding) ? binding : [binding]) {
      out.push({ node: ref.node, socket, output: ref.socket });
    }
  }
  return out;
}

function refsOutOf(node: NodeLike, nodes: NodeTable): RefRelation[] {
  const out: RefRelation[] = [];
  for (const ref of getNodeType(node.type)?.idRefs ?? []) {
    for (const target of idsOfRef(node, ref, nodes)) {
      out.push({ node: target, path: ref.path, role: ref.role, owns: ref.owns === true });
    }
  }
  return out;
}

function relationIndexOf(state: DagState): RelationIndex {
  const known = relationIndexByNodes.get(state.nodes);
  if (known && known.epoch === registryEpoch()) return known;
  const wiresOut = new Map<NodeId, WireRelation[]>();
  const refsIn = new Map<NodeId, RefRelation[]>();
  const followers = new Map<NodeId, NodeId[]>();
  for (const node of Object.values(state.nodes)) {
    for (const wire of wiresInto(node)) pushTo(wiresOut, wire.node, { ...wire, node: node.id });
    for (const ref of refsOutOf(node, state.nodes))
      pushTo(refsIn, ref.node, { ...ref, node: node.id });
    const source = nameSourceOf(node);
    if (source !== undefined) pushTo(followers, source, node.id);
  }
  const memberOf = new Map<NodeId, NodeId[]>();
  const subnetworks = new Map<NodeId, NodeId[]>();
  for (const owner of subnetworkOwnersOf(state)) {
    const closure = [...subnetworkOf(state, owner)];
    subnetworks.set(owner, closure);
    for (const id of closure) pushTo(memberOf, id, owner);
  }
  // A nested owner sits inside the outer one, so the smaller closure is the nearer owner.
  for (const owners of memberOf.values()) {
    owners.sort((a, b) => subnetworks.get(a)!.length - subnetworks.get(b)!.length);
  }
  const index: RelationIndex = {
    epoch: registryEpoch(),
    wiresOut,
    refsIn,
    followers,
    memberOf,
    subnetworks,
    cycles: null,
  };
  relationIndexByNodes.set(state.nodes, index);
  return index;
}

/**
 * Every relationship `nodeId` has, in both directions (#1553). The one answer to "what is
 * connected to this node" for delete, duplicate, the agent and the node view. A node that is
 * not in the graph has none; what still names it is in `refsIn` and `followers`.
 */
export function relationsOf(state: DagState, nodeId: NodeId): NodeRelations {
  const index = relationIndexOf(state);
  const node = state.nodes[nodeId];
  return {
    wiresIn: node ? wiresInto(node) : [],
    wiresOut: index.wiresOut.get(nodeId) ?? [],
    refsOut: node ? refsOutOf(node, state.nodes) : [],
    refsIn: index.refsIn.get(nodeId) ?? [],
    follows: (node && nameSourceOf(node)) ?? null,
    followers: index.followers.get(nodeId) ?? [],
    insideSubnetworkOf: index.memberOf.get(nodeId) ?? [],
    subnetwork: index.subnetworks.get(nodeId) ?? [],
    cycles: referenceCycles(state).filter((cycle) => cycle.includes(nodeId)),
  };
}

// ── What depends on what ──────────────────────────────────────────────────────────────
//
// A node is read two ways, and a cycle finder that merges them cries wolf. A WIRE hands over a
// node's cooked value. An 'argument' reference reads the node's own resolved parameters (the
// transform a Track-To aims at, the channel a Lag follows), not what it cooks from its inputs.
// So a camera in a Group that aims at the Group is no cycle, though the Group is wired to the
// camera: the aim reads the Group's transform, which does not need the camera. Blender draws
// the same line between an object's transform and its geometry in its dependency graph.
//
// Each node is therefore three points, and an arrow reads "needs":
//
//   value(n)  -> value(p)   for every wire p -> n
//   value(n)  -> params(n)
//   params(n) -> value(s)   for every 'subject' sidecar s of n (a channel, driver, constraint)
//   value(r)  -> params(t)  for every 'argument' reference r -> t
//   name(f)   -> name(s)    for a followed name
//
// Not modelled: an 'argument' reference whose reader cooks the node it names. A cycle that
// closes only through such a read is not reported.

const PARAMS = '\u0000params';
const NAME = '\u0000name';

function dependencies(nodes: DagState['nodes']): Map<string, string[]> {
  const needs = new Map<string, string[]>();
  const add = (dependent: string, on: string) => {
    const list = needs.get(dependent);
    if (!list) needs.set(dependent, [on]);
    else if (!list.includes(on)) list.push(on);
  };
  for (const node of Object.values(nodes)) {
    add(node.id, node.id + PARAMS);
    for (const wire of wiresInto(node)) if (nodes[wire.node]) add(node.id, wire.node);
    for (const ref of refsOutOf(node, nodes)) {
      if (!nodes[ref.node]) continue;
      if (ref.role === 'subject') add(ref.node + PARAMS, node.id);
      else add(node.id, ref.node + PARAMS);
    }
    const source = nameSourceOf(node);
    if (source !== undefined && nodes[source]) add(node.id + NAME, source + NAME);
  }
  return needs;
}

/** The node ids along a path of points, each node once per visit. */
function nodesAlong(path: readonly string[]): NodeId[] {
  const out: NodeId[] = [];
  for (const point of path) {
    const cut = point.indexOf('\u0000');
    const id = cut < 0 ? point : point.slice(0, cut);
    if (out[out.length - 1] !== id) out.push(id);
  }
  if (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
  return out;
}

/**
 * Every cycle that runs through at least one reference (#1553), each as the node ids in
 * dependency order: each needs the next, and the last needs the first. A node that needs
 * itself is a cycle of one. One cycle is reported per knot of mutually dependent nodes.
 *
 * Reported, not refused. Blender stores a constraint or driver cycle and names it when the
 * scene evaluates (`Dependency cycle detected`, depsgraph/intern/builder/deg_builder_cycle.cc);
 * Houdini's dependency view draws a circular reference in red. A cycle of WIRES alone is a
 * different thing and stays refused at `connect`, so none can be stored to be found here.
 */
export function referenceCycles(state: DagState): readonly (readonly NodeId[])[] {
  const index = relationIndexOf(state);
  if (index.cycles) return index.cycles;
  const needs = dependencies(state.nodes);
  const cycles: NodeId[][] = [];
  // Tarjan's strongly connected components, on its own stack so a long chain cannot overflow
  // the call stack (as `wouldCreateCycle` does, #1581).
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let next = 0;
  for (const root of needs.keys()) {
    if (order.has(root)) continue;
    const work: { id: string; at: number }[] = [{ id: root, at: 0 }];
    while (work.length) {
      const frame = work[work.length - 1];
      if (frame.at === 0) {
        order.set(frame.id, next);
        low.set(frame.id, next);
        next += 1;
        stack.push(frame.id);
        onStack.add(frame.id);
      }
      const deps = needs.get(frame.id) ?? [];
      if (frame.at < deps.length) {
        const dep = deps[frame.at];
        frame.at += 1;
        if (!order.has(dep)) work.push({ id: dep, at: 0 });
        else if (onStack.has(dep)) low.set(frame.id, Math.min(low.get(frame.id)!, order.get(dep)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      if (low.get(frame.id) !== order.get(frame.id)) continue;
      const knot: string[] = [];
      for (;;) {
        const id = stack.pop()!;
        onStack.delete(id);
        knot.push(id);
        if (id === frame.id) break;
      }
      if (knot.length > 1 || deps.includes(frame.id)) {
        cycles.push(nodesAlong(cycleThrough(needs, new Set(knot), frame.id)));
      }
    }
  }
  index.cycles = cycles;
  return cycles;
}

/** One closed path inside `knot` that starts and ends at `start`, following `needs`. */
function cycleThrough(
  needs: ReadonlyMap<string, readonly string[]>,
  knot: ReadonlySet<string>,
  start: string,
): string[] {
  // Breadth-first from `start` to the nearest node that needs `start` back: the shortest
  // cycle through it, which is the one worth reading.
  const cameFrom = new Map<string, string | null>([[start, null]]);
  const queue: string[] = [start];
  while (queue.length) {
    const id = queue.shift()!;
    for (const dep of needs.get(id) ?? []) {
      if (dep === start) {
        const path: string[] = [];
        for (let at: string | null = id; at !== null; at = cameFrom.get(at) ?? null) path.push(at);
        return path.reverse();
      }
      if (!knot.has(dep) || cameFrom.has(dep)) continue;
      cameFrom.set(dep, id);
      queue.push(dep);
    }
  }
  return [start];
}
