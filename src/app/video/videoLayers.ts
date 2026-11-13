// videoLayers — read the ordered layer rows of a Composition from the DAG, with
// the node ids the timeline needs for editing (setParam/reorder). The timeline edits
// nodes, so it reads the raw graph: the layer stack under Composition.in (a chain of
// Layers on the Image lane, #1879) → each Layer node's params → its source's frame count.
//
// Pure (takes DagState) so it is unit-testable and the component just renders.
//
// REF: docs/COMPOSITOR-DESIGN.md §4.1/§4.2; vyapti V34 (data in the DAG);
//      sibling: videoTimelineGeometry; issue #237.

import type { DagState } from '../../core/dag/state';
import type { NodeId, NodeRef, Op, SocketId } from '../../core/dag/types';
import { buildAddEffectOps, enumerateEffectStack, resolveEffectBase } from '../operatorStack';
import { chainSocketOf } from '../operatorChain';
import { parseComfyParamPath, type ComfyApiJson } from '../../core/comfy/comfyGraph';
import {
  parseComfyControllerPath,
  scanBasherControllers,
} from '../../core/comfy/basherControllers';

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

// #1879 — how a composition stores its layer stack is known HERE and nowhere else: a chain on
// the Image lane. `Composition.in` reads the top layer's `out`; each Layer reads the one under
// it on `below`; the back layer's `below` is unwired. Every reader asks `compositionLayerIds`
// and every writer builds its ops here.

/** The comp's input the top of the stack arrives on. */
const COMP_IN = 'in';
/** A layer's own spine: everything below it in the stack. */
const BELOW = 'below';

/**
 * Every node on composition `compId`'s stack chain, TOP → back: the node `in` reads, then the
 * node on its declared chain socket, and so on until a node with no chain (or an unwired one).
 * Layers and any Image→Image step placed between them. Stops on a missing node or a cycle.
 */
function stackChainTopDown(state: DagState, compId: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const seen = new Set<NodeId>();
  let ref = refList(state.nodes[compId]?.inputs?.[COMP_IN])[0];
  while (ref && !seen.has(ref.node)) {
    const node = state.nodes[ref.node];
    if (!node) break;
    seen.add(node.id);
    out.push(node.id);
    const spine = chainSocketOf(node);
    if (!spine) break;
    ref = refList(node.inputs?.[spine])[0];
  }
  return out;
}

/** One entry of a composition's stack: a Layer, or a step between layers (an Image→Image
 *  operator such as Color Correct placed on the chain) that adjusts everything below it. */
export interface StackEntry {
  readonly kind: 'layer' | 'step';
  readonly id: NodeId;
}

/** Composition `compId`'s stack split into its entries (back→front) and the chainless node
 *  the back entry reads, if any (`base`): a plain Image source wired into the bottom, which
 *  has no spine and so always stays at the bottom. */
function compositionStackParts(
  state: DagState,
  compId: NodeId,
): { entries: StackEntry[]; base: NodeId | null } {
  const topDown = stackChainTopDown(state, compId);
  const last = topDown[topDown.length - 1];
  const base = last !== undefined && !chainSocketOf(state.nodes[last]) ? last : null;
  const entries = (base ? topDown.slice(0, -1) : topDown)
    .map((id): StackEntry => ({ kind: state.nodes[id]?.type === 'Layer' ? 'layer' : 'step', id }))
    .reverse();
  return { entries, base };
}

/**
 * Composition `compId`'s stack, back→front: its Layers and the steps between them (#1879
 * step 4). A step adjusts everything below it, so its place in this list is its scope.
 * [] when the comp is missing or its stack is empty.
 */
export function compositionStack(state: DagState, compId: NodeId): StackEntry[] {
  return compositionStackParts(state, compId).entries;
}

/**
 * The Layer node ids of composition `compId`, back→front. Steps between layers are walked
 * through and not listed. [] when the comp is missing or has no layers.
 */
export function compositionLayerIds(state: DagState, compId: NodeId): NodeId[] {
  return compositionStack(state, compId)
    .filter((e) => e.kind === 'layer')
    .map((e) => e.id);
}

/** The ops that put Layer `layerId` on top (front) of composition `compId`'s stack: the old top
 *  moves under it. */
export function stackLayerOnTopOps(state: DagState, compId: NodeId, layerId: NodeId): Op[] {
  const top = refList(state.nodes[compId]?.inputs?.[COMP_IN])[0];
  const ops: Op[] = [];
  if (top) {
    ops.push(
      { type: 'disconnect', from: top, to: { node: compId, socket: COMP_IN } },
      { type: 'connect', from: top, to: { node: layerId, socket: BELOW } },
    );
  }
  ops.push({
    type: 'connect',
    from: { node: layerId, socket: 'out' },
    to: { node: compId, socket: COMP_IN },
  });
  return ops;
}

