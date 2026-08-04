// materialLink — the data-block row's op-builders: point a node's `material` socket at a
// Material node, mint a new one, or unlink back to the authored param (#394 S3d-c).
//
// This is Blender's material data-block row — the pointer field with New / unlink and the
// user count beside it — expressed the way Basher already spells assignment: as an EDGE.
//
// ── WHY THE PICKER IS NOT A `refParams` POINTER ────────────────────────────────────
//
// PLAN-2 §3 proposed one, and `SetMaterialOp.ts` already measured why it does not fit:
// `applyRemoveNode` refuses to delete a node still consumed as an input, so an edge
// cannot dangle by construction (the dangling-ref sweep exists for id-STRING refs), and
// the data node's material is ALREADY an edge, so the picker has to drive
// `connect`/`disconnect` regardless. A pointer would mint a SECOND way to say "point at
// a Material" — the exact drift the one-composer rule exists to stop, in the assignment
// vocabulary instead of the composition one. So the picker reuses the LIST resolver's
// shape (a candidate list, sorted, labelled) and none of its storage.
//
// ── THE ONE THING THAT WOULD SILENTLY FAIL, AND WHY THE BUILDER EXISTS ─────────────
//
// The `material` socket is `cardinality: 'list'`, and `applyConnect` APPENDS to a list
// binding (`ops.ts:229-233`). So connecting a second Material to an already-linked node
// produces `[old, new]` — and `materialSocket` reads ENTRY 0, which is still the old one.
// Picking a new material would report success, change the graph, and draw the previous
// material forever. Every link here therefore disconnects first, in ONE atomic op list,
// which is also what makes it a single undo step.
//
// ── "NEW MATERIAL" IS VALUE-PRESERVING, WHICH DIVERGES FROM BLENDER ON PURPOSE ─────
//
// Blender's New button mints a default grey material, because a slot with no material is
// the normal starting point there. In Basher the data node ALWAYS has an authored
// material already — it is a param, not an empty slot — so minting a default would
// discard the user's work at the exact moment they asked to make it shareable. The new
// node is seeded with whatever the node currently resolves to, so clicking New changes
// nothing on screen and everything in the graph. The unlink direction has the matching
// property and it is already proven: disconnecting restores the authored param untouched
// (`materialSocket.test.ts`), which is what makes the base a fallback rather than dead
// state, and therefore what keeps its rows editable.
//
// REF: src/nodes/materialSocket.ts (the socket-supersedes-param rule + the entry-0 read);
//      src/core/dag/ops.ts (list-cardinality connect APPENDS; removeNode refuses while
//      consumed); src/nodes/Material.ts; src/app/nodeRefCandidates.ts (the candidate-list
//      shape this mirrors without reusing its storage); src/app/MaterialLinkControls.tsx
//      (the only UI caller). Issues #394, #510.

import { getNodeType } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';
import type { Node, Op } from '../core/dag/types';
import { nodeDisplayName } from './sceneTreeWalk';
import { hydrateInlineMaterial } from '../nodes/materialSchema';

const MATERIAL = 'material';
const OUT = 'out';

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Does this node take its material over an edge?
 *
 * Asked of the REGISTRY, never of a node-type list: a `material` input declared as the
 * `'Material'` socket is exactly the possession that makes the data-block row meaningful,
 * and a node gaining one gets the row the day it lands. Today that is `BoxData`,
 * `SphereData` and `SetMaterialOp`; `BakedData` has no such socket and correctly gets no
 * row, which a type list would have had to remember.
 */
export function hasMaterialSocket(state: DagState, nodeId: string): boolean {
  const node = state.nodes[nodeId];
  if (!node) return false;
  return getNodeType(node.type)?.inputs?.[MATERIAL]?.type === 'Material';
}

/** Every ref bound to `nodeId`'s `material` socket, in binding order. */
function materialRefs(node: Node | undefined): { node: string; socket: string }[] {
  const binding = node?.inputs?.[MATERIAL];
  if (!binding) return [];
  return Array.isArray(binding) ? [...binding] : [binding];
}

/**
 * The Material node currently supplying `nodeId`, or null when nothing is connected.
 *
 * ENTRY 0, deliberately, because that is the entry `resolveNodeMaterial` reads. A surface
 * that reported a different entry than the renderer consumes would be the covered-value
 * defect in its purest form: the row would name a material the viewport is not drawing.
 */
export function resolveMaterialLink(state: DagState, nodeId: string): string | null {
  const first = materialRefs(state.nodes[nodeId])[0];
  return first && state.nodes[first.node] ? first.node : null;
}

/** One entry in the material picker. */
export interface MaterialCandidate {
  readonly id: string;
  readonly label: string;
}

/**
 * Every Material node in the graph, sorted by label for a stable picker.
 *
 * Derived from the registry (does the node emit the `'Material'` socket?) rather than
 * from `node.type === 'Material'`, so a future second material producer — a shader
 * subgraph, an imported library material — joins the picker without editing this.
 *
 * ⚠️ DECLARED LIMIT: an unnamed Material shows its ID, because `nodeDisplayName` reads
 * `meta.name` and nothing seeds one at creation. That is the repo's convention rather
 * than a gap here — `buildDuplicateNodeOps` states it explicitly, and Blender's `.001`
 * suffixing is a documented non-goal — so a material is named the way every other node
 * is named: by renaming it. The IR carries its own `material.name`, which glTF import
 * populates; wiring that into the display name would be a SECOND naming authority, and
 * nothing mints a Material from glTF yet, so it is deliberately not done here.
 */
