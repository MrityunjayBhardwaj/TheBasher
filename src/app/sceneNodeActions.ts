// Shared scene-node action op-builders (#227). ONE authority for the ops that
// delete (and later duplicate) scene nodes, so the keyboard shortcut, the outliner
// context menu, and any future surface all dispatch the SAME ops — the "one write
// authority, N callers" shape (cf. V65 select handler, V69 rename op). Pure: a
// function of (state, ids) → Op[]; the caller dispatches + manages selection.

import type { DagState } from '../core/dag/state';
import type { Node, NodeId, Op } from '../core/dag/types';
import { getNodeType } from '../core/dag/registry';
import { idRefSweep, subjectReferrersInto, remapIdRefs } from '../core/dag/idRefSweep';

/**
 * #432 — a WRAPPER node consumes its subject through a `target` EDGE and re-exposes
 * it via `out`: Transform, MaterialOverride, ArrayModifier, MirrorModifier,
 * ColorCorrect. Derived from the registry (declares BOTH a `target` input and an
 * `out` output), NOT a hardcoded type list — a new wrapper is covered by declaring
 * those sockets, and the id-reference nodes (KeyframeChannel / TrackTo / … name their
 * target in `params.target`, no edge) plus any future edge-`target` constraint (no
 * `out`) are correctly excluded.
 */
function isTargetWrapperNode(node: Node | undefined): boolean {
  if (!node) return false;
  const def = getNodeType(node.type);
  return !!def && 'target' in def.inputs && 'out' in def.outputs;
}

/** First node+input-socket consuming `(producerId, 'out')`, or null. Linear-chain
 *  model — a wrapper has one `out` consumer (fan-out is outside v1 scope). */
function outConsumer(state: DagState, producerId: NodeId): { node: string; socket: string } | null {
  for (const [cid, c] of Object.entries(state.nodes)) {
    for (const [socket, binding] of Object.entries(c.inputs)) {
      for (const ref of refsOf(binding)) {
        if (ref?.node === producerId && ref?.socket === 'out') return { node: cid, socket };
      }
    }
  }
  return null;
}

/** The nearest SURVIVING consumer above `wrapperId`, hopping over any wrappers that
 *  are themselves being deleted — so deleting a whole stack (scene → Mirror → Array →
 *  mesh) still splices the surviving base back to the surviving consumer (scene). */
function survivingConsumerAbove(
  state: DagState,
  wrapperId: NodeId,
  idSet: Set<NodeId>,
): { node: string; socket: string } | null {
  let cursor: NodeId = wrapperId;
  const guard = new Set<NodeId>();
  while (!guard.has(cursor)) {
    guard.add(cursor);
    const c = outConsumer(state, cursor);
    if (!c) return null;
    if (!idSet.has(c.node)) return c;
    cursor = c.node; // consumer is also being deleted — hop over it
  }
  return null;
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
  const OWNED_ON_DELETE = ['children', 'data'] as const;
  for (let i = 0; i < allIds.length; i++) {
    const owner = state.nodes[allIds[i]];
    if (!owner) continue;
    for (const socket of OWNED_ON_DELETE) {
      for (const ref of refsOf(owner.inputs?.[socket])) {
        const ownedId = ref?.node;
        if (!ownedId || idSet.has(ownedId) || !state.nodes[ownedId]) continue;
        const hasSurvivingConsumer = Object.entries(state.nodes).some(
          ([cid, c]) =>
            !idSet.has(cid) &&
            Object.values(c.inputs).some((b) => refsOf(b).some((r) => r?.node === ownedId)),
        );
        if (!hasSurvivingConsumer) {
          idSet.add(ownedId);
          allIds.push(ownedId); // appended → this loop keeps walking into it
        }
      }
    }
  }

  // ── Direction 2: the id-reference universe (params, not edges). ──────────────
  // [[H136]] a free-floating KeyframeChannel names its target via `params.target`,
  // NOT an edge, so the consumer walk below is blind to it — and so is removeNode's
  // "still consumed by" guard (ops.ts:143). Channels were only ever the FIRST of
  // that family; constraints, drivers and NLA strips ride the same edge-less road
  // (#421). One shared walker over what each node type DECLARES (`idRefs`), so the
  // next node kind is covered by declaring a field rather than by remembering to
  // edit this site. Runs AFTER the owned GC above so a channel bound to a GC'd
  // BoxData — or to a group's deleted child — is caught too.
  const sweep = idRefSweep(state.nodes, allIds);
  for (const sweptId of sweep.remove) {
    if (!idSet.has(sweptId)) {
      idSet.add(sweptId);
      allIds.push(sweptId);
    }
  }

  // Clearing the surviving 'argument' refs (an aim target, a followed curve, a
  // controller) comes FIRST: those nodes outlive this delete, and the clear is what
  // keeps them from pointing at a missing id. Then, per node: disconnect its surviving
  // consumer edges, then removeNode. The id-reference universe needs no removeNode
  // ordering here — the batch's FINAL state is whole (every referrer was swept or
  // cleared above), and #435's dangle guard is a final-state check at the commit
  // chokepoint, not a per-op one (see `findDanglingIdRef`).
  const ops: Op[] = [...sweep.ops];
  for (const nodeId of allIds) {
    for (const [consumerId, consumer] of Object.entries(state.nodes)) {
      if (idSet.has(consumerId)) continue; // being deleted too — its removeNode covers it
      for (const [socketName, binding] of Object.entries(consumer.inputs)) {
        const refs = Array.isArray(binding) ? binding : binding ? [binding] : [];
        for (const ref of refs) {
          if (ref && ref.node === nodeId) {
            ops.push({
              type: 'disconnect',
              from: { node: nodeId, socket: ref.socket },
              to: { node: consumerId, socket: socketName },
            });
          }
        }
      }
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
    const subject = refsOf(node!.inputs?.target)[0];
    // Subject also being deleted → nothing to keep alive.
    if (!subject?.node || idSet.has(subject.node)) continue;
    const consumer = survivingConsumerAbove(state, nodeId, idSet);
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
    // A ParamDriver carries a WIRED source edge (`in` / `inVec`); rewire it like any
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
