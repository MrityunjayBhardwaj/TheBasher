// characterParts — which imported character a node stands for, and the parts (glTF nodes, bones)
// inside it. Pure reads of the node table, nothing else: the Track-To schema's bone picker reaches
// this module while the node registry is still loading, so it must import nothing that can lead
// back into it (#1284; the load cycle a schema import once closed through boot.ts).

import type { DagState } from '../core/dag/state';

function refsOf(binding: unknown): string[] {
  const list = Array.isArray(binding) ? binding : binding ? [binding] : [];
  return list
    .map((r) => (r as { node?: unknown })?.node)
    .filter((n): n is string => typeof n === 'string');
}

/**
 * The imported character `nodeId` stands for: the node itself when it is a GltfAsset, else the
 * first GltfAsset reached down its inputs (a Group holding the character). Deterministic: inputs
 * are walked breadth-first in socket-name order. Null when there is none.
 */
export function characterAssetOf(state: DagState, nodeId: string): string | null {
  const seen = new Set<string>();
  const queue = [nodeId];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = state.nodes[id];
    if (!node) continue;
    if (node.type === 'GltfAsset') return id;
    const inputs = (node.inputs ?? {}) as Record<string, unknown>;
    for (const socket of Object.keys(inputs).sort()) queue.push(...refsOf(inputs[socket]));
  }
  return null;
}

/** The glTF node names of the character `nodeId` stands for, in the asset's own order. */
export function characterNodeNames(state: DagState, nodeId: string): string[] {
  const assetId = characterAssetOf(state, nodeId);
  if (!assetId) return [];
  const map = (state.nodes[assetId].params as { nodeNameMap?: Record<string, string> }).nodeNameMap;
  return map ? Object.keys(map) : [];
}
