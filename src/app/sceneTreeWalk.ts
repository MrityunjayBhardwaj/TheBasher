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
  const name = (params?.name as string | undefined) ?? '';
  return name ? `${node.type} (${name})` : node.type;
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
  pushRow(ctx, row);
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
