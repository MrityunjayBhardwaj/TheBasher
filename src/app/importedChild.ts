// importedChild — the ONE answer to "is this node an imported glTF child, and what is it?"
// (#389, step 2 of the split).
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────
//
// Thirteen production modules asked that question, each by testing
// `node.type === 'GltfChild'` and then reaching into `node.params` for `assetRef` /
// `childName` / `overridden`. That was fifteen copies of one piece of knowledge — the
// kind-dispatch shape this codebase has already been bitten by — and every one of them
// was a site that goes quietly wrong when the kind changes.
//
// It changed. #389 split the fused `GltfChild` into an ordinary `Object` (the pose) plus
// a `GltfData` (what the child IS), so the answer stopped being "read this node's params"
// and became "follow this Object's `data` input and read THAT node's params". Fifteen
// sites would each have had to learn the hop; instead the hop lives here once and no
// caller moved.
//
// ── WHY IT TAKES THE TABLE AND AN ID, NOT A NODE ─────────────────────────────────────
//
// This is the whole design decision, and it is why the seam is worth landing BEFORE the
// flip rather than during it. A node-shaped signature (`isGltfChild(node)`) cannot
// express the post-split answer at all: following `inputs.data` needs the other nodes.
// Taking `(nodes, id)` from the start means the flip changes this file and nothing else.
// A seam introduced with the wrong signature would have to be introduced twice.
//
// So the seam landed as a pure de-duplication that stood on its own: its answers were
// exactly the answers the fifteen sites computed against the fused kind, and the specs
// pinned that reading. The flip re-implemented the bodies below and moved no caller,
// which is the evidence that the signature was the right one.
//
// ── STRUCTURAL TYPING, DELIBERATELY ──────────────────────────────────────────────────
//
// `NodeLike` rather than the DAG's `Node`, for the reason `splitKinds.ts` documents about
// itself: the callers span the renderer, the timeline, the agent mutators and the import
// chain, and pulling the graph module into all of them to ask a question about params
// would be a bad trade. Everything here is a pure read over plain data.
//
// ── WHERE EACH FACT NOW LIVES, AND WHY THEY ARE NOT ON ONE NODE ──────────────────────
//
// The two halves answer different questions and the split is not arbitrary:
//
//   · `assetRef` / `childName` — the child's ADDRESS, i.e. what it IS. On the DATA node.
//   · `overridden`             — the manual band's win signal for the child's TRS, i.e.
//                                a fact about the POSE. On the OBJECT, because an
//                                override record belongs to the ID that owns the
//                                overridden property, and after the split that is the
//                                Object ([[V397]]).
//
// So this reader takes ONE hop and reads BOTH ends. A caller that took only the hop would
// silently lose every override flag; a caller that read only the Object would lose the
// address. That is precisely why they are returned together — see `ImportedChild`.
//
// REF: src/nodes/GltfData.ts (the data half); src/nodes/ObjectNode.ts (`overridden`);
//      src/app/resolveGltfChildTransform.ts (the precedence rule `overridden` feeds);
//      src/core/project/migrations.ts (`migrateFusedGltfChildToSplit`); issues #389, #383.

import { dataSlotsOnly } from './materialAssignment';

/** The minimum shape this module reads. See the header on why it is not `Node`. */
export interface NodeLike {
  readonly type: string;
  readonly params?: unknown;
  readonly inputs?: unknown;
}

/**
 * What an imported glTF child is, independent of how it is currently spelled.
 *
 * `overridden` is included because it is inseparable from the other two in practice: every
 * caller that resolves a child's pose needs the flags in the same breath as the name, and
 * splitting them across two lookups is how one of them comes to be read from a stale node.
 */
export interface ImportedChild {
  /** The owning asset's ref. */
  readonly assetRef: string;
  /** The sanitised name key — the key `nodeNameMap` and every clip track use. */
  readonly childName: string;
  /** The manual-override dirty flags, per TRS component. All-false when unset. */
  readonly overridden: {
    readonly position: boolean;
    readonly rotation: boolean;
    readonly scale: boolean;
  };
}

