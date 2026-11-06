// sceneMembership — the ONE list of the wires that put a thing in the scene (#1820).
//
// Rule 3 of docs/GRAPH.md says membership is reachability: a thing is in the scene if the
// scene's wires reach it. Until this module, nothing listed which wires those are. The renderer
// answered by what `Scene.evaluate` reads, the outliner by its own walk (`sceneTreeWalk.ts`), and
// the rule by a hand-written list that left out `lightRig` (#1820 measured three disagreements).
// Rule 3 now quotes this file, and `sceneMembership.test.ts` fails when the two drift apart.
//
// TWO LISTS, because the code is mid-move (stack-view epic #1805, decided on #1808):
//
//   MEMBERSHIP_WIRES  — the wires that mean "in the scene" once parenting stops doing that job.
//                       Membership is collections, as in Blender, plus the scene's camera and
//                       lights. Parenting is not on it: a child takes its parent as an input
//                       (#1810), and where an object sits in the tree says nothing about whether
//                       the scene holds it, as a Blender object's parent and its collections are
//                       separate.
//
//   TRANSITIONAL_MEMBERSHIP_WIRES — wires that ALSO put things in the scene today and stop when
//                       #1810 (parent inputs), #1823 (the scene draws its collections) and #1824
//                       (old files convert) land. Today `Scene.children` is what the renderer
//                       draws, and every parenting wire (`sceneHierarchy.ts`: a Group's or an
//                       Object's `children`, a Transform's or MaterialOverride's chain input)
//                       carries its child into the scene with it.
//
// `drawnToday` says whether the renderer reaches a wire now. The collection wires are listed but
// not drawn: a collection member is drawn only because it is also in `Scene.children`
// (`Scene.ts`, the `collections` input). #1823 turns them on; a reader that asks "is it drawn?"
// rather than "is it in the scene?" must read this flag, not assume it.
//
// The parenting wires are not restated here. They are defined once in `sceneHierarchy.ts`
// (`hierarchySocketsOf`), whose sockets come partly from node declarations (a wrapper's chain
// input), so a copy here would be a second definition that nothing checks.
//
// THE ANSWER (#1821). `isInScene(state, id)` walks these wires out from the scene output, plus the
// parenting wires below anything it reaches. It follows a wire only when `drawnToday` is set, so
// "in the scene" means what the renderer reaches, and the collection wires join every surface at
// once when #1823 sets their flag. A LightProfileSelect is followed to its selected rig only: the
// other profiles' lights are not drawn and the outliner does not list them. A CameraSelect is
// followed to every camera it lists, as Blender holds every camera object, active or not.
//
// REF: docs/GRAPH.md §4 rule 3; src/nodes/Scene.ts (`inputs`); src/app/sceneTreeWalk.ts (the
//      outliner's walk); src/app/sceneHierarchy.ts (the parenting wires); #1519, #1820, #1821.

import { applyOps } from '../core/dag/ops';
import type { DagState } from '../core/dag/state';
import type { NodeRef, Op } from '../core/dag/types';
import { wiredProfileRigs } from '../nodes/LightProfileSelect';
import { hierarchyChildIds } from './sceneHierarchy';

/** One input socket, on one node type, that holds things in the scene. */
export interface MembershipWire {
  /** The node type that declares the input. */
  readonly nodeType: string;
  /** The input socket on that type. */
  readonly socket: string;
  /** Whether the renderer reaches things through this wire today. */
  readonly drawnToday: boolean;
}

const wire = (nodeType: string, socket: string, drawnToday: boolean): MembershipWire => ({
  nodeType,
  socket,
  drawnToday,
});

/**
 * The wires that put a thing in the scene, followed outward from the Scene node. Order is the
 * order rule 3 lists them in.
 */
export const MEMBERSHIP_WIRES: readonly MembershipWire[] = [
  // Collections: the scene's top collections, what each holds, and the collections nested in it
  // (Blender's scene collection → `Collection.objects` / `Collection.children`).
  wire('Scene', 'collections', false),
  wire('Collection', 'members', false),
  wire('Collection', 'collections', false),
  // The camera, wired directly or through a CameraSelect that picks among several.
  wire('Scene', 'camera', true),
  wire('CameraSelect', 'cameras', true),
  // The scene's own lights.
  wire('Scene', 'lights', true),
  // The active lighting profile: a LightRig, wired directly or through a LightProfileSelect,
  // and the lights on it (`Scene.ts` passes the rig through apart from `lights`).
  wire('Scene', 'lightRig', true),
  wire('LightProfileSelect', 'rigs', true),
  wire('LightRig', 'lights', true),
];

/**
 * Wires that put a thing in the scene TODAY and leave this role when parenting becomes a parent
 * input (#1810) and the scene draws its collections (#1823). The parenting wires below a
 * `Scene.children` entry are `sceneHierarchy.ts`'s, not listed here (see the header).
 */
