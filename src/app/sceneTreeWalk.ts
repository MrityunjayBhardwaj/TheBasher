// Scene-tree projection — walks the DAG (state.nodes) starting from the
// project's `scene` output, descending through Group / Transform /
// MaterialOverride / Scatter producers. Leaves are BoxMesh / GltfAsset /
// Scatter (Scatter terminates the visible projection in P1; its instance
// count is shown but instances are not enumerated as rows).
//
// Important — projection vs. truth (THESIS.md §12): two non-identical DAGs
// that evaluate to the same hierarchy MUST yield the same tree shape. The
// row's `display` field is the only thing the user sees; the source nodeId
// stays attached so reorder ops know which producer to disconnect/connect.
//
// REF: THESIS.md §12, §39 (P1 Wave C).

import type { DagState } from '../core/dag/state';
import type { NodeId } from '../core/dag/types';

export interface TreeRow {
  /** Stable key for React. */
  readonly key: string;
  /** The DAG node that produced this row. */
  readonly nodeId: NodeId;
  /** The DAG node's type label (BoxMesh, Group, Transform, …). */
  readonly nodeType: string;
  /** Indent depth in the projected tree. */
  readonly depth: number;
  /** Human-readable label shown in the UI. */
  readonly display: string;
  /**
   * The (parent nodeId, socket, index-in-list) that produced this row, if
   * any. Top-level rows under Scene.children carry this; the Scene row
   * itself does not. Drag-reorder uses these to emit disconnect+connect.
   */
  readonly parent?: { nodeId: NodeId; socket: string; index: number };
  /**
   * The owning GltfAsset's node id, set ONLY on projected GltfChild rows
   * (Phase 7.7, #91). The outliner uses it to collapse/expand the whole
   * child subtree under one toggle on the GltfAsset row (D2 — absorbs the
   * 50-100-child node-flood, D-05). Absent on every non-glTF-child row.
   */
  readonly gltfAssetOwner?: NodeId;
}

interface WalkCtx {
  rows: TreeRow[];
  state: DagState;
  visited: Set<NodeId>;
}

function pushRow(ctx: WalkCtx, row: TreeRow): void {
  ctx.rows.push(row);
}

function display(state: DagState, nodeId: NodeId): string {
  const node = state.nodes[nodeId];
  if (!node) return `<missing:${nodeId}>`;
  const params = node.params as Record<string, unknown>;
  // Identity, in priority order:
  //   1. meta.name — the canonical user-facing name (what the inspector header
  //      and the a11y selection summary resolve to: meta.name ?? id). Honoring
  //      it first keeps the tree row 1:1 with the inspector identity.
  //   2. params.name — the SEMANTIC name carried by Shot / AnimationClip /
  //      Character node params (their domain label, not a generic field).
  //   3. node.id — the unique, stable fallback. Previously this fell back to
  //      `node.type`, which rendered every unnamed BoxMesh as the indistinct
  //      label "BoxMesh"; two boxes were unidentifiable in the tree while the
  //      inspector showed "n_box_2". The type is conveyed by the row's icon,
  //      so the label carries identity, not category.
  const paramName = typeof params?.name === 'string' ? params.name : undefined;
  return node.meta?.name ?? paramName ?? node.id;
}

function walkOneAsChild(
  ctx: WalkCtx,
  nodeId: NodeId,
  depth: number,
  parentKey: string,
  parent: { nodeId: NodeId; socket: string; index: number },
): void {
  if (ctx.visited.has(nodeId)) return;
  ctx.visited.add(nodeId);
  const node = ctx.state.nodes[nodeId];
  if (!node) return;
  const row: TreeRow = {
    key: `${parentKey}/${nodeId}`,
    nodeId,
    nodeType: node.type,
    depth,
    display: display(ctx.state, nodeId),
    parent,
  };
  if (node.type === 'Group') {
    pushRow(ctx, row);
    const children = node.inputs.children;
    if (Array.isArray(children)) {
      children.forEach((ref, i) => {
        ctx.visited.delete(ref.node);
        walkOneAsChild(ctx, ref.node, depth + 1, row.key, {
          nodeId,
          socket: 'children',
          index: i,
        });
      });
    }
    return;
  }
  if (node.type === 'Transform' || node.type === 'MaterialOverride') {
    pushRow(ctx, row);
    const target = node.inputs.target;
    if (target && !Array.isArray(target)) {
      ctx.visited.delete(target.node);
      walkOneAsChild(ctx, target.node, depth + 1, row.key, {
        nodeId,
        socket: 'target',
        index: 0,
      });
    }
    return;
  }
  if (node.type === 'GltfAsset') {
    pushRow(ctx, row);
    projectGltfChildren(ctx, node, depth, row.key);
    return;
  }
  pushRow(ctx, row);
}