const NO_OVERRIDES = { position: false, rotation: false, scale: false } as const;

function readOverridden(raw: unknown): ImportedChild['overridden'] {
  const o = raw as Record<string, unknown> | undefined;
  if (!o) return NO_OVERRIDES;
  return {
    position: o.position === true,
    rotation: o.rotation === true,
    scale: o.scale === true,
  };
}

/**
 * Read the imported-child facts off `nodeId`, or `null` if it is not one.
 *
 * Total and synchronous: a missing node, a wrong type, or params missing either string
 * resolves to `null` rather than throwing. A caller asking "is this an imported child" is
 * never the right place to fail a malformed value — and a partial answer would be worse
 * than none, because `assetRef` without `childName` addresses the whole asset.
 */
export function importedChildOf(
  nodes: Readonly<Record<string, NodeLike>>,
  nodeId: string | null | undefined,
): ImportedChild | null {
  const dataId = importedChildDataId(nodes, nodeId);
  if (!dataId) return null;

  const p = nodes[dataId].params as { assetRef?: unknown; childName?: unknown };
  if (typeof p?.assetRef !== 'string' || typeof p?.childName !== 'string') return null;

  // The flags come off the OBJECT, never the data half — see the header. Reading them
  // from `nodes[dataId]` would compile, return all-false for every child, and make a
  // director's edit lose to the clip on the very next frame.
  const op = nodes[nodeId!].params as { overridden?: unknown };

  return {
    assetRef: p.assetRef,
    childName: p.childName,
    overridden: readOverridden(op?.overridden),
  };
}

/**
 * The id of the `GltfData` node `nodeId`'s `data` input points at, or `null` when `nodeId`
 * is not an imported child's Object.
 *
 * Separate from {@link importedChildOf} because two callers genuinely need the NODE and not
 * the facts: the import group collector has to delete the data half, and a param write aimed
 * at a data param has to be re-addressed to it. Both are questions about identity rather
 * than content, and answering them by re-deriving the id from `assetRef`/`childName` would
 * be a second derivation that disagrees with the graph the moment a project is migrated
 * (the ladder mints through `freshDataId`, the importer through `gltfChildDataDagId`).
 */
export function importedChildDataId(
  nodes: Readonly<Record<string, NodeLike>>,
  nodeId: string | null | undefined,
): string | null {
  if (!nodeId) return null;
  const node = nodes[nodeId];
  // An imported child is an ordinary `Object` — the same node type a box, a light and a
  // camera resolve to. What makes it a CHILD is what hangs off `data`, so the type test
  // alone is never the answer and the hop is not an optimisation.
  if (!node || node.type !== 'Object') return null;

  const binding = (node.inputs as Record<string, unknown> | undefined)?.data;
  // `data` is single-cardinality, but read the list shape too rather than trusting it:
  // this module is structurally typed on purpose and its callers span four subsystems.
  const ref = (Array.isArray(binding) ? binding[0] : binding) as { node?: unknown } | undefined;
  const dataId = ref?.node;
  if (typeof dataId !== 'string') return null;

  const data = nodes[dataId];
  return data?.type === 'GltfData' ? dataId : null;
}

/**
 * Is `nodeId` an imported glTF child?
 *
 * Defined in terms of {@link importedChildOf} rather than beside it — one implementation,
 * one rule. A second predicate agreeing with it today would diverge the first time the
 * spelling moved, which is precisely the failure this module exists to end.
 */
export function isImportedChild(
  nodes: Readonly<Record<string, NodeLike>>,
  nodeId: string | null | undefined,
): boolean {
  return importedChildOf(nodes, nodeId) !== null;
}

/**
 * Find the imported child addressed by `childName` (optionally within one asset), as an
 * `[id, facts]` pair.
 *
 * The name is the addressing key everywhere a clip is involved — a track names its subject
 * by `childName`, never by the DAG node id — so this is a genuinely different question from
 * {@link importedChildOf} and not a convenience over it.
 *
 * ⚠️ FIRST MATCH, and the ambiguity is real rather than theoretical: two assets can both
 * contain a child called `Cube`. Callers that know the asset MUST pass `assetRef`; the
 * parameter is optional only because two of today's callers genuinely have a name and
 * nothing else, and narrowing them is a separate question from moving the lookup here.
 */
