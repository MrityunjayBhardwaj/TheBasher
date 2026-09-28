// characterParts — which imported character a node stands for, and the parts (glTF nodes, bones)
// inside it. Pure reads of the node table, nothing else: the Track-To schema's bone picker reaches
// this module while the node registry is still loading, so it must import nothing that can lead
// back into it (#1284; the load cycle a schema import once closed through boot.ts).

import type { DagState } from '../core/dag/state';
import { reachedFromSelection } from './character/reachedFromSelection';

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
  if (!assetId) return nativeRigsOf(state, nodeId).flatMap((r) => r.boneNames);
  const map = (state.nodes[assetId].params as { nodeNameMap?: Record<string, string> }).nodeNameMap;
  return map ? Object.keys(map) : [];
}

/**
 * The NATIVE armatures `nodeId` stands for, and their bones' names, read off the node table (#1284 on
 * the native road). A native character has no GltfAsset to name its parts: its bones are its
 * Skeleton's own params, and its armature Object is reached by the rule a bind uses
 * (`reachedFromSelection`: the armature Object, a mesh Object it deforms, or what holds either).
 * Every skinned glTF imports this way, and a saved clone-road character converts to it on load
 * (#1216), so without this a bone picker offered nothing and a bone aim fell back to the Object.
 * Armature Objects in id order (V22), bones in rig order.
 */
export function nativeRigsOf(
  state: DagState,
  nodeId: string,
): { readonly objectId: string; readonly boneNames: string[] }[] {
  const reached = reachedFromSelection(state, nodeId);
  const out: { objectId: string; boneNames: string[] }[] = [];
  for (const id of [...reached].sort()) {
    const node = state.nodes[id];
    if (node?.type !== 'Object') continue;
    const data = state.nodes[refsOf((node.inputs as Record<string, unknown> | undefined)?.data)[0]];
    if (data?.type !== 'Skeleton') continue;
    const bones = (data.params as { bones?: { name?: unknown }[] } | undefined)?.bones ?? [];
    out.push({
      objectId: id,
      boneNames: bones.map((b) => b.name).filter((n): n is string => typeof n === 'string'),
    });
  }
  return out;
}