/**
 * Project a GltfAsset's scene children as nested, selectable rows (Phase 7.7,
 * issue #91 — Option A). The children are NOT scene `inputs`: they live as
 * GltfChild DAG nodes addressed by name inside the asset's params. This is a
 * PURE PROJECTION (THESIS.md §12) — it reads `nodeNameMap` (childKey → GltfChild
 * node id) and `childHierarchy` (parentKey → childKeys) from the asset's params,
 * and emits a row per child whose `nodeId` is the GltfChild node id so a click
 * selects the addressable child node. The rows carry NO `parent` linkage:
 * glTF children are not reorderable via disconnect/connect (they have no scene
 * edge), so SceneTree's drag-reorder (which gates on `row.parent`) never fires
 * a disconnect/connect on them — the "scene diverges from DAG" silent failure
 * is structurally impossible here. Children stay OUT of the render `inputs`
 * graph (R-2 / B12 double-render guard).
 *
 * REF: PLAN.md 7.7 Wave D (D1); GltfAsset.ts childHierarchy (A3); vyapti V1.
 */
function projectGltfChildren(
  ctx: WalkCtx,
  assetNode: NonNullable<DagState['nodes'][string]>,
  assetDepth: number,
  assetKey: string,
): void {
  const params = assetNode.params as {
    nodeNameMap?: Record<string, string>;
    childHierarchy?: Record<string, string[]>;
  };
  const nodeNameMap = params.nodeNameMap ?? {};
  const childHierarchy = params.childHierarchy ?? {};
  const assetNodeId = assetNode.id;

  // Roots = child keys that appear in NO childHierarchy[parent] array. Build
  // the "is a child of someone" set once (O(n), not O(n^2)), then the roots
  // are the keys absent from it. A glTF with no hierarchy (flat) makes every
  // key a root. Iterate nodeNameMap keys in insertion order (the importer
  // seeds it in json.nodes index order — deterministic, V22).
  const childKeySet = new Set<string>();
  for (const childKeys of Object.values(childHierarchy)) {
    for (const k of childKeys) childKeySet.add(k);
  }

  const seen = new Set<string>();
  const emitChild = (key: string, depth: number): void => {
    if (seen.has(key)) return; // cycle / multi-parent guard
    seen.add(key);
    const childNodeId = nodeNameMap[key];
    if (!childNodeId) return; // key with no materialized GltfChild node
    pushRow(ctx, {
      key: `${assetKey}/gltfchild/${key}`,
      nodeId: childNodeId,
      nodeType: 'GltfChild',
      depth,
      display: key,
      // NO `parent` — glTF children are non-reorderable (no scene edge).
      gltfAssetOwner: assetNodeId, // D2 collapse-by-owner toggle key
    });
    const grandchildren = childHierarchy[key];
    if (Array.isArray(grandchildren)) {
      for (const gk of grandchildren) emitChild(gk, depth + 1);
    }
  };

  for (const key of Object.keys(nodeNameMap)) {
    if (childKeySet.has(key)) continue; // not a root
    emitChild(key, assetDepth + 1);
  }
}

export function buildSceneTreeRows(state: DagState): TreeRow[] {
  const sceneRef = state.outputs.scene;
  if (!sceneRef) return [];
  const rows: TreeRow[] = [];
  const ctx: WalkCtx = { rows, state, visited: new Set() };
  const sceneNode = state.nodes[sceneRef.node];
  if (!sceneNode) return [];
  // Scene row at depth 0 — no `parent` because reorder happens on Scene's
  // OWN children (each tree row at depth 1 carries that parent linkage).
  ctx.rows.push({
    key: sceneRef.node,
    nodeId: sceneRef.node,
    nodeType: sceneNode.type,
    depth: 0,
    display: display(state, sceneRef.node),
  });
  ctx.visited.add(sceneRef.node);
  const children = sceneNode.inputs.children;
  if (Array.isArray(children)) {
    children.forEach((ref, i) => {
      ctx.visited.delete(ref.node);
      walkOneAsChild(ctx, ref.node, 1, sceneRef.node, {
        nodeId: sceneRef.node,
        socket: 'children',
        index: i,
      });
    });
  }
  return rows;
}