export function findImportedChild(
  nodes: Readonly<Record<string, NodeLike>>,
  childName: string,
  assetRef?: string,
): readonly [string, ImportedChild] | null {
  for (const id of Object.keys(nodes)) {
    const child = importedChildOf(nodes, id);
    if (!child) continue;
    if (child.childName !== childName) continue;
    if (assetRef !== undefined && child.assetRef !== assetRef) continue;
    return [id, child];
  }
  return null;
}

/**
 * Every imported child belonging to `assetRef`, as `[id, facts]` pairs.
 *
 * Used by the dependency collector, which needs the whole set rather than one — and needs
 * it keyed by id, because what it does with them is address them as nodes.
 */
export function importedChildrenOf(
  nodes: Readonly<Record<string, NodeLike>>,
  assetRef: string,
): readonly (readonly [string, ImportedChild])[] {
  const out: (readonly [string, ImportedChild])[] = [];
  for (const id of Object.keys(nodes)) {
    const child = importedChildOf(nodes, id);
    if (child && child.assetRef === assetRef) out.push([id, child]);
  }
  return out;
}

/**
 * The imported child's CAPTURED MATERIALS, as the data half stores them.
 *
 * Returns the raw param pair (`material`, `materialSlots`) so a caller can overlay
 * channels onto it under the child's own param paths, AND the flattened slot table in
 * glTF primitive order so a caller can index a clone's meshes by slot. Both, because the
 * renderer needs both and deriving one from the other at two call sites is how they come
 * to disagree.
 *
 * ⚠️ THE FLATTENING RULE IS `materialSlots ?? [material]`, and it is not a convenience —
 * it is the SAME rule `dataSlotsOnly` applies to the evaluated value. A multi-primitive
 * child stores the full table AND slot 0 in `material`; a single-primitive child stores
 * only `material`. Spelling that here rather than at each caller is what keeps the
 * renderer's per-slot write aligned with the read side.
 *
 * Generic over the material shape (V20, mirroring `overlayChannels`) so this module keeps
 * its promise not to import the node value types — see the header.
 */
export function importedChildMaterials<M>(
  nodes: Readonly<Record<string, NodeLike>>,
  nodeId: string | null | undefined,
): {
  base: { material: M | null; materialSlots?: readonly (M | null)[] };
  slots: readonly (M | null)[];
} | null {
  const dataId = importedChildDataId(nodes, nodeId);
  if (!dataId) return null;
  const p = nodes[dataId].params as { material?: unknown; materialSlots?: unknown } | undefined;
  const material = (p?.material ?? null) as M | null;
  const materialSlots = Array.isArray(p?.materialSlots)
    ? (p.materialSlots as (M | null)[])
    : undefined;
  const base = { material, ...(materialSlots ? { materialSlots } : {}) };
  // Through the ONE named hatch (#645) rather than re-spelling `materialSlots ?? [material]`
  // — see `objectSlotTable.gate`. It is generic, so this module still imports no value type.
  return { base, slots: dataSlotsOnly(base) };
}

/**
 * Does `paramPath` address an imported child's captured material?
 *
 * `material.<lobe>.<field>` or `materialSlots.<slot>.<lobe>.<field>` — the two spellings
 * the data half stores, and therefore the two a channel or a transient can carry. The
 * fused kind had ONE (`materials.<slot>.…`), which is why every caller used to be able to
 * ask with a bare `startsWith`.
 *
 * Centralised because three readers ask it — the dependency collector, the renderer's
 * per-frame band, and the migration's counterpart on the OLD spelling — and a `startsWith`
 * copied into each would let `materialSlots` be missed in one of them, which reads as
 * "this asset has no animated materials" rather than as an error.
 */
export function isImportedChildMaterialPath(paramPath: unknown): boolean {
  return (
    typeof paramPath === 'string' &&
    (paramPath.startsWith('material.') || paramPath.startsWith('materialSlots.'))
  );
}
