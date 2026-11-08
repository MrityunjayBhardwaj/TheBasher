// sceneMembership — the ONE list of the wires that put a thing in the scene (#1820).
//
// Rule 3 of docs/GRAPH.md says membership is reachability: a thing is in the scene if the
// scene's wires reach it. Until this module, nothing listed which wires those are. The renderer
// answered by what `Scene.evaluate` reads, the outliner by its own walk (`sceneTreeWalk.ts`), and
// the rule by a hand-written list that left out `lightRig` (#1820 measured three disagreements).
// Rule 3 now quotes this file, and `sceneMembership.test.ts` fails when the two drift apart.
//
// THE LIST. `MEMBERSHIP_WIRES` are the wires that mean "in the scene" (decided on #1808, built by
// #1810, #1823 and #1824). Membership is the scene's own objects (its `children`, Blender's scene
// collection holding objects directly) and its collections, as in Blender, plus the scene's camera
// and lights. Parenting is not on it: a child takes its parent as an input (#1810), and where an
// object sits in the tree says nothing about whether the scene holds it, as a Blender object's
// parent and its collections are separate and a Houdini object is in /obj whatever it is wired to.
//
// One kind of parenting still carries membership: a child hung by a WIRE (a glTF asset in a
// group's list, an object inside a Transform), which has no parent input and so cannot be listed
// apart from its holder. The parenting wires are defined once in `sceneHierarchy.ts`
// (`hierarchySocketsOf`), not restated here.
//
// THE ANSWER (#1821). `isInScene(state, id)` walks these wires out from the scene output, plus the
// wired children below anything it reaches. A LightProfileSelect is followed to its selected rig
// only: the other profiles' lights are not drawn and the outliner does not list them. A
// CameraSelect is followed to every camera it lists, as Blender holds every camera object, active
// or not.
//
// WHAT IS DRAWN (#1823). `sceneDrawOf` answers what the renderer draws as its nested tree: the
// objects the scene's own list and its collections hold, and every ancestor of one (an ancestor
// that is not a member is a hidden carrier). The evaluator and every reader that lines the scene's
// values up with node ids read it through `drawnInputsOf` / `sceneChildRefs`.
//
// REF: docs/GRAPH.md §4 rule 3; src/nodes/Scene.ts (`inputs`); src/app/sceneTreeWalk.ts (the
//      outliner's walk); src/app/sceneHierarchy.ts (the parenting wires); #1519, #1820, #1821,
//      #1823.

import { applyOps } from '../core/dag/ops';
import { registryEpoch } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';
import type { NodeRef, Op } from '../core/dag/types';
import { wiredProfileRigs } from '../nodes/LightProfileSelect';
import { parentIdsOf, wiredChildIdsOf } from './sceneHierarchy';
import {
  sceneDrawOfGraph as sceneDrawOfGraphFor,
  setSceneDraw,
  type SceneDraw,
  type SceneGraph,
} from '../core/dag/worldChildren';

/** One input socket, on one node type, that holds things in the scene. */
export interface MembershipWire {
  /** The node type that declares the input. */
  readonly nodeType: string;
  /** The input socket on that type. */
  readonly socket: string;
}

const wire = (nodeType: string, socket: string): MembershipWire => ({ nodeType, socket });

/**
 * The wires that put a thing in the scene, followed outward from the Scene node. Order is the
 * order rule 3 lists them in.
 */
export const MEMBERSHIP_WIRES: readonly MembershipWire[] = [
  // Collections: the scene's top collections, what each holds, and the collections nested in it
  // (Blender's scene collection → `Collection.objects` / `Collection.children`).
  // The scene's own objects: Blender's scene collection holding objects directly (#1823). Since
  // the scene draws its collections, this list is membership only, as a collection's is.
  wire('Scene', 'children'),
  wire('Scene', 'collections'),
  wire('Collection', 'members'),
  wire('Collection', 'collections'),
  // The camera, wired directly or through a CameraSelect that picks among several.
  wire('Scene', 'camera'),
  wire('CameraSelect', 'cameras'),
  // The scene's own lights.
  wire('Scene', 'lights'),
  // The active lighting profile: a LightRig, wired directly or through a LightProfileSelect,
  // and the lights on it (`Scene.ts` passes the rig through apart from `lights`).
  wire('Scene', 'lightRig'),
  wire('LightProfileSelect', 'rigs'),
  wire('LightRig', 'lights'),
];

