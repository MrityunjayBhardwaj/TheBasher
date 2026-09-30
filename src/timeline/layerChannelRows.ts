// layerChannelRows — the dopesheet rows for a character's keys, read where they live: in the pose
// layers under its armature Object (#1215, step 6 of "Bones as Channels").
//
// A layer's keys are entries in its channel list, not channel nodes, so the row id is its own form,
// `layer:<layerId>:<component>:<bone>` (each part URI-encoded: a bone name keeps Blender's spelling,
// dots and colons included). Every editor turns a row id into a channel address with `rowAddress`,
// and the address resolver (`resolveChannelAddress`) turns that into the view and the write — one
// road for the timeline, the keyboard and the agent.
//
// Which rows: the selected armature Object's layers, top of the chain first, each layer's curves in
// its channel order; a muted layer's rows dimmed. A row's M is its curve's own mute (Blender's F-curve
// mute); a layer curve has no solo. Blender's dope sheet shows the selected objects'
// action curves ("Only Show Selected", on by default), grouped by bone.
//
// Below the layers, the computed motion the chain stands on (a retarget, a generated clip) shows
// read-only (`computedSourceRows`): the keys a bake at every pose would write, and bake is the one road
// to editing them. Houdini shows motion-clip keys read-only and authored keys editable
// (`kinefx--rigpose.txt:125,433`); design rule 9.
//
// REF: src/agent/mutators/builders/channelAddress.ts (`LayerChannelAddress`, the layer form);
//      src/app/animate/poseChain.ts (`poseLayerChain`); src/nodes/PoseLayer.ts;
//      src/app/animate/bakePose.ts (`computedSourceOf`, `bakeTimes`); issue #1215.

import type { Node } from '../core/dag/types';
import type { DagState } from '../core/dag/state';
import { createEvaluatorCache, evaluate, type EvaluatorCache } from '../core/dag/evaluator';
import type { PosedSkeletonValue } from '../nodes/types';
import { bakeTimes, computedSourceOf } from '../app/animate/bakePose';
import type { PoseLayerParams } from '../nodes/PoseLayer';
import type {
  ChannelAddressed,
  LayerChannelAddress,
} from '../agent/mutators/builders/channelAddress';
import { LAYER_CHANNEL_COMPONENTS } from '../agent/mutators/builders/channelAddress';
import { poseLayerChain } from '../app/animate/poseChain';
import type { GraphNodeLike } from '../app/animate/graphNodes';
import type { ChannelRow } from './channelRow';

const PREFIX = 'layer:';
const COMPUTED_PREFIX = 'computed:';
/** What a bake keys for each bone of the wire (`bakedLayerParams`), in its order. */
const BAKED_COMPONENTS = ['position', 'quaternion', 'scale'] as const;

/** The row id of a layer channel. */
export function layerRowId(address: LayerChannelAddress): string {
  const part = encodeURIComponent;
  return `${PREFIX}${part(address.layerId)}:${address.component}:${part(address.bone)}`;
}

/** The address a layer row id names, or null for any other row. */
export function parseLayerRowId(rowId: string): LayerChannelAddress | null {
  if (!rowId.startsWith(PREFIX)) return null;
  const [layer, component, bone, ...rest] = rowId.slice(PREFIX.length).split(':');
  if (layer === undefined || component === undefined || bone === undefined || rest.length > 0) {
    return null;
  }
  if (!(LAYER_CHANNEL_COMPONENTS as readonly string[]).includes(component)) return null;
  return {
    layerId: decodeURIComponent(layer),
    bone: decodeURIComponent(bone),
    component: component as LayerChannelAddress['component'],
  };
}

/** A timeline row id as the channel address the key tools take. */
export function rowAddress(rowId: string): ChannelAddressed {
  const layer = parseLayerRowId(rowId);
  return layer ? { layer } : { channelId: rowId };
}

