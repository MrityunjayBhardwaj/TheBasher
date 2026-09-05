// importedChild — the ONE answer to "is this node an imported glTF child, and what is it?"
// (#389, step 2 of the split).
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────
//
// Thirteen production modules ask that question today, each by testing
// `node.type === 'GltfChild'` and then reaching into `node.params` for `assetRef` /
// `childName` / `overridden`. That is fifteen copies of one piece of knowledge — the
// kind-dispatch shape this codebase has already been bitten by — and every one of them
// is a site that goes quietly wrong when the kind changes.
//
// It is about to change. #389 splits the fused `GltfChild` into an ordinary `Object`
// (the pose) plus a `GltfData` (what the child IS), so the answer stops being "read this
// node's params" and becomes "follow this Object's `data` input and read THAT node's
// params". Fifteen sites would each have to learn the hop.
//
// ── WHY IT TAKES THE TABLE AND AN ID, NOT A NODE ─────────────────────────────────────
//
// This is the whole design decision, and it is why the seam is worth landing BEFORE the
// flip rather than during it. A node-shaped signature (`isGltfChild(node)`) cannot
// express the post-split answer at all: following `inputs.data` needs the other nodes.
// Taking `(nodes, id)` from the start means the flip changes this file and nothing else.
// A seam introduced with the wrong signature would have to be introduced twice.
//
// So this commit is a pure de-duplication that stands on its own: the answers below are
// exactly the answers the fifteen sites compute today, and it is measurable that they
// are — the specs pin the fused reading. The flip re-implements the bodies; no caller
// moves.
//
// ── STRUCTURAL TYPING, DELIBERATELY ──────────────────────────────────────────────────
//
// `NodeLike` rather than the DAG's `Node`, for the reason `splitKinds.ts` documents about
// itself: the callers span the renderer, the timeline, the agent mutators and the import
// chain, and pulling the graph module into all of them to ask a question about params
// would be a bad trade. Everything here is a pure read over plain data.
//
// REF: src/nodes/GltfChild.ts (the fused kind being read today); src/nodes/GltfData.ts
//      (the data half that will answer instead); src/app/resolveGltfChildTransform.ts
//      (the precedence rule `overridden` feeds); issues #389, #383.

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
  if (!nodeId) return null;
  const node = nodes[nodeId];
  // The fused reading. After the flip this follows `Object.inputs.data` instead, and every
  // caller below is unaffected — which is the entire point of the seam.
  if (!node || node.type !== 'GltfChild') return null;

  const p = node.params as { assetRef?: unknown; childName?: unknown; overridden?: unknown };
  if (typeof p?.assetRef !== 'string' || typeof p?.childName !== 'string') return null;

  return {
    assetRef: p.assetRef,
    childName: p.childName,
    overridden: readOverridden(p.overridden),
  };
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