/**
 * The input sockets of a node of type `nodeType` through which the scene holds things, in list
 * order. Parenting wires are not included; read `hierarchySocketsOf` for those. Empty for a type
 * that holds nothing in the scene.
 */
export function membershipSocketsOf(nodeType: string): readonly string[] {
  const out: string[] = [];
  for (const w of MEMBERSHIP_WIRES) if (w.nodeType === nodeType) out.push(w.socket);
  return out;
}

function refsOf(binding: unknown): string[] {
  const refs = Array.isArray(binding) ? binding : binding ? [binding] : [];
  return (refs as NodeRef[]).map((r) => r?.node).filter((n): n is string => Boolean(n));
}

/** The wires the walk follows, per node type. */
const FOLLOWED: ReadonlyMap<string, readonly string[]> = (() => {
  const out = new Map<string, string[]>();
  for (const w of MEMBERSHIP_WIRES) out.set(w.nodeType, [...(out.get(w.nodeType) ?? []), w.socket]);
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
  // #1823 — a child hung by a WIRE (a glTF asset in a group's list, an object inside a Transform)
  // has no parent input to be a member through, so its holder carries it in. A child hung by its
  // parent input is a member only where a membership wire lists it: parenting is not membership.
  out.push(...wiredChildIdsOf(state, nodeId));
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
 * Every node the scene holds: reached from the scene output through the membership wires and
 * the wired children below what they reach.
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

/** Whether the scene holds `id` (rule 3). The one answer every surface reads. */
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

/** The wires along which the scene holds OBJECTS, the ones it draws in its tree: its own list
 *  and its collections. Its camera, lights and lighting rig draw through their own sockets. */
const OBJECT_WIRES: ReadonlyMap<string, readonly string[]> = new Map([
  ['Scene', ['children', 'collections']],
  ['Collection', ['members', 'collections']],
]);

/**
 * #1823 — what the scene draws (`drawnInputsOf` in `worldChildren.ts` reads it): the objects its
 * own list and its collections hold (and what those hold by a wire), and every ancestor of one.
 * An ancestor that is not a member is drawn hidden (`hiddenNodes`) so its children stand where it
 * puts them. The roots are the drawn nodes no drawn node holds, in the order the wires list their
 * members: the scene's own objects first, then each collection's, depth first.
 */
export function sceneDrawOf(graph: SceneGraph): SceneDraw | null {
  const state = graph as unknown as DagState;
  const epoch = registryEpoch();
  if (lastDraw && sameDrawnTreeInputs(lastDraw, state, epoch)) {
    lastDraw = { ...lastDraw, nodes: state.nodes };
    return lastDraw.draw;
  }
  const draw = buildSceneDraw(state);
  lastDraw = { nodes: state.nodes, scene: state.outputs.scene, epoch, draw };
  return draw;
}

/**
 * #1855 — every param the drawn tree reads, by node type: the profile switch's choice and each
 * rig's name (`heldBy`, `wiredProfileRigs`). Everything else the walk reads is wires, node types
 * and the type definitions. A census test reads the walk's sources and goes red when it starts
 * reading a param this does not list.
 */
export const DRAWN_TREE_PARAMS: Readonly<Record<string, readonly string[]>> = {
  LightProfileSelect: ['selectedProfile'],
  LightRig: ['name'],
};

// #1855 — the drawn tree is kept per node table (`drawMemo`), and every edit makes a new table, so a
// param edit rebuilt it although no wire moved: profiled at 500 objects, ~0.3 ms of each edited
// frame. The last tree is reused when nothing it reads changed: the same nodes, each with the same
// type, the very same `inputs` (an op that rewires replaces it; a setParam keeps it), the same
// registered definitions (`registryEpoch`), the same scene output, and the same values of `DRAWN_TREE_PARAMS`.
interface LastDraw {
  readonly nodes: DagState['nodes'];
  readonly scene: NodeRef | undefined;
  readonly epoch: number;
  readonly draw: SceneDraw | null;
}
let lastDraw: LastDraw | null = null;

function sameDrawnTreeInputs(last: LastDraw, state: DagState, epoch: number): boolean {
  if (last.epoch !== epoch) return false;
  if (last.nodes === state.nodes) return true;
  const scene = state.outputs.scene;
  if (last.scene?.node !== scene?.node || last.scene?.socket !== scene?.socket) return false;
  let count = 0;
  for (const id in state.nodes) {
    count++;
    const now = state.nodes[id];
    const was = last.nodes[id];
    if (!was || was.type !== now.type || was.inputs !== now.inputs) return false;
    const read = DRAWN_TREE_PARAMS[now.type];
    if (!read) continue;
    const a = was.params as Record<string, unknown>;
    const b = now.params as Record<string, unknown>;
    for (const key of read) if (a?.[key] !== b?.[key]) return false;
  }
  return count === Object.keys(last.nodes).length;
}

function buildSceneDraw(state: DagState): SceneDraw | null {
  const sceneId = state.outputs.scene?.node;
  if (!sceneId || !state.nodes[sceneId]) return null;
  const members = sceneMembersOf(state);
  // The objects, in wire order, depth first.
  const objects: string[] = [];
  const seen = new Set<string>([sceneId]);
  const visit = (id: string) => {
    if (seen.has(id) || !state.nodes[id]) return;
    seen.add(id);
    const node = state.nodes[id];
    const sockets = OBJECT_WIRES.get(node.type);
    if (node.type !== 'Collection') objects.push(id);
    if (sockets)
      for (const socket of sockets) for (const c of refsOf(node.inputs[socket])) visit(c);
    if (node.type !== 'Collection') for (const c of wiredChildIdsOf(state, id)) visit(c);
  };
  // A light the scene draws through its own `lights` or its active rig is drawn there, not again
  // in the tree, unless the scene's own list names it (as it always could).
  const sceneNode = state.nodes[sceneId];
  const banded = new Set([
    ...refsOf(sceneNode.inputs.lights),
    ...Object.values(state.nodes)
      .filter((n) => n.type === 'LightRig' && members.has(n.id))
      .flatMap((n) => refsOf(n.inputs.lights)),
  ]);
  for (const id of refsOf(sceneNode.inputs.children)) banded.delete(id);
  for (const id of banded) seen.add(id);
  for (const socket of OBJECT_WIRES.get('Scene')!) {
    for (const id of refsOf(sceneNode.inputs[socket])) visit(id);
  }
  const holderOf = (id: string) =>
    parentIdsOf(state, id).find((p) => p !== sceneId && state.nodes[p]?.type !== 'Scene');
  // #1841 — a member on no list that hangs from something (a camera the scene reads through its
  // `camera` socket) is drawn under what it hangs from, or the tree's readers would not see its
  // parent. With no parent it stays out of the tree: the camera band draws it.
  for (const id of members) if (!seen.has(id) && holderOf(id)) visit(id);
  // Each object and its ancestors, tops first in the order their first object was met.
  const drawn = new Set<string>();
  const tops: string[] = [];
  for (const id of objects) {
    for (let at: string | undefined = id; at && !drawn.has(at); ) {
      drawn.add(at);
      const up = holderOf(at);
      if (!up) tops.push(at);
      at = up;
    }
  }
  const listed = state.nodes[sceneId].inputs.children;
  const sceneRefs = new Map(
    ((Array.isArray(listed) ? listed : listed ? [listed] : []) as NodeRef[]).map((r) => [
      r.node,
      r,
    ]),
  );
  const roots = tops.map((id) => sceneRefs.get(id) ?? { node: id, socket: 'out' });
  const objectSet = new Set(objects);
  const carriers = new Set([...drawn].filter((id) => !objectSet.has(id)));
  return { sceneId, drawn, carriers, roots };
}

/** Hands the tree module this answer. Called by `registerAllNodes`. */
export function registerSceneDraw(): void {
  setSceneDraw(sceneDrawOf);
}

/** The scene output's `children` as the scene draws them: index i is `value.scene.children[i]`. */
export function sceneChildRefs(state: DagState): NodeRef[] {
  const sceneId = state.outputs.scene?.node;
  const scene = sceneId ? state.nodes[sceneId] : undefined;
  if (!scene) return [];
  const draw = sceneDrawOfGraphFor(state);
  if (draw) return [...draw.roots];
  const b = scene.inputs.children;
  return (Array.isArray(b) ? b : b ? [b] : []) as NodeRef[];
}

/** #1823 — the nodes the scene draws only to carry a member below them (`SceneDraw.carriers`). */
export function sceneCarriersOf(state: DagState): ReadonlySet<string> {
  return sceneDrawOfGraphFor(state)?.carriers ?? new Set();
}
