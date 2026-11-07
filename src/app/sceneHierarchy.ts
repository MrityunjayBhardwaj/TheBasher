// sceneHierarchy — the ONE definition of "which of a node's input sockets make it a
// scene-graph PARENT of what they reference".
//
// WHY THIS EXISTS (#621). The set was spelled by hand in three places, and all three
// said in prose that they mirrored a fourth:
//
//   1. `childEdges` (resolveWorldTransform.ts) — the source of truth, a `switch` on the
//      evaluated VALUE kind.
//   2. `resolveParentWorldMatrix`'s nesting fast-path scan — a literal `['children',
//      'target']`, with a comment saying it MUST mirror childEdges' socket set.
//   3. `animatedAncestorSet` (nodeChannels.ts) — the same literal, with a comment
//      saying the same thing.
//
// Three comments asserting a mirror that nothing checked. #610 folded two by-name reads
// onto the declared chain socket and left this alone deliberately, because the obvious
// fold is WRONG and the reason is worth stating: `chain.input` is declared by
// ArrayModifier, MirrorModifier, SetMaterialOp, MaterialOverrideOp and ColorCorrect too.
// Those are OPERATORS. A modifier's spine is a DATA-lane edge — the mesh flows through it
// and comes out reshaped — not a scene-graph parent edge, and `childEdges` returns [] for
// every one of their value kinds. "The socket a stack descends" and "the socket that makes
// a parent" are two different relations that currently share a socket NAME.
//
// THE NARROWING THIS PERFORMS, stated because it is a real behaviour change and not a
// pure refactor. Both literal sites scanned EVERY node's `inputs['target']` regardless of
// that node's type, so both already matched a modifier's spine:
//
//   - the nesting fast path marked a mesh `nested` merely for feeding an ArrayModifier,
//     losing the fast path and falling through to the render-root evaluate. The walk that
//     followed could not find the mesh anyway (childEdges does not descend a modifier), so
//     the ANSWER was already null — this change reaches the same null without the evaluate.
//   - `animatedAncestorSet` treated an animated ArrayModifier as an animated ANCESTOR of
//     its target mesh. Conservative rather than wrong (over-marking costs re-renders, it
//     does not produce a wrong transform), but it is not what the comment claimed the set
//     was, and a set nobody can state is a set nobody can check.
//
// TYPE vs VALUE KIND — the bridge that makes a type-keyed answer legitimate. `childEdges`
// switches on the evaluated value's `kind`; the two scan sites have no value in hand, only
// nodes. For every hierarchy type the two agree by construction: Transform.evaluate
// returns `kind: 'Transform'`, MaterialOverride returns `kind: 'MaterialOverride'`, Group
// returns `kind: 'Group'`, Object returns `kind: 'Object'` (#1152). `mirrorsChildEdges` in the test suite pins that agreement, so a
// kind that stops matching its type name fails there rather than silently splitting the
// two halves of this module apart.
//
// REF: src/app/resolveWorldTransform.ts (`childEdges` — the walk this describes);
//      src/app/operatorChain.ts (`chainSocketOf` — the DIFFERENT relation); issues
//      #621, #610, #396.

import { gatheringSocketOf, worldChildrenOf } from '../core/dag/worldChildren';
import { chainSocketOfType } from './operatorChain';

/** As much of a node as the predicates here read — structural so `nodeChannels`, which
 *  works on its own `NodeLike`, can call these without widening its own shape. */
export interface HierarchyNodeLike {
  readonly type: string;
  readonly inputs?: Readonly<Record<string, unknown>>;
}

// TWO ACCESSORS, ONE TABLE — and the reason is a real failure, not symmetry for its own
// sake. The surfaces asking this question do not all hold the same evidence:
//
//   - `childEdges` has the node AND its evaluated VALUE. It can therefore key the arm on
//     the value's kind and read the socket from the node's own DECLARATION, which is what
//     #396/#610 established and is strictly more general.
//   - the two SCAN sites have only nodes. No value exists at their call site, so the best
//     available key is the node TYPE.
//
// Collapsing both onto the type key looked tidy and immediately reddened a #610 test: a
// node PRESENTING as a Transform while typed otherwise stopped being descended. Production
// never sees that (type === kind for all three), but a walk that reads a declaration is not
// something to trade away for a shorter module. So the table below is keyed on the kind a
// node PRESENTS, and the type-keyed accessor is defined as "the kind it presents is its
// type" — which is the bridge, stated once, and pinned by the mirror test.

