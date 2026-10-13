// Shared scene-node action op-builders (#227). ONE authority for the ops that
// delete (and later duplicate) scene nodes, so the keyboard shortcut, the outliner
// context menu, and any future surface all dispatch the SAME ops — the "one write
// authority, N callers" shape (cf. V65 select handler, V69 rename op). Pure: a
// function of (state, ids) → Op[]; the caller dispatches + manages selection.

import type { DagState } from '../core/dag/state';
import type { Node, NodeId, Op } from '../core/dag/types';
import { getNodeType } from '../core/dag/registry';
import {
  buildIdRefIndex,
  idRefsByRole,
  idRefSweep,
  subjectReferrersInto,
  remapIdRefs,
  stackSocketOf,
  wireOwnership,
} from '../core/dag/idRefSweep';
import { subnetworkOf } from '../core/dag/subnetworks';
import {
  collectionDeleteRelinkOps,
  collectionsHolding,
  isMembershipWire,
  membershipOps,
} from './collections';

/**
 * #432 — a WRAPPER node consumes its subject through a chain EDGE and re-exposes it
 * via `out`: Transform, MaterialOverride, ArrayModifier, MirrorModifier, ColorCorrect,
 * SetMaterialOp, MaterialOverrideOp. Derived from the registry, NOT a hardcoded type
 * list — the id-reference nodes (KeyframeChannel / TrackTo / … name their target in
 * `params.target`, no edge) plus any future edge-target constraint (no `out`) are
 * correctly excluded.
 *
 * #396 — it now asks for the node's DECLARED spine rather than testing for a socket
 * literally named `target`. Same set today, because every wrapper spells its spine that
 * way; the difference is which question is being asked, and only one of the two keeps
 * meaning the right thing for a wrapper whose subject arrives on a differently-named
 * socket — or which has a SECOND same-typed input that is an argument, not a subject.
 */
function isTargetWrapperNode(node: Node | undefined): boolean {
  return !!spineOf(node) && !!getNodeType(node!.type)?.outputs['out'];
}

/** The socket `node` reads the rest of its stack on (#1560): an operator's declared chain
 *  socket, a pose layer's or a Rig's `pose`. Asked of the declaration, as `wireOwnership` is. */
function spineOf(node: Node | undefined): string | null {
  return node ? stackSocketOf(node.type) : null;
}

/** One wire, seen from the node it leaves: who reads it, on which socket, from which output. */
interface Reader {
  readonly node: NodeId;
  readonly socket: string;
  readonly fromSocket: string;
}

/**
 * Who reads each node, built ONCE per delete (#1629). Every question below ("does anything
 * else still read this?", "who has to be disconnected from it?", "what read this modifier?")
 * used to read every node in the graph, once per node being deleted: 4.3 s for a group of
 * 2,000 cubes. Entries keep the graph's own order (reader, then socket, then position), so the
 * ops come out in the order they always did.
 */
function readersIndex(state: DagState): Map<NodeId, Reader[]> {
  const index = new Map<NodeId, Reader[]>();
  for (const [cid, c] of Object.entries(state.nodes)) {
    for (const [socket, binding] of Object.entries(c.inputs ?? {})) {
      for (const ref of refsOf(binding)) {
        if (!ref?.node) continue;
        const entry = { node: cid, socket, fromSocket: ref.socket };
        const list = index.get(ref.node);
        if (list) list.push(entry);
        else index.set(ref.node, [entry]);
      }
    }
  }
  return index;
}

/** Every node+input-socket consuming `(producerId, 'out')`, once per socket. */
function outConsumers(
  readers: ReadonlyMap<NodeId, Reader[]>,
  producerId: NodeId,
): { node: string; socket: string }[] {
  const out: { node: string; socket: string }[] = [];
  for (const r of readers.get(producerId) ?? []) {
    if (r.fromSocket !== 'out') continue;
    if (!out.some((o) => o.node === r.node && o.socket === r.socket)) {
      out.push({ node: r.node, socket: r.socket });
    }
  }
  return out;
}

/** The nearest SURVIVING consumer above `wrapperId`, hopping over any wrappers that
 *  are themselves being deleted — so deleting a whole stack (scene → Mirror → Array →
 *  mesh) still splices the surviving base back to the surviving consumer (scene).
 *
 *  #1620 — it hops over a deleted WRAPPER that read this one on its spine, and over nothing
 *  else. A deleted Object at the top of a stack ends the walk: what read the Object (the
 *  scene) takes scene objects, not the data the stack carries, and offering it the data
 *  refused the whole delete. A surviving consumer is preferred to a deleted one, so a stack
 *  two Objects share is spliced into the one that stays. */
