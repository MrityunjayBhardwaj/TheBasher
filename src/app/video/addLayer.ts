// addLayer — wrap an Image-producing source node as a Layer in a Composition
// (Compositor spine 1c.2). The layer Add path: a source (a MediaClip today; a
// scene-render / ComfyWorkflow / nested comp later) becomes a Layer whose
// `source` edge consumes it, and the Layer is appended to the comp's `layers`
// list (index = z-order; append = on top).
//
// `buildAddLayerOps` is the pure primitive (addNode Layer + two connects),
// mirroring addPrimitives' addNode→connect-into-list discipline. The media path
// folds the MediaClip node + the Layer into ONE atomic op chain so "add a media
// layer" is a single undo.
//
// REF: docs/COMPOSITOR-DESIGN.md §4.2/§4.3; vyapti V1 (one op path) + V34;
//      sibling: addPrimitives (addNode→connect into a list socket); issue #237.

import type { NodeId, Op } from '../../core/dag/types';
import { useDagStore } from '../../core/dag/store';
import { buildMediaClipOps, freshMediaClipId, ingestMediaClipFile } from '../asset/importMediaClip';
import { pickMediaFiles } from '../asset/importPicker';
import type { IngestFile } from '../asset/importGltf';

/**
 * Build the ops wrapping `sourceNodeId` (an Image producer) as a new Layer in the
 * Composition `compId`: addNode(Layer) → connect(source.out → Layer.source) →
 * connect(Layer.out → Composition.layers). Pure; the caller mints `layerId`.
 * Appends to the `layers` list (no `index`) → the new layer lands on top (front).
 */
export function buildAddLayerOps(
  layerId: NodeId,
  compId: NodeId,
  sourceNodeId: NodeId,
  name: string,
): Op[] {
  return [
    { type: 'addNode', nodeId: layerId, nodeType: 'Layer', params: { name } },
    {
      type: 'connect',
      from: { node: sourceNodeId, socket: 'out' },
      to: { node: layerId, socket: 'source' },
    },
    {
      type: 'connect',
      from: { node: layerId, socket: 'out' },
      to: { node: compId, socket: 'layers' },
    },
  ];
}

/** A fresh Layer node id given the ids already in use. */
export function freshLayerId(usedIds: Iterable<NodeId>): NodeId {
  const used = new Set(usedIds);
  let n = 1;
  while (used.has(`layer_${n}`)) n++;
  return `layer_${n}`;
}

/**
 * Ingest one media file and add it as a Layer in `compId` — MediaClip node + Layer
 * + connects in ONE atomic op (a single undo). Returns the new Layer id, or null
 * on ingest failure (surfaced through the asset error store). Does NOT throw.
 */
export async function importMediaClipAsLayer(
  file: IngestFile,
  compId: NodeId,
): Promise<NodeId | null> {
  const ingested = await ingestMediaClipFile(file);
  if (!ingested) return null;

  const dag = useDagStore.getState();
  const usedIds = new Set(Object.keys(dag.state.nodes));
  const mediaId = freshMediaClipId(usedIds);
  usedIds.add(mediaId);
  const layerId = freshLayerId(usedIds);

  const ops: Op[] = [
    ...buildMediaClipOps(mediaId, ingested.name, ingested.opfsPath, ingested.probe),
    ...buildAddLayerOps(layerId, compId, mediaId, ingested.name),
  ];
  dag.dispatchAtomic(ops, 'user', `add media layer: ${ingested.name}`);
  return layerId;
}

/** Open the media file picker and add each picked clip as a Layer in `compId`. */
export function openAddMediaLayerPicker(compId: NodeId): void {
  pickMediaFiles((file) => importMediaClipAsLayer(file, compId).then(() => undefined));
}