/** The list socket an AGGREGATE parent holds its children in. */
const CHILDREN_SOCKET = 'children';

/** Types that parent MANY children through {@link CHILDREN_SOCKET}.
 *
 *  `Object` joined in #1152: an Object that is a mesh can hold children too, as every Blender
 *  object can, so a thing that both IS something and HOLDS something has one node, not a mesh
 *  beside a Group.
 *
 *  `Scene` is here and is NOT descended by `childEdges` — the walk starts AT the scene
 *  rather than descending into it, so childEdges never sees a Scene value. It still
 *  parents its children for the two SCAN sites, whose question is "is anything holding
 *  this node as a child?" rather than "what do I descend next". Keeping it out would
 *  re-open the flat/nested confusion the fast path exists to resolve. */
// #1823 — `Scene` left this set: its `children` list is the scene collection's own objects,
// membership (`sceneMembership.ts`), and an object listed there has no parent for being listed.
const AGGREGATE_PARENT_TYPES: ReadonlySet<string> = new Set(['Group', 'Object']);

/** Types that parent exactly ONE child, through their declared chain socket.
 *
 *  Declared here rather than derived from `chain.input`, because `chain.input` answers a
 *  different question — see the header. This set is the SCENE-lane wrappers only. */
const WRAPPER_PARENT_TYPES: ReadonlySet<string> = new Set(['Transform', 'MaterialOverride']);

/** Every node type that can be a scene-graph parent. Exported for the mirror test. */
export const HIERARCHY_PARENT_TYPES: ReadonlySet<string> = new Set([
  ...AGGREGATE_PARENT_TYPES,
  ...WRAPPER_PARENT_TYPES,
]);

/**
 * The input sockets through which `node` parents scene-graph children — empty for
 * anything that is not a parent at all (a leaf producer, an operator, a sink).
 *
 * A wrapper's socket is read from its DECLARATION (`chain.input`), not assumed to be
 * `target`, for the reason #396 and #610 give: the name and the spine agree for every
 * shipped type and stop agreeing the moment a wrapper gains a second same-typed input.
 */
export function hierarchySocketsOf(node: HierarchyNodeLike | undefined): readonly string[] {
  if (!node) return [];
  const socket = hierarchySocketForKind(node.type, node);
  return socket ? [socket] : [];
}

/**
 * The socket a node parents through GIVEN THE KIND IT PRESENTS — for `childEdges`, which
 * holds the evaluated value and so knows the kind independently of the node's type.
 * `null` when that kind does not parent at all.
 *
 * A wrapper's socket comes from the node's own `chain.input` DECLARATION. That is the
 * whole content of #396/#610 and it is why this takes the node as well as the kind: two
 * nodes presenting the same kind may spell their spine differently, and the walk must
 * follow each one's declaration rather than a name fixed here.
 */
export function hierarchySocketForKind(
  kind: string,
  node: HierarchyNodeLike | undefined,
): string | null {
  if (AGGREGATE_PARENT_TYPES.has(kind)) return CHILDREN_SOCKET;
  if (WRAPPER_PARENT_TYPES.has(kind)) return (node && chainSocketOfType(node.type)) ?? null;
  return null;
}

/**
 * Every node id `node` holds as a scene-graph CHILD, in socket order. Order within a
 * list socket is preserved, which is what lets `childEdges` line index i of the value's
 * `children` up with index i of the binding.
 */
export function hierarchyChildIds(node: HierarchyNodeLike | undefined): string[] {
  const out: string[] = [];
  for (const socket of hierarchySocketsOf(node)) {
    const b = node?.inputs?.[socket];
    const refs = Array.isArray(b) ? b : b ? [b] : [];
    for (const r of refs) {
      const id = (r as { node?: string } | undefined)?.node;
      if (typeof id === 'string' && id) out.push(id);
    }
  }
  return out;
}

/** True iff any node in `nodes` holds `childId` as a scene-graph child — i.e. `childId`
 *  is genuinely NESTED rather than wired flat (scene.camera / scene.lights / a data lane).
 *  O(N) over nodes with no evaluate, which is the whole point at its call site. */
