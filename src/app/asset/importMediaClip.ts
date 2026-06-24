// importMediaClip — ingest a media file into a MediaClip node (Compositor spine
// slice 1b). The SAME ingest discipline as glTF/BVH (V34 one path): bytes →
// probe → OPFS write (`ingestSingleFile`) → ONE dispatchAtomic adding the node;
// failures route to `useAssetErrorStore`, never console.error.
//
// The op-builder (`buildMediaClipOps`) is pure + unit-tested; the orchestration
// (`importMediaClipFromFile`) does the probe + OPFS write + dispatch. Decode of
// the actual pixels is the compositor/runtime's job (the MediaDecodeCapability) —
// here we only probe metadata to populate the node params.
//
// REF: docs/COMPOSITOR-DESIGN.md §4.4; vyapti V34 (one ingest path) + V8 (app
//      layer, no src/viewport import); sibling: importGltf / importBvhFbx.

import type { MediaProbe } from '../../core/media';
import { pickMediaDecode } from '../../core/media';
import type { NodeId, Op } from '../../core/dag/types';
import { useDagStore } from '../../core/dag/store';
import { formatAssetError, useAssetErrorStore } from '../stores/assetErrorStore';
import { ingestSingleFile, type IngestFile } from './importCommon';

/** Build the ops adding a MediaClip node for a probed, OPFS-written clip. Pure —
 *  the caller supplies a fresh `nodeId` (so the op is deterministic + testable). */
export function buildMediaClipOps(
  nodeId: NodeId,
  name: string,
  opfsPath: string,
  probe: MediaProbe,
): Op[] {
  return [
    {
      type: 'addNode',
      nodeId,
      nodeType: 'MediaClip',
      params: {
        name,
        src: opfsPath,
        mediaKind: probe.mediaKind,
        srcFps: probe.srcFps,
        srcFrames: probe.srcFrames,
        width: probe.width,
        height: probe.height,
      },
    },
  ];
}

function nextFreshId(base: string, used: Set<NodeId>): NodeId {
  let n = 1;
  while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/** The display name for a clip = its file basename without extension. */
function clipNameFromFile(file: IngestFile): string {
  const base = file.relativePath.split('/').filter(Boolean).pop() ?? file.relativePath;
  return base.replace(/\.[^.]+$/, '') || base;
}

/** A media file probed + written to OPFS, ready to become a MediaClip node.
 *  The shared ingest core (decode probe → OPFS write), with no DAG dispatch — so
 *  callers can either add a bare MediaClip (`importMediaClipFromFile`) or fold the
 *  node into a larger atomic op chain (e.g. wrap it as a compositor Layer). */
export interface IngestedMediaClip {
  name: string;
  opfsPath: string;
  probe: MediaProbe;
}

/**
 * Probe + OPFS-write one media file. Returns the ingested clip (no DAG mutation),
 * or null on failure (surfaced through `useAssetErrorStore`). Does NOT throw.
 */
export async function ingestMediaClipFile(file: IngestFile): Promise<IngestedMediaClip | null> {
  const name = clipNameFromFile(file);
  try {
    const decode = pickMediaDecode();
    const probe = await decode.probe(file.bytes, file.relativePath);
    const opfsPath = await ingestSingleFile(file, name);
    return { name, opfsPath, probe };
  } catch (err) {
    const message = formatAssetError(err);
    if (!message.startsWith('import failed:')) {
      useAssetErrorStore.getState().report(name, `import failed: ${message}`);
    }
    return null;
  }
}

/** A fresh MediaClip node id given the ids already in use. Exposed so a combined
 *  op chain (clip + Layer) can mint the clip id before building its ops. */
export function freshMediaClipId(usedIds: Iterable<NodeId>): NodeId {
  return nextFreshId('media', new Set(usedIds));
}

/**
 * Ingest one media file → a MediaClip node. Returns the new node id, or null on
 * failure (the reason is surfaced through `useAssetErrorStore`). Does NOT throw.
 */
export async function importMediaClipFromFile(file: IngestFile): Promise<NodeId | null> {
  const ingested = await ingestMediaClipFile(file);
  if (!ingested) return null;

  const dag = useDagStore.getState();
  const nodeId = freshMediaClipId(Object.keys(dag.state.nodes));
  dag.dispatchAtomic(
    buildMediaClipOps(nodeId, ingested.name, ingested.opfsPath, ingested.probe),
    'user',
    `import media: ${ingested.name}`,
  );
  return nodeId;
}