export function materialCandidates(state: DagState): MaterialCandidate[] {
  const out: MaterialCandidate[] = [];
  for (const node of Object.values(state.nodes)) {
    if (getNodeType(node.type)?.outputs?.[OUT]?.type !== 'Material') continue;
    out.push({ id: node.id, label: nodeDisplayName(node) });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

/**
 * How many nodes consume this Material — Blender's user count on the data-block row.
 *
 * Counts CONSUMING NODES, not edges: a node that somehow bound the same material twice
 * is one user, because the number answers "who would be affected if I edit this?" and
 * that is a question about nodes. Derived, never written to — the surface makes the
 * number CLICKABLE above one user (#536 S5), but the click dispatches
 * `buildNewMaterialOps` and the count follows the graph, as it always has.
 */
export function materialUserCount(state: DagState, materialNodeId: string): number {
  let users = 0;
  for (const node of Object.values(state.nodes)) {
    const bound = Object.values(node.inputs).some((binding) => {
      const refs = Array.isArray(binding) ? binding : binding ? [binding] : [];
      return refs.some((r) => r.node === materialNodeId);
    });
    if (bound) users++;
  }
  return users;
}

/** Disconnect every ref currently on `nodeId`'s material socket. The shared half of
 *  link and unlink — see the header on why a link that skips this draws the old
 *  material forever. */
function disconnectAll(state: DagState, nodeId: string): Op[] {
  return materialRefs(state.nodes[nodeId]).map((ref) => ({
    type: 'disconnect' as const,
    from: { node: ref.node, socket: ref.socket },
    to: { node: nodeId, socket: MATERIAL },
  }));
}

/**
 * Point `nodeId`'s material socket at `materialNodeId`, replacing whatever was there.
 * Null when either node is missing, when the consumer has no material socket, or when
 * the producer is not a material producer — the offer must not be able to build a graph
 * `connect` would refuse.
 */
export function buildLinkMaterialOps(
  state: DagState,
  nodeId: string,
  materialNodeId: string,
): Op[] | null {
  if (!hasMaterialSocket(state, nodeId)) return null;
  const producer = state.nodes[materialNodeId];
  if (!producer || getNodeType(producer.type)?.outputs?.[OUT]?.type !== 'Material') return null;
  // Re-picking the material already linked is a no-op rather than a disconnect/reconnect
  // pair: it would otherwise burn an undo step that changes nothing.
  if (
    resolveMaterialLink(state, nodeId) === materialNodeId &&
    materialRefs(state.nodes[nodeId]).length === 1
  ) {
    return null;
  }
  return [
    ...disconnectAll(state, nodeId),
    {
      type: 'connect',
      from: { node: materialNodeId, socket: OUT },
      to: { node: nodeId, socket: MATERIAL },
    },
  ];
}

/**
 * Unlink — drop the edge and fall back to the authored param.
 *
 * The param is deliberately NOT written here. It was never overwritten while the socket
 * was connected (the socket supersedes, it does not migrate), so it is already the value
 * the surface will show and the renderer will draw. Writing it would be the same edit
 * twice, and the second one could differ.
 */
export function buildUnlinkMaterialOps(state: DagState, nodeId: string): Op[] | null {
  if (!hasMaterialSocket(state, nodeId)) return null;
  const ops = disconnectAll(state, nodeId);
  return ops.length > 0 ? ops : null;
}

/**
 * Mint a Material node carrying what `nodeId` currently resolves to, and link it.
 *
 * Value-preserving by construction — see the header. The seed goes through
 * `hydrateInlineMaterial`, the same seam every other material source uses, so the new
 * node holds a COMPLETE IR and no consumer has to ask whether a lobe is present.
 */
export function buildNewMaterialOps(
  state: DagState,
  nodeId: string,
  explicitId?: string,
): { ops: Op[]; materialNodeId: string } | null {
  if (!hasMaterialSocket(state, nodeId)) return null;
  const node = state.nodes[nodeId];
  if (!node) return null;

  // Seed from what is on screen NOW: the linked material if there is one, else this
  // node's own authored param. Both go through the one hydrate seam.
  const linkedId = resolveMaterialLink(state, nodeId);
  const source = linkedId
    ? (state.nodes[linkedId]?.params as { material?: unknown } | undefined)?.material
    : (node.params as { material?: unknown }).material;

  const materialNodeId = explicitId ?? newId('mat');
  return {
    ops: [
      {
        type: 'addNode',
        nodeId: materialNodeId,
        nodeType: 'Material',
        params: { material: hydrateInlineMaterial(source) },
      },
      ...disconnectAll(state, nodeId),
      {
        type: 'connect',
        from: { node: materialNodeId, socket: OUT },
        to: { node: nodeId, socket: MATERIAL },
      },
    ],
    materialNodeId,
  };
}