export function hasHierarchyParent(nodes: Iterable<HierarchyNodeLike>, childId: string): boolean {
  for (const n of nodes) {
    if (hierarchyChildIds(n).includes(childId)) return true;
  }
  return false;
}

// ── THE TREE AS A WHOLE-GRAPH QUESTION (#1823 / #1824, step 1) ─────────────────────────────
//
// `hierarchyChildIds(node)` answers from one node, because today a parent holds its children
// in its own `children` input. Once parenting moves onto the child's `parent` input (#1810,
// converted by #1824), a parent's children are the nodes that point at it, which only the whole
// graph can answer. Readers ask the functions below instead of reading one node's inputs, so
// that move changes `hierarchyEdgesOf` and not every reader.

/** As much of the graph as the tree questions read. */
export interface HierarchyGraphLike {
  readonly nodes: Readonly<Record<string, HierarchyNodeLike>>;
}

/** One parent → child relation of the scene tree. */
export interface HierarchyEdge {
  readonly parent: string;
  readonly child: string;
}

interface HierarchyIndex {
  readonly edges: readonly HierarchyEdge[];
  readonly children: ReadonlyMap<string, readonly string[]>;
  readonly parents: ReadonlyMap<string, readonly string[]>;
}

const EMPTY: readonly string[] = Object.freeze([]);

/**
 * What `node` holds: its wired children, then (for a node that gathers, #1824) the nodes whose
 * parent input reads its world, as the evaluator fills its gathering input. Until saved files are
 * converted both can be present; a child named by both counts once.
 */
function heldChildIds(graph: HierarchyGraphLike, id: string, node: HierarchyNodeLike): string[] {
  const wired = hierarchyChildIds(node);
  if (!gatheringSocketOf(node.type)) return wired;
  const held = new Set(wired);
  return [...wired, ...worldChildrenOf(graph, id).filter((c) => !held.has(c))];
}
const indexMemo = new WeakMap<object, HierarchyIndex>();

function indexOf(graph: HierarchyGraphLike): HierarchyIndex {
  const hit = indexMemo.get(graph.nodes);
  if (hit) return hit;
  const edges: HierarchyEdge[] = [];
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  for (const [parent, node] of Object.entries(graph.nodes)) {
    for (const child of heldChildIds(graph, parent, node)) {
      edges.push({ parent, child });
      (children.get(parent) ?? children.set(parent, []).get(parent)!).push(child);
      (parents.get(child) ?? parents.set(child, []).get(child)!).push(parent);
    }
  }
  const index = { edges, children, parents };
  indexMemo.set(graph.nodes, index);
  return index;
}

/**
 * Every parent → child relation of the scene tree, parents in node-table order and each
 * parent's children in the order the outliner shows them. Built once per node table.
 */
export function hierarchyEdgesOf(graph: HierarchyGraphLike): readonly HierarchyEdge[] {
  return indexOf(graph).edges;
}

/** The scene-graph children of `parentId`, in order. Empty for an unknown id or a leaf. */
export function childIdsOf(graph: HierarchyGraphLike, parentId: string): readonly string[] {
  return indexOf(graph).children.get(parentId) ?? EMPTY;
}

/**
 * #1823 — the children `parentId` holds by a WIRE (its list, or a wrapper's one child), not the
 * ones hung from it by their own parent input. A wired child has no parent input to be a scene
 * member through, so its holder carries it into the scene (`sceneMembership.ts`).
 */
export function wiredChildIdsOf(graph: HierarchyGraphLike, parentId: string): string[] {
  return hierarchyChildIds(graph.nodes[parentId]);
}

/**
 * Every node holding `childId` as a scene-graph child, in node-table order. Today a node wired
 * into two holders has two; a parent input (#1824) holds one.
 */
export function parentIdsOf(graph: HierarchyGraphLike, childId: string): readonly string[] {
  return indexOf(graph).parents.get(childId) ?? EMPTY;
}

/** The first holder of `childId`, or null at the top of the tree. */
export function parentIdOf(graph: HierarchyGraphLike, childId: string): string | null {
  return parentIdsOf(graph, childId)[0] ?? null;
}
