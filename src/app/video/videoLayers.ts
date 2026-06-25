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
import type { NodeId, NodeRef, Op } from '../../core/dag/types';
import { buildAddEffectOps, enumerateEffectStack, resolveEffectBase } from '../operatorStack';

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
  /** Composite opacity 0..1 (keyframeable, paramPath 'opacity'). */
  readonly opacity: number;
  /** 2D transform rotation in degrees (keyframeable, paramPath 'transform.rotation'). */
  readonly rotation: number;
  /** 2D transform position offset [x,y] in px (keyframeable, 'transform.position'). */
  readonly position: readonly [number, number];
  /** 2D transform scale [x,y] (keyframeable, 'transform.scale'). */
  readonly scale: readonly [number, number];
}

function vec2(value: unknown, fallback: readonly [number, number]): readonly [number, number] {
  return Array.isArray(value) && value.length >= 2
    ? [num(value[0], fallback[0]), num(value[1], fallback[1])]
    : fallback;
}

/** Normalize a socket binding to an ordered list of NodeRefs (node + socket). */
function refList(binding: unknown): NodeRef[] {
  if (Array.isArray(binding)) return binding as NodeRef[];
  if (binding && typeof binding === 'object' && 'node' in binding) return [binding as NodeRef];
  return [];
}

/** Normalize a socket binding to an ordered list of node ids. */
function refNodeIds(binding: unknown): NodeId[] {
  return refList(binding).map((r) => r.node);
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
    // The source edge may pass through an effect chain (Image→Image) — resolve to
    // the BASE source (the MediaClip) so the bar length reads the real frame count,
    // not an effect node's (which has no srcFrames → would shrink the bar).
    const srcId = refNodeIds(layer.inputs?.source)[0];
    const baseSrcId = srcId ? resolveEffectBase(state, srcId) : undefined;
    const src = baseSrcId ? state.nodes[baseSrcId] : undefined;
    const srcFrames = src ? num((src.params as Record<string, unknown>).srcFrames, 1) : 1;
    const transform = (p.transform ?? {}) as Record<string, unknown>;
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
      opacity: num(p.opacity, 1),
      rotation: num(transform.rotation, 0),
      position: vec2(transform.position, [0, 0]),
      scale: vec2(transform.scale, [1, 1]),
    });
  }
  return rows;
}

/**
 * Ops to move `layerId` to raw index `toIndex` (0=back…last=front) in the comp's
 * ordered `layers` list — the disconnect + connect-with-index reorder protocol
 * (cf. P1 drag-reorder, src/core/dag/ops.test.ts): drop the moved edge (the list
 * shrinks by one), then re-insert it at the target index. Because the array is
 * removed-then-reinserted, `toIndex` IS the moved layer's final index. One atomic
 * batch → one undo.
 *
 * Returns [] (a no-op) when the comp/layer is missing or the target equals the
 * current index. `toIndex` is clamped into the valid range.
 */
export function buildReorderLayerOps(
  state: DagState,
  compId: NodeId,
  layerId: NodeId,
  toIndex: number,
): Op[] {
  const comp = state.nodes[compId];
  if (!comp) return [];
  const refs = refList(comp.inputs?.layers);
  const from = refs.findIndex((r) => r.node === layerId);
  if (from === -1) return [];
  const movedRef = refs[from];
  const to = toIndex < 0 ? 0 : toIndex > refs.length - 1 ? refs.length - 1 : toIndex;
  if (to === from) return [];
  return [
    { type: 'disconnect', from: movedRef, to: { node: compId, socket: 'layers' } },
    { type: 'connect', from: movedRef, to: { node: compId, socket: 'layers' }, index: to },
  ];
}

/** One video effect on a layer's source edge, base→top of the [[V58]] stack. */
export interface LayerEffectRow {
  readonly nodeId: NodeId;
  readonly type: string;
  readonly muted: boolean;
  readonly brightness: number;
  readonly contrast: number;
  readonly saturation: number;
}

/**
 * The effect stack on `layerId`'s source edge (base → top), read from the DAG via
 * the shared operatorStack enumeration (the SAME engine geometry modifiers use —
 * [[V58]] lifted to the Image socket). Returns [] when the layer has no source or no
 * effects. Each entry carries its authored colour params for the inspector field.
 */
export function collectLayerEffects(state: DagState, layerId: NodeId): LayerEffectRow[] {
  const layer = state.nodes[layerId];
  if (!layer) return [];
  const srcId = refNodeIds(layer.inputs?.source)[0];
  if (!srcId) return [];
  const baseId = resolveEffectBase(state, srcId);
  return enumerateEffectStack(state, baseId).map((e) => {
    const p = state.nodes[e.nodeId].params as Record<string, unknown>;
    return {
      nodeId: e.nodeId,
      type: e.type,
      muted: e.muted,
      brightness: num(p.brightness, 1),
      contrast: num(p.contrast, 1),
      saturation: num(p.saturation, 1),
    };
  });
}

/** Ops to add an `effectType` effect onto `layerId`'s source edge (top of the
 *  stack, closest to the Layer). Resolves the base Image source (the MediaClip)
 *  then splices via the shared {@link buildAddEffectOps}. [] when no source. */
export function buildAddLayerEffectOps(state: DagState, layerId: NodeId, effectType: string): Op[] {
  const layer = state.nodes[layerId];
  if (!layer) return [];
  const srcId = refNodeIds(layer.inputs?.source)[0];
  if (!srcId) return [];
  const base = resolveEffectBase(state, srcId);
  const res = buildAddEffectOps(state, base, effectType);
  return res ? res.ops : [];
}

/**
 * The keyframe TIMES (seconds, ascending) of the free-floating [[V57]] channel that
 * animates (`layerId`, `paramPath`), for rendering the dopesheet diamonds on the
 * comp ruler. Mirrors `resolveChannel`'s node scan (a channel is any node whose
 * params carry `target` + `paramPath` + `keyframes`) — there is no separate channel
 * registry, so reading it is the same scan the keying path uses (no drift). Returns
 * [] when no channel targets the param.
 */
export function collectChannelKeyframes(
  state: DagState,
  layerId: NodeId,
  paramPath: string,
): number[] {
  const times: number[] = [];
  for (const node of Object.values(state.nodes)) {
    const p = node.params as { target?: unknown; paramPath?: unknown; keyframes?: unknown };
    if (p.target !== layerId || p.paramPath !== paramPath) continue;
    if (!Array.isArray(p.keyframes)) continue;
    for (const kf of p.keyframes) {
      const t = (kf as { time?: unknown }).time;
      if (typeof t === 'number' && Number.isFinite(t)) times.push(t);
    }
  }
  return times.sort((a, b) => a - b);
}