function survivingConsumerAbove(
  state: DagState,
  readers: ReadonlyMap<NodeId, Reader[]>,
  wrapperId: NodeId,
  idSet: Set<NodeId>,
): { node: string; socket: string } | null {
  let cursor: NodeId = wrapperId;
  const guard = new Set<NodeId>();
  while (!guard.has(cursor)) {
    guard.add(cursor);
    const consumers = outConsumers(readers, cursor);
    const surviving = consumers.find((c) => !idSet.has(c.node));
    if (surviving) return surviving;
    const above = consumers.find(
      (c) => isTargetWrapperNode(state.nodes[c.node]) && spineOf(state.nodes[c.node]) === c.socket,
    );
    if (!above) return null;
    cursor = above.node; // a deleted wrapper on the same stack — hop over it
  }
  return null;
}

/**
 * `ids` reordered so every node comes AFTER the nodes in `idSet` that read it (#1621).
 *
 * A wire from one deleted node into another is not disconnected ("its own removeNode covers
 * it"), which holds only when the reader is removed first: `removeNode` refuses a node whose
 * output is still read. The ids a caller passes arrive in selection order, so a child picked
 * before its parent used to refuse the whole delete. Otherwise the given order is kept, so a
 * batch that was already safe emits the ops it always did.
 */
function consumersFirst(
  state: DagState,
  ids: readonly NodeId[],
  idSet: ReadonlySet<NodeId>,
): NodeId[] {
  const readers = new Map<NodeId, NodeId[]>();
  for (const id of ids) {
    for (const binding of Object.values(state.nodes[id]?.inputs ?? {})) {
      for (const ref of refsOf(binding)) {
        if (!ref?.node || !idSet.has(ref.node)) continue;
        const list = readers.get(ref.node);
        if (list) list.push(id);
        else readers.set(ref.node, [id]);
      }
    }
  }
  const out: NodeId[] = [];
  const placed = new Set<NodeId>();
  const place = (id: NodeId) => {
    if (placed.has(id)) return;
    placed.add(id); // wires cannot form a loop (`connect` refuses one), so this only dedupes
    for (const reader of readers.get(id) ?? []) place(reader);
    out.push(id);
  };
  for (const id of ids) place(id);
  return out;
}

/**
 * Ops to delete `ids` in one atomic batch (→ one undo). `removeNode` refuses to
 * remove a node whose output is still consumed, so every consumer edge into a
 * deleted node is disconnected FIRST (consumers also being deleted are skipped —
 * their own removeNode handles them). Mirrors the long-standing Delete-key path,
 * now shared so the context menu can't drift from it.
 */
