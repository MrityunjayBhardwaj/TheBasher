// Pure enumeration of per-bone BAKED KeyframeChannel nodes for a glTF asset
// (P7.12 #108, copy-on-write edit layer). Shared by the TWO callers of the
// layering primitive (BLOCK-1) so both surfaces resolve the SAME baked band:
//   1. the renderer  — SceneFromDAG.GltfAssetR useFrame (C2)
//   2. the read-side — resolveEvaluatedTransform GltfChild branch (C3, gizmo/NPanel)
// A baked band threaded into only one surface produces a displayed-≠-rendered
// split (the #68/#77 second-surface bug class, H40) — hence ONE shared
// enumerator, not a per-surface re-implementation.
//
// BLOCK-2 (the dual key): the bake mutator (Wave D) stores BOTH
// `params.childName` (the glTF child name) AND `params.target` (= the GltfChild
// dagId, hashId('gltfChild', assetRef, childName)). This enumerator reads
// `childName` DIRECTLY — no per-frame nodeNameMap inverse scan — and uses the
// asset's `nodeNameMap` (childName → dagId) as the asset-membership scope:
// a channel belongs to THIS asset iff `nodeNameMap[childName] === params.target`
// (the two keys agree, by D1 construction).
//
// PRESENCE, not value (R-4): a component appears in the returned samplers iff a
// baked channel node drives it; the resolver (resolveGltfChildTrs) then lets
// presence win over the clip — never value-equality. Time-sampling is deferred:
// the enumerator returns sampler closures, the caller invokes them at its own
// cadence (the renderer's useFrame snapshot / the read-side ctx.time.seconds),
// so NO new time subscription is introduced (H48).
//
// REF: PLAN 7.12 Wave C (C2/C3, BLOCK-1/BLOCK-2); resolveGltfChildTransform.ts
//      (the layering primitive); vyapti V20/V24; hetvabhasa H40/H48.

import { buildVec3Sampler, type KeyframeChannelVec3Params } from '../nodes/KeyframeChannelVec3';
import type { Vec3 } from '../nodes/types';
import type { BakedChannel } from './resolveGltfChildTransform';

type ChannelSampler = (seconds: number) => Vec3;

/** A bone's baked component samplers (function-of-time, V24), by TRS component. */
export type BakedChannelSamplers = Partial<
  Record<'position' | 'rotation' | 'scale', ChannelSampler>
>;

/** Minimal node shape this enumerator reads — the DagState node subset it needs. */
interface ChannelNodeLike {
  readonly type: string;
  readonly params?: unknown;
}

/**
 * Enumerate the baked KeyframeChannelVec3 nodes belonging to ONE glTF asset,
 * keyed by childName → per-component sampler closures.
 *
 * @param nodes        the DAG node table (read-only).
 * @param nodeNameMap  the asset's childName → dagId map (GltfAssetValue.nodeNameMap)
 *                     — also the asset-membership scope (BLOCK-2).
 */
export function bakedChannelSamplersForAsset(
  nodes: Readonly<Record<string, ChannelNodeLike>>,
  nodeNameMap: Readonly<Record<string, string>>,
): Record<string, BakedChannelSamplers> {
  const out: Record<string, BakedChannelSamplers> = {};
  for (const node of Object.values(nodes)) {
    if (node.type !== 'KeyframeChannelVec3') continue;
    const p = node.params as { childName?: unknown; target?: unknown; paramPath?: unknown };
    if (typeof p.childName !== 'string' || typeof p.target !== 'string') continue;
    if (p.paramPath !== 'position' && p.paramPath !== 'rotation' && p.paramPath !== 'scale') {
      continue;
    }
    // BLOCK-2 membership: in THIS asset iff childName maps to a dagId here AND
    // the channel's stored target dagId agrees (D1 wrote them hashId-consistent).
    if (nodeNameMap[p.childName] !== p.target) continue;
    // Function-of-time (V24): build the sampler closure once here (per DAG
    // change), invoked per-frame by the caller. buildVec3Sampler is the SAME
    // sort+interp the node's evaluate uses — one source of the sampling math.
    (out[p.childName] ??= {})[p.paramPath] = buildVec3Sampler(
      node.params as KeyframeChannelVec3Params,
    );
  }
  return out;
}

/**
 * Sample a child's baked component samplers at `seconds` into a `BakedChannel`
 * (the per-component pre-sampled TRS the resolver layers). Returns `undefined`
 * when the child has no baked channel, so the resolver falls through to clip/base.
 * Present components win over the clip (presence, R-4); absent ones fall through.
 */
export function sampleBakedChannel(
  samplers: BakedChannelSamplers | undefined,
  seconds: number,
): BakedChannel | undefined {
  if (!samplers) return undefined;
  const out: { position?: Vec3; rotation?: Vec3; scale?: Vec3 } = {};
  if (samplers.position) out.position = samplers.position(seconds);
  if (samplers.rotation) out.rotation = samplers.rotation(seconds);
  if (samplers.scale) out.scale = samplers.scale(seconds);
  return out;
}
