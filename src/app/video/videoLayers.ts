// videoLayers — read the ordered layer rows of a Composition from the DAG, with
// the node ids the timeline needs for editing (setParam/reorder). The evaluated
// CompositionValue carries the layer VALUES but not their ids; the timeline edits
// nodes, so it reads the raw graph: Composition.inputs.layers (ordered NodeRefs,
// 0=back…last=front) → each Layer node's params → its source's frame count.
//
// Pure (takes DagState) so it is unit-testable and the component just renders.
//
// REF: docs/COMPOSITOR-DESIGN.md §4.1/§4.2; vyapti V34 (data in the DAG);
//      sibling: videoTimelineGeometry; issue #237.

import type { DagState } from '../../core/dag/state';
import type { NodeId } from '../../core/dag/types';

export interface LayerRow {
  readonly id: NodeId;
  readonly name: string;
  readonly enabled: boolean;
  readonly solo: boolean;
  readonly locked: boolean;
  readonly startFrame: number;
  readonly inPoint: number;
  readonly outPoint: number;
  /** The source's length in source frames (1 for a still); falls back to 1. */
  readonly srcFrames: number;
}

/** Normalize a socket binding to an ordered list of node ids. */
function refNodeIds(binding: unknown): NodeId[] {
  if (Array.isArray(binding)) return binding.map((r) => (r as { node: NodeId }).node);
  if (binding && typeof binding === 'object' && 'node' in binding) {
    return [(binding as { node: NodeId }).node];
  }
  return [];
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * The ordered layer rows of `compId`, back→front (the `layers` list order). A
 * dangling layer ref (node missing) is skipped. Returns [] when the comp is
 * missing or has no layers.
 */
export function collectLayerRows(state: DagState, compId: NodeId): LayerRow[] {
  const comp = state.nodes[compId];
  if (!comp) return [];
  const rows: LayerRow[] = [];
  for (const layerId of refNodeIds(comp.inputs?.layers)) {
    const layer = state.nodes[layerId];
    if (!layer || layer.type !== 'Layer') continue;
    const p = layer.params as Record<string, unknown>;
    const srcId = refNodeIds(layer.inputs?.source)[0];
    const src = srcId ? state.nodes[srcId] : undefined;
    const srcFrames = src ? num((src.params as Record<string, unknown>).srcFrames, 1) : 1;
    rows.push({
      id: layerId,
      name: String(p.name ?? 'Layer'),
      enabled: p.enabled !== false,
      solo: p.solo === true,
      locked: p.locked === true,
      startFrame: num(p.startFrame, 0),
      inPoint: num(p.inPoint, 0),
      outPoint: num(p.outPoint, -1),
      srcFrames: Math.max(1, srcFrames),
    });
  }
  return rows;
}