export function buildDeleteNodesOps(state: DagState, ids: readonly NodeId[]): Op[] {
  const idSet = new Set<NodeId>(ids);
  const readers = readersIndex(state);
  const allIds = [...idSet];

  // ── Direction 1: what the deleted nodes OWN, through edges. ──────────────────
  // #365 — a split Object OWNS its BoxData through `data`. #431 — a Group OWNS its
  // `children`: delete means delete, and getting objects OUT of a group is a
  // different verb (drag-reparent, SceneTree.tsx:512). Left behind, either one
  // survives in the file while unreachable from `scene` — invisible, unrenderable,
  // unrecoverable through the UI, and growing the save every time.
  //
  // `target` is deliberately NOT owned here even though OWNED_SOCKETS below lists
  // it for duplicate: that socket is the WRAPPER road (Transform/MaterialOverride/
  // modifiers), where deleting the wrapper must not delete the mesh it wraps — it
  // needs a splice-out instead. Tracked as #432; duplicate and delete genuinely
  // differ on it, exactly as Blender's Shift+D and X differ.
  //
  // Both are guarded on EXCLUSIVITY: a shared node (another surviving consumer
  // still points at it) stays, and removeNode would refuse it anyway. Walked to a
  // fixpoint so a group inside a group goes all the way down, and appended
  // PARENT-BEFORE-CHILD so each removeNode runs once its consumer is gone
  // (removeNode refuses while an output is still consumed).
  //
  // #1620 — ownership carries on DOWN THE STACK. An Object's `data` names the TOP of its
  // operator stack (#415), so stopping there took the top modifier and left the rest of the
  // stack and the base data behind, for the splice below to hand to the scene. A node reached
  // as OWNED also owns what it reads on its declared spine (`stackSocketOf`), under the same
  // exclusivity guard, which is the walk the agent's closure already makes for `data`
  // (`socketCarriesKind`, src/agent/closure/expand.ts). A wrapper the caller asked to delete
  // is NOT reached as owned unless a deleted owner holds it, so deleting a modifier on its own
  // still keeps the mesh and splices. Run to a fixpoint, because a wrapper named by the caller
  // becomes owned only once its Object is known to be going too.
  // #1560 — WHICH wires own is read off the socket (`wireOwnership`), not listed here. The two
  // names this used to carry (`children`, `data`) are now what Object and Group declare, beside
  // an armature Object's `pose`, a driver's `in` and the operands of the compute nodes behind
  // it; a pose layer's `pose` is a stack like an operator's spine. And a BODY socket takes the
  // whole sub-network behind it: a node inside feeds nothing but that sub-network and its
  // owner (#1547), so once the owner goes nothing can read it.
  const reachedAsOwned = new Set<NodeId>();
  const take = (id: NodeId) => {
    reachedAsOwned.add(id);
    if (idSet.has(id)) return;
    idSet.add(id);
    allIds.push(id); // appended → the loop below keeps walking into it
  };
  // "Nothing else uses it" counts a REFERENCE as a use too (#1560): a compute node that lost its
  // last wire but whose spare param another driver still reads is still in use, and taking it
  // would silently clear that driver's source. Only an 'argument' reference counts. A 'subject'
  // one is a sidecar of the node (its own channel), which goes with it and keeps nothing alive.
  const namedBy = buildIdRefIndex(state.nodes);
  const isStillNamed = (id: NodeId) =>
    (namedBy.get(id) ?? []).some((referrerId) => {
      const referrer = state.nodes[referrerId];
      return !!referrer && !idSet.has(referrerId) && idRefsByRole(referrer).argument.includes(id);
    });
  const takeOwned = () => {
    for (let changed = true; changed; ) {
      changed = false;
      for (let i = 0; i < allIds.length; i++) {
        const owner = state.nodes[allIds[i]];
        if (!owner) continue;
        for (const [socket, binding] of Object.entries(owner.inputs ?? {})) {
          const kind = wireOwnership(owner.type, socket);
          if (kind === 'body') {
            for (const inside of subnetworkOf(state, owner.id)) {
              if (reachedAsOwned.has(inside) || !state.nodes[inside]) continue;
              take(inside);
              changed = true;
            }
            continue;
          }
          if (kind !== 'always' && !(kind === 'stack' && reachedAsOwned.has(owner.id))) continue;
          for (const ref of refsOf(binding)) {
            const ownedId = ref?.node;
            if (!ownedId || reachedAsOwned.has(ownedId) || !state.nodes[ownedId]) continue;
            // #1628 — a collection listing it as a member is not a reader: left to count, every
            // child of a deleted group that sat in a collection stayed in the file, undrawn.
            const hasSurvivingConsumer = (readers.get(ownedId) ?? []).some(
              (r) => !idSet.has(r.node) && !isMembershipWire(state, r.node, r.socket),
            );
            if (hasSurvivingConsumer || isStillNamed(ownedId)) continue;
            take(ownedId);
            changed = true;
          }
        }
      }
    }
  };

  // ── Direction 2: the id-reference universe (params, not edges). ──────────────
  // [[H136]] a free-floating KeyframeChannel names its target via `params.target`,
  // NOT an edge, so the consumer walk below is blind to it — and so is removeNode's
  // "still consumed by" guard (ops.ts:143). Channels were only ever the FIRST of
  // that family; constraints, drivers and NLA strips ride the same edge-less road
  // (#421). One shared walker over what each node type DECLARES (`idRefs`), so the
  // next node kind is covered by declaring a field rather than by remembering to
  // edit this site. Runs AFTER the owned GC above so a channel bound to a GC'd
  // BoxData — or to a group's deleted child — is caught too.
  //
  // #1560 — the two directions feed each other, so they run in turn until neither adds a node.
  // A driver is swept with the cube it drives, and only then is it known that the Solver wired
  // into that driver has lost its last reader; the Solver's sub-network follows in the next turn.
  let sweep: ReturnType<typeof idRefSweep>;
  let grew: boolean;
  do {
    takeOwned();
    sweep = idRefSweep(state.nodes, allIds);
    grew = false;
    for (const sweptId of sweep.remove) {
      if (!idSet.has(sweptId)) {
        idSet.add(sweptId);
        allIds.push(sweptId);
        grew = true;
      }
    }
  } while (grew);

  // Clearing the surviving 'argument' refs (an aim target, a followed curve, a
  // controller) comes FIRST: those nodes outlive this delete, and the clear is what
  // keeps them from pointing at a missing id. Then, per node: disconnect its surviving
  // consumer edges, then removeNode. The id-reference universe needs no removeNode
  // ordering here — the batch's FINAL state is whole (every referrer was swept or
  // cleared above), and #435's dangle guard is a final-state check at the commit
  // chokepoint, not a per-op one (see `findDanglingIdRef`).
  // #397 — a deleted collection hands its members and nested collections to the collections it
  // sat in, as Blender's Delete does, before it goes.
  const ops: Op[] = [...sweep.ops, ...collectionDeleteRelinkOps(state, idSet)];
  for (const nodeId of consumersFirst(state, allIds, idSet)) {
    for (const reader of readers.get(nodeId) ?? []) {
      if (idSet.has(reader.node)) continue; // being deleted too — its removeNode covers it
      ops.push({
        type: 'disconnect',
        from: { node: nodeId, socket: reader.fromSocket },
        to: { node: reader.node, socket: reader.socket },
      });
    }
    ops.push({ type: 'removeNode', nodeId });
  }

  // ── Direction 3: splice deleted WRAPPERS out (#432). ─────────────────────────
  // A wrapper (Transform / MaterialOverride / Array / Mirror modifier / ColorCorrect)
  // sits ON the edge chain — `scene → wrapper → subject` — so plain-removing it above
  // strands the subject: nothing consumes it, and it vanishes from `scene` while
  // staying in the file (the #431 strand, but for the WRAPPED node not a child).
  // `target` is deliberately not OWNED (deleting a mirror must not delete the mesh —
  // Blender keeps the object when a modifier is removed); the right move is to
  // reconnect the subject to whatever consumed the wrapper. Sibling of
  // `buildRemoveOperatorOps` (operatorStack.ts), which splices ONE wrapper for the
  // modifier-stack ✕; this covers the generic delete path and a whole stack deleted
  // at once (survivingConsumerAbove hops over the other deleted wrappers).
  //
  // Emitted AFTER every disconnect+removeNode above, so: (a) the wrapper's own
  // `target` edge is already gone, and (b) when the surviving consumer is another
  // wrapper's single-cardinality `target`, that socket is free before we bind the
  // subject — disconnect-before-connect, matching buildRemoveOperatorOps.
  for (const nodeId of allIds) {
    const node = state.nodes[nodeId];
    if (!isTargetWrapperNode(node)) continue;
    // The SUBJECT rides the spine. Reading it by the name `target` would, on a wrapper
    // with a second same-typed input, be a coin-flip between the subject and an
    // argument — and reconnecting the wrong one is a silent rewire (#396).
    const subject = refsOf(node!.inputs?.[spineOf(node)!])[0];
    // Subject also being deleted → nothing to keep alive.
    if (!subject?.node || idSet.has(subject.node)) continue;
    const consumer = survivingConsumerAbove(state, readers, nodeId, idSet);
    if (!consumer) continue;
    ops.push({
      type: 'connect',
      from: { node: subject.node, socket: subject.socket },
      to: { node: consumer.node, socket: consumer.socket },
    });
  }
  return ops;
}