/**
 * The ordered layer rows of `compId`, back→front (the stack's order), read through
 * `compositionLayerIds`: the stack is read down to the first missing node. Returns []
 * when the comp is missing or has no layers.
 */
export function collectLayerRows(state: DagState, compId: NodeId): LayerRow[] {
  const rows: LayerRow[] = [];
  for (const layerId of compositionLayerIds(state, compId)) {
    const layer = state.nodes[layerId]!;
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
      // #1879 — shown unless muted (the stack mute that bypasses the layer).
      enabled: p.muted !== true,
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
 * Ops to move `layerId` to index `toIndex` (0=back…last=front) among the comp's LAYERS. One
 * atomic batch → one undo. `toIndex` is clamped into range; [] (a no-op) when the comp/layer
 * is missing or the target equals the current index.
 *
 * Steps between layers (#1879 step 4) keep their place relative to the layers that do not
 * move: the moved layer lands directly on the far side of the last layer it passes (below it
 * when moving back, above it when moving forward). So moving a layer under an adjustment puts
 * it in that adjustment's reach and moving it over one takes it out, as an adjustment layer
 * behaves in After Effects. A chainless source wired into the bottom stays at the bottom.
 */
export function buildReorderLayerOps(
  state: DagState,
  compId: NodeId,
  layerId: NodeId,
  toIndex: number,
): Op[] {
  const { entries, base } = compositionStackParts(state, compId);
  const order = entries.map((e) => e.id); // back → front, layers and steps
  const layers = entries.filter((e) => e.kind === 'layer').map((e) => e.id);
  const from = layers.indexOf(layerId);
  if (from === -1) return [];
  const to = toIndex < 0 ? 0 : toIndex > layers.length - 1 ? layers.length - 1 : toIndex;
  if (to === from) return [];
  const passed = layers[to];
  const next = order.filter((id) => id !== layerId);
  const at = next.indexOf(passed);
  next.splice(to < from ? at : at + 1, 0, layerId);

  const spine = (id: NodeId): SocketId => chainSocketOf(state.nodes[id]) ?? BELOW;
  const ops: Op[] = [];
  // Down: the comp's read of the top, every entry's read of the one under it, the base's.
  ops.push({
    type: 'disconnect',
    from: { node: order[order.length - 1], socket: 'out' },
    to: { node: compId, socket: COMP_IN },
  });
  if (base) {
    ops.push({
      type: 'disconnect',
      from: { node: base, socket: 'out' },
      to: { node: order[0], socket: spine(order[0]) },
    });
  }
  for (let i = 1; i < order.length; i++) {
    ops.push({
      type: 'disconnect',
      from: { node: order[i - 1], socket: 'out' },
      to: { node: order[i], socket: spine(order[i]) },
    });
  }
  // Up, in the new order.
  if (base) {
    ops.push({
      type: 'connect',
      from: { node: base, socket: 'out' },
      to: { node: next[0], socket: spine(next[0]) },
    });
  }
  for (let i = 1; i < next.length; i++) {
    ops.push({
      type: 'connect',
      from: { node: next[i - 1], socket: 'out' },
      to: { node: next[i], socket: spine(next[i]) },
    });
  }
  ops.push({
    type: 'connect',
    from: { node: next[next.length - 1], socket: 'out' },
    to: { node: compId, socket: COMP_IN },
  });
  return ops;
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

/** One keyframe sample on the dopesheet, carrying the OWNING channel node id so the
 *  timeline can retime (`dispatchRetimeKeyframe`) or delete (`removeKeyframes`) it —
 *  not just `collectChannelKeyframes`' bare time. `time` is the EXACT stored float
 *  (the D-03 retime discriminator), read verbatim so the mutator's `k.time === from`
 *  filter matches by construction. */
export interface ChannelKeyframeSample {
  readonly channelId: NodeId;
  readonly time: number;
}

/**
 * The keyframe samples (channel id + exact time) of the free-floating [[V57]] channel
 * animating (`target`, `paramPath`) — the editable counterpart of
 * `collectChannelKeyframes` (which drops the channel id, fine for a read-only dot).
 * Same node scan, no separate registry (no drift). Sorted ascending by time.
 */
export function collectChannelKeyframeSamples(
  state: DagState,
  target: NodeId,
  paramPath: string,
): ChannelKeyframeSample[] {
  const samples: ChannelKeyframeSample[] = [];
  for (const node of Object.values(state.nodes)) {
    const p = node.params as { target?: unknown; paramPath?: unknown; keyframes?: unknown };
    if (p.target !== target || p.paramPath !== paramPath) continue;
    if (!Array.isArray(p.keyframes)) continue;
    for (const kf of p.keyframes) {
      const t = (kf as { time?: unknown }).time;
      if (typeof t === 'number' && Number.isFinite(t))
        samples.push({ channelId: node.id, time: t });
    }
  }
  return samples.sort((a, b) => a.time - b.time);
}

/** A keyed ComfyUIWorkflow SOURCE param surfaced as a timeline dopesheet row.
 *  Both Mode A (`controller:<id>`) and Mode B (`comfy:<id>.<input>`) channels target
 *  the ComfyUIWorkflow node (not the Layer), so this is the ONE enumeration covering
 *  both — symmetric by construction (V81 unified transport). */
export interface ComfySourceChannelRow {
  /** The channel paramPath — `comfy:3.cfg` (Mode B) or `controller:10` (Mode A). */
  readonly paramPath: string;
  /** Display label mirroring the Controls panel: `KSampler.cfg` (Mode B) or the
   *  controller's declared name (Mode A); falls back to the raw address. */
  readonly label: string;
  /** The channel's TARGET — the ComfyUIWorkflow node id (the TrackKeyframeRow nodeId). */
  readonly sourceNodeId: NodeId;
}

/**
 * The keyed comfy/controller SOURCE channels animating `layerId`'s ComfyUIWorkflow
 * source, as read-only dopesheet rows (their authoring surface is the Controls panel;
 * the timeline only MIRRORS the keyframe dots, V81 thesis: one channel, every surface).
 *
 * Resolves the layer's BASE source (through any effect chain, like collectLayerEffects)
 * to the ComfyUIWorkflow node, then scans the SAME (target,paramPath,keyframes) channel
 * shape collectChannelKeyframes reads — no separate registry, no drift. Labels are
 * derived directly from the workflow's apiJson (`class_type.input` for comfy:, the
 * declared controller name for controller:) so this needs no full graph import. Returns
 * [] when the source is not a ComfyUIWorkflow or no comfy/controller channel is keyed.
 */
export function collectComfySourceChannelRows(
  state: DagState,
  layerId: NodeId,
): ComfySourceChannelRow[] {
  const layer = state.nodes[layerId];
  if (!layer) return [];
  const srcId = refNodeIds(layer.inputs?.source)[0];
  if (!srcId) return [];
  const baseId = resolveEffectBase(state, srcId);
  const source = state.nodes[baseId];
  if (!source || source.type !== 'ComfyUIWorkflow') return [];
  const apiJson = (source.params as { graph?: { apiJson?: ComfyApiJson } } | undefined)?.graph
    ?.apiJson;

  const rows: ComfySourceChannelRow[] = [];
  for (const node of Object.values(state.nodes)) {
    const p = node.params as { target?: unknown; paramPath?: unknown; keyframes?: unknown };
    if (p.target !== baseId) continue;
    if (typeof p.paramPath !== 'string') continue;
    if (!Array.isArray(p.keyframes) || p.keyframes.length === 0) continue;
    const paramPath = p.paramPath;
    const controllerId = parseComfyControllerPath(paramPath);
    const comfyParsed = parseComfyParamPath(paramPath);
    if (!controllerId && !comfyParsed) continue; // a native channel that happens to target the source
    rows.push({
      paramPath,
      sourceNodeId: baseId,
      label: comfySourceChannelLabel(apiJson, controllerId, comfyParsed),
    });
  }
  // Stable order so the rows don't reshuffle between renders.
  return rows.sort((a, b) => a.paramPath.localeCompare(b.paramPath));
}

/** Mirror the Controls-panel row label for a keyed comfy/controller channel. */
function comfySourceChannelLabel(
  apiJson: ComfyApiJson | undefined,
  controllerId: string | null,
  comfyParsed: { nodeId: string; inputName: string } | null,
): string {
  if (controllerId) {
    // Mode A — the controller's DECLARED name (the same label the Controls row shows).
    if (apiJson) {
      const decl = scanBasherControllers(apiJson).find((d) => d.nodeId === controllerId);
      if (decl) return decl.name;
    }
    return `controller:${controllerId}`;
  }
  if (comfyParsed) {
    // Mode B — `class_type.input` (e.g. "KSampler.cfg"), the Controls row label.
    const classType = apiJson?.[comfyParsed.nodeId]?.class_type;
    return classType
      ? `${classType}.${comfyParsed.inputName}`
      : `${comfyParsed.nodeId}.${comfyParsed.inputName}`;
  }
  return '';
}
