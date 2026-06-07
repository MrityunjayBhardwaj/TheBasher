// v0.6 #2 (#178, W6 — D-05/D-07) — submesh-slot enumeration for the NPanel slot
// selector. A `MaterialOverride` wraps (via its `target` input, possibly through
// Transform/nested-override hops) a `GltfAsset`. To offer "edit slot N" the
// inspector must know how many material slots that glTF renders.
//
// A "slot" is the i-th `isMesh` in the cloned glTF's traverse order — the SAME
// order GltfAssetR's override effect counts (`slotIdx`) and the
// `__basher_gltf_meshes` seam reports. The count is read off the LIVE clone via
// the production-safe `gltfCloneRegistry` (#151) — NOT a DEV seam, so it works in
// the shipped app. The read is a one-shot snapshot (a selector, not a render
// subscription — the [[H40]]/B12 subscribed-selector rule is for render
// consumers, not for inspector reads), so a freshly-loaded asset may report 0
// until its clone mounts; the selector treats 0/1 as "no submesh choice".

import * as THREE from 'three';
import type { InputBinding, Node } from '../core/dag/types';
import { getGltfClone } from './asset/gltfCloneRegistry';

/**
 * Walk a MaterialOverride/Transform `target` chain to the `GltfAsset` it wraps
 * and return that asset's `assetRef`. `null` when the chain doesn't terminate at
 * a glTF (e.g. the override wraps a primitive, or the target is unconnected).
 * Cycle-guarded.
 */
export function findTargetAssetRef(
  nodes: Readonly<Record<string, Node>>,
  startId: string,
): string | null {
  let cur: Node | undefined = nodes[startId];
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.type === 'GltfAsset') {
      const ref = (cur.params as { assetRef?: unknown } | undefined)?.assetRef;
      return typeof ref === 'string' ? ref : null;
    }
    const target: InputBinding | undefined = cur.inputs?.target;
    const nextId: string | undefined = target && !Array.isArray(target) ? target.node : undefined;
    cur = nextId ? nodes[nextId] : undefined;
  }
  return null;
}

/**
 * Count the renderable material slots (isMesh entries, traverse order) of the
 * glTF the override at `startId` targets, via the live clone registry. Returns 0
 * when the override doesn't target a loaded glTF — the caller reads "no submesh
 * selector" (a primitive, or a single-material/not-yet-mounted asset).
 */
export function countOverrideSlots(nodes: Readonly<Record<string, Node>>, startId: string): number {
  const ref = findTargetAssetRef(nodes, startId);
  if (!ref) return 0;
  const clone = getGltfClone(ref);
  if (!clone) return 0;
  let n = 0;
  clone.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) n += 1;
  });
  return n;
}