/** A fresh node id derived from `base`, guaranteed absent from `taken` (and added
 *  to it so successive calls don't collide). Deterministic → the duplicate builder
 *  is unit-testable without Date.now()/Math.random(). */
function freshId(base: string, taken: Set<string>): string {
  let id = `${base}_copy`;
  let n = 1;
  while (taken.has(id)) {
    n += 1;
    id = `${base}_copy${n}`;
  }
  taken.add(id);
  return id;
}

/** The sockets the duplicate walk FOLLOWS to gather the subtree — i.e. the nodes a
 *  clone OWNS and therefore deep-copies (Blender Shift+D duplicates the object AND
 *  its data). A Group aggregates `children`; Transform/MaterialOverride wrap a single
 *  `target`; a split Object (#365) owns its geometry/material through `data`. Any
 *  OTHER input (a shared material node, a geometry source) is NOT followed — it stays
 *  shared by the clone (re-pointed to the same original node). Without `data` here a
 *  duplicated split Object would keep pointing at the ORIGINAL BoxData (a linked copy:
 *  recolour one, both change) — not the independent copy Shift+D promises. */
const OWNED_SOCKETS = ['children', 'target', 'data'];

function refsOf(binding: unknown): { node: string; socket: string }[] {
  if (Array.isArray(binding)) return binding as { node: string; socket: string }[];
  return binding ? [binding as { node: string; socket: string }] : [];
}