/** The rows of every layer under `objectId`, top of the chain first. */
export function layerChannelRows(nodes: Record<string, Node>, objectId: string): ChannelRow[] {
  const { layers } = poseLayerChain(
    nodes as unknown as Readonly<Record<string, GraphNodeLike>>,
    objectId,
  );
  const rows: ChannelRow[] = [];
  for (const layerId of layers) {
    const params = nodes[layerId].params as PoseLayerParams;
    const layerName = params.name || layerId;
    for (const channel of params.channels ?? []) {
      const what =
        channel.component === 'weight' ? 'weight' : `${channel.bone} ${channel.component}`;
      rows.push({
        channelId: layerRowId({
          layerId,
          bone: channel.component === 'weight' ? '' : channel.bone,
          component: channel.component,
        }),
        name: `${layerName} — ${what}`,
        keyframes: [...channel.keyframes].sort((a, b) => a.time - b.time),
        // The curve's own mute (the gutter's M toggles it); its layer's mute only dims the row.
        ...(channel.mute === true ? { mute: true } : {}),
        ...(params.mute ? { layerMuted: true } : {}),
        noSolo: true,
      });
    }
  }
  return rows;
}

/** `baseRows` with the selected armature Object's layer rows appended; unchanged otherwise. */
export function appendLayerRows(args: {
  baseRows: ChannelRow[];
  nodes: Record<string, Node>;
  selectedNodeId: string | null;
}): ChannelRow[] {
  const { baseRows, nodes, selectedNodeId } = args;
  if (!selectedNodeId || nodes[selectedNodeId]?.type !== 'Object') return baseRows;
  const rows = layerChannelRows(nodes, selectedNodeId);
  return rows.length === 0 ? baseRows : [...baseRows, ...rows];
}

/** A cache for `computedSourceRows` to hold across renders (the caller keeps it; this file evaluates). */
export function computedSourceCache(): EvaluatorCache {
  return createEvaluatorCache();
}

/** The row id of one curve of the computed source `node` would bake to. */
export function computedRowId(node: string, component: string, bone: string): string {
  const part = encodeURIComponent;
  return `${COMPUTED_PREFIX}${part(node)}:${component}:${part(bone)}`;
}

/** True for a computed source's read-only row. */
export function isComputedRowId(rowId: string): boolean {
  return rowId.startsWith(COMPUTED_PREFIX);
}

/**
 * The computed motion under `objectId`'s pose chain as read-only rows: every bone of the source's wire
 * × position / quaternion / scale, a key at each of its poses — what a bake at every pose would write.
 * Empty when the chain stands on its skeleton's rest pose (its motion is keys already, in the layers).
 * A source that cannot be read, or has no range to take poses from, is ONE row saying so, never no
 * rows: "could not look" must not read as "nothing there".
 *
 * `cache` is the caller's stable evaluator cache: the source is re-evaluated only when its own inputs
 * change, not on every edit elsewhere in the graph.
 */
export function computedSourceRows(
  state: DagState,
  objectId: string,
  cache?: EvaluatorCache,
): ChannelRow[] {
  const source = computedSourceOf(state, objectId);
  if (source === null) return [];
  const node = state.nodes[source.node];
  const sourceName = (node.params as { name?: unknown }).name;
  const label = typeof sourceName === 'string' && sourceName.length > 0 ? sourceName : source.node;
  const notice = (why: string): ChannelRow[] => [
    {
      channelId: computedRowId(source.node, 'none', ''),
      name: `${label} — ${why}`,
      keyframes: [],
      readOnly: true,
    },
  ];
  let wire: PosedSkeletonValue | undefined;
  try {
    wire = evaluate(state, source.node, { socket: source.socket, cache }).value as
      | PosedSkeletonValue
      | undefined;
  } catch (error) {
    return notice(`could not be read (${(error as Error).message})`);
  }
  if (!wire?.skeleton) return notice('could not be read (no pose on the wire)');
  const times = bakeTimes(wire, { kind: 'every' });
  if (!times.ok) return notice('no poses to show (the motion has no range)');
  const keyframes = times.times.map((time) => ({ time }));
  return wire.skeleton.bones.flatMap((bone) =>
    BAKED_COMPONENTS.map((component) => ({
      channelId: computedRowId(source.node, component, bone.name),
      name: `${label} — ${bone.name} ${component}`,
      keyframes,
      readOnly: true,
    })),
  );
}

/** `baseRows` with the selected armature Object's computed source rows appended; unchanged otherwise. */
export function appendComputedSourceRows(args: {
  baseRows: ChannelRow[];
  state: DagState;
  selectedNodeId: string | null;
  cache?: EvaluatorCache;
}): ChannelRow[] {
  const { baseRows, state, selectedNodeId, cache } = args;
  if (!selectedNodeId || state.nodes[selectedNodeId]?.type !== 'Object') return baseRows;
  const rows = computedSourceRows(state, selectedNodeId, cache);
  return rows.length === 0 ? baseRows : [...baseRows, ...rows];
}
