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
// its channel order; a muted layer's rows dimmed. Blender's dope sheet shows the selected objects'
// action curves ("Only Show Selected", on by default), grouped by bone.
//
// REF: src/agent/mutators/builders/channelAddress.ts (`LayerChannelAddress`, the layer form);
//      src/app/animate/poseChain.ts (`poseLayerChain`); src/nodes/PoseLayer.ts; issue #1215.

import type { Node } from '../core/dag/types';
import type { PoseLayerParams } from '../nodes/PoseLayer';
import type {
  ChannelAddressed,
  LayerChannelAddress,
} from '../agent/mutators/builders/channelAddress';
import { LAYER_CHANNEL_COMPONENTS } from '../agent/mutators/builders/channelAddress';
import { poseLayerChain } from '../app/animate/poseChain';
import type { GraphNodeLike } from '../app/animate/graphNodes';
import type { ChannelRow } from './clipChannelRows';

const PREFIX = 'layer:';

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
        ...(params.mute ? { mute: true } : {}),
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