export const TRANSITIONAL_MEMBERSHIP_WIRES: readonly MembershipWire[] = [
  wire('Scene', 'children', true),
];

/**
 * The input sockets of a node of type `nodeType` through which the scene holds things today:
 * both lists, in list order. Parenting wires are not included; read `hierarchySocketsOf` for
 * those. Empty for a type that holds nothing in the scene.
 */
export function membershipSocketsOf(nodeType: string): readonly string[] {
  const out: string[] = [];
  for (const w of [...MEMBERSHIP_WIRES, ...TRANSITIONAL_MEMBERSHIP_WIRES])
    if (w.nodeType === nodeType) out.push(w.socket);
  return out;
}

function refsOf(binding: unknown): string[] {
  const refs = Array.isArray(binding) ? binding : binding ? [binding] : [];
  return (refs as NodeRef[]).map((r) => r?.node).filter((n): n is string => Boolean(n));
}

/** The wires the walk follows today, per node type: both lists, `drawnToday` only. */
const FOLLOWED: ReadonlyMap<string, readonly string[]> = (() => {
  const out = new Map<string, string[]>();
  for (const w of [...MEMBERSHIP_WIRES, ...TRANSITIONAL_MEMBERSHIP_WIRES]) {
    if (!w.drawnToday) continue;
    out.set(w.nodeType, [...(out.get(w.nodeType) ?? []), w.socket]);
  }
  return out;
})();

/** The nodes a membership wire of `nodeId` holds, in socket order. */
function heldBy(state: DagState, nodeId: string): string[] {
  const node = state.nodes[nodeId];
  if (!node) return [];
  const out: string[] = [];
  for (const socket of FOLLOWED.get(node.type) ?? []) {
    if (node.type === 'LightProfileSelect' && socket === 'rigs') {
      const selected = (node.params as { selectedProfile?: unknown }).selectedProfile;
      const rig = wiredProfileRigs(state, nodeId).find((r) => r.name === selected);
      if (rig) out.push(rig.id);
      continue;
    }
    out.push(...refsOf(node.inputs[socket]));
  }
  // Parenting carries its children into the scene with it until #1810.
  out.push(...hierarchyChildIds(node));
  return out;
}

/** Node types the membership wires pass through to reach things; never scene objects. */
export const HOP_TYPES: ReadonlySet<string> = new Set([
  'Collection',
  'CameraSelect',
  'LightRig',
  'LightProfileSelect',
]);

const membersCache = new WeakMap<DagState['nodes'], Map<string, ReadonlySet<string>>>();

/**
 * Every node the scene holds today: reached from the scene output through the followed
 * membership wires and the parenting wires.
 * The Scene node itself is not in it, and neither is an Object's data. The nodes the wires pass
 * through on the way (a LightRig, a select) are in it; `HOP_TYPES` names them. Kept per node
 * table, so a playhead change reuses it.
 */
export function sceneMembersOf(state: DagState): ReadonlySet<string> {
  const sceneId = state.outputs.scene?.node;
  if (!sceneId || !state.nodes[sceneId]) return new Set();
  let bySceneId = membersCache.get(state.nodes);
  const hit = bySceneId?.get(sceneId);
  if (hit) return hit;
  const members = new Set<string>();
  const stack = heldBy(state, sceneId);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === sceneId || members.has(id) || !state.nodes[id]) continue;
    members.add(id);
    stack.push(...heldBy(state, id));
  }
  if (!bySceneId) membersCache.set(state.nodes, (bySceneId = new Map()));
  bySceneId.set(sceneId, members);
  return members;
}

/** Whether the scene holds `id` today (rule 3). The one answer every surface reads. */
export function isInScene(state: DagState, id: string): boolean {
  return sceneMembersOf(state).has(id);
}

/**
 * The ops that keep in the scene everything `ops` would take out of it, by standing it in
 * `Scene.children` (#1518). For a door that replaces what `Scene.camera` reads: the camera it
 * replaces is still one of the scene's cameras, as a Blender camera stays in the file when another
 * becomes the scene's. Nothing for a hop, a node `ops` removes, or with no scene.
 */
export function keepInSceneOps(state: DagState, ops: readonly Op[]): Op[] {
  const sceneId = state.outputs.scene?.node;
  if (!sceneId) return [];
  const after = applyOps(state, ops).next;
  const kept = sceneMembersOf(after);
  return [...sceneMembersOf(state)]
    .filter((id) => !kept.has(id) && after.nodes[id] && !HOP_TYPES.has(after.nodes[id].type))
    .map(
      (id): Op => ({
        type: 'connect',
        from: { node: id, socket: 'out' },
        to: { node: sceneId, socket: 'children' },
      }),
    );
}