/**
 * Ops to DUPLICATE the scene subtree rooted at `rootId` (Blender Shift-D): deep-copy
 * the node + its OWNED descendants (children / wrapper target / a split Object's `data`
 * node) with fresh ids, re-wire the internal edges among the clones, keep every OTHER
 * (non-owned) input shared with the original, and connect the new root as a sibling
 * right AFTER the original.
 * Returns the ops (one atomic → one undo) + the new root id to select, or null when
 * the node isn't a wired scene child (nothing to duplicate-as-sibling).
 *
 * Undo-safe order: addNode all clones (empty inputs) → connect internal edges →
 * connect root to parent. The reverse (disconnect edges, then removeNode) never hits
 * the "removeNode refuses while consumed" rule. `meta` is intentionally NOT copied —
 * addNode carries none, and a duplicate showing its own id avoids two nodes claiming
 * the same explicit name (Blender's `.001` suffix is a documented non-goal).
 */
export function buildDuplicateNodeOps(
  state: DagState,
  rootId: NodeId,
  /**
   * Optional id-space to reserve across calls. `buildDuplicateNodeOps` is
   * single-root and mints fresh `_copy` ids from `state.nodes` alone, so two
   * back-to-back calls against the SAME state (e.g. the agent duplicating
   * `['a','b']` at once) can independently pick the same `_copy` id and
   * collide. Pass one shared Set across the batch: every id this call mints is
   * added to it, and every id already in it is treated as taken. UI callers
   * (one root per Shift-D) omit it and are unaffected.
   */
  reserved?: Set<NodeId>,
): { ops: Op[]; newRootId: NodeId } | null {
  if (!state.nodes[rootId]) return null;

  // 1. The parent edge to clone the new root beside (first consumer of rootId).
  let parent: { node: string; socket: string; fromSocket: string; index: number } | null = null;
  for (const [consumerId, consumer] of Object.entries(state.nodes)) {
    for (const [socket, binding] of Object.entries(consumer.inputs)) {
      const refs = refsOf(binding);
      for (let i = 0; i < refs.length; i++) {
        if (refs[i]?.node === rootId && !parent) {
          parent = { node: consumerId, socket, fromSocket: refs[i].socket, index: i };
        }
      }
    }
  }
  if (!parent) return null;

  // 2. Subtree = root + hierarchy descendants (DFS over children/target).
  const subtree: NodeId[] = [];
  const seen = new Set<NodeId>();
  const visit = (id: NodeId) => {
    if (seen.has(id)) return;
    const node = state.nodes[id];
    if (!node) return;
    seen.add(id);
    subtree.push(id);
    for (const socket of OWNED_SOCKETS) {
      for (const ref of refsOf(node.inputs[socket])) if (ref?.node) visit(ref.node);
    }
  };
  visit(rootId);

  // 3. Fresh ids for every clone. Seed with any ids a prior call in this batch
  //    already reserved so a multi-target duplicate can't mint colliding _copy ids.
  const taken = new Set<NodeId>(Object.keys(state.nodes));
  if (reserved) for (const id of reserved) taken.add(id);
  const idMap = new Map<NodeId, NodeId>();
  for (const id of subtree) idMap.set(id, freshId(id, taken));

  const ops: Op[] = [];
  // 4. addNode clones (empty inputs — edges are separate connect ops, undo-safe).
  for (const id of subtree) {
    const node = state.nodes[id];
    ops.push({
      type: 'addNode',
      nodeId: idMap.get(id)!,
      nodeType: node.type,
      params: structuredClone(node.params),
    });
  }
  // 5. Re-wire EVERY input edge of each clone: a ref into the subtree points to the
  //    matching clone; any other ref stays shared with the original.
  for (const id of subtree) {
    const node = state.nodes[id];
    for (const [socket, binding] of Object.entries(node.inputs)) {
      const refs = refsOf(binding);
      const isList = Array.isArray(binding);
      for (let i = 0; i < refs.length; i++) {
        const ref = refs[i];
        if (!ref?.node) continue;
        ops.push({
          type: 'connect',
          from: { node: idMap.get(ref.node) ?? ref.node, socket: ref.socket },
          to: { node: idMap.get(id)!, socket },
          ...(isList ? { index: i } : {}),
        });
      }
    }
  }
  // 6. Wire the clone root as a sibling immediately after the original.
  ops.push({
    type: 'connect',
    from: { node: idMap.get(rootId)!, socket: parent.fromSocket },
    to: { node: parent.node, socket: parent.socket },
    index: parent.index + 1,
  });
  // #1453 — each copy joins the collections its original is in, as Blender's Shift+D links a
  // duplicate into its source's collections. Membership only: where it hangs is step 6's.
  for (const [sourceId, cloneId] of idMap)
    for (const c of collectionsHolding(state, sourceId)) ops.push(...membershipOps(c, [cloneId]));

  // 7. The id-reference universe (#434). A node OWNED BY a cloned node names its
  //    subject in params ([[H136]]), NOT via an edge, so the hierarchy walk above
  //    missed all of it — a keyframe channel, a Track-To / Follow-Path constraint, a
  //    param driver, an NLA strip. This was CHANNELS-ONLY before #434, so the copy of
  //    a constrained object silently lost its constraint. Now it clones every SUBJECT
  //    referrer and remaps every id it holds through `idMap`: the subject ref lands on
  //    the clone, while an argument ref (an aim target, a followed curve, a played
  //    Action) stays shared with the original unless that target was itself cloned —
  //    the exact rule step 5 applies to wired edges.
  //
  //    Fresh ids for ALL referrers first, so remap is order-independent and a strip's
  //    Track-membership pass below can find the clone.
  const referrers = subjectReferrersInto(state.nodes, seen);
  for (const r of referrers) idMap.set(r.id, freshId(r.id, taken));
  for (const r of referrers) {
    const cloneId = idMap.get(r.id)!;
    ops.push({
      type: 'addNode',
      nodeId: cloneId,
      nodeType: r.type,
      params: remapIdRefs(r, (id) => idMap.get(id) ?? id),
    });
    // A ParamDriver carries a WIRED source edge (`in`); rewire it like any
    // other input — shared with the original unless it fell inside the clone. The
    // pure-sidecar referrers (channels, constraints, strips) have `inputs: {}`, so
    // this loop is empty for them.
    for (const [socket, binding] of Object.entries(r.inputs)) {
      for (const ref of refsOf(binding)) {
        if (!ref?.node) continue;
        ops.push({
          type: 'connect',
          from: { node: idMap.get(ref.node) ?? ref.node, socket: ref.socket },
          to: { node: cloneId, socket },
        });
      }
    }
  }

  // 8. A Strip is only active through its Track's `strips` list (the resolver reaches
  //    strips only via tracks — Track.strips is the single route to a Strip). A cloned
  //    strip that no track lists is inert debris, so append each to every track that
  //    listed its original — the duplicate plays in the same NLA arrangement as its
  //    source. Whole-array replace (Track.strips is one value-typed param), matching
  //    how addStrip appends.
  for (const [id, node] of Object.entries(state.nodes)) {
    if (node.type !== 'Track') continue;
    const strips = ((node.params as { strips?: string[] }).strips ?? []) as string[];
    const additions = strips.filter((s) => idMap.has(s)).map((s) => idMap.get(s)!);
    if (additions.length === 0) continue;
    ops.push({
      type: 'setParam',
      nodeId: id,
      paramPath: 'strips',
      value: [...strips, ...additions],
    });
  }

  // Publish every id this call minted (subtree clones + referrer clones, all in
  // idMap's values) so a subsequent call in the same batch won't reuse them.
  if (reserved) for (const cloneId of idMap.values()) reserved.add(cloneId);

  return { ops, newRootId: idMap.get(rootId)! };
}
