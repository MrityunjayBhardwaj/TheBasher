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
// REF: docs/GRAPH.md §4 rule 3; src/nodes/Scene.ts (`inputs`); src/app/sceneTreeWalk.ts (the
//      outliner's walk); src/app/sceneHierarchy.ts (the parenting wires); #1519, #1820, #1821.

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
