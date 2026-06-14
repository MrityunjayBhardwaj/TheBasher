// gltfChildObjects — resolve a GltfAsset clone's per-child objects by the
// STAMPED node id, not by the three.js name (the H90/V44 follow-up).
//
// THE BUG THIS KILLS
// ==================
// GltfAssetR applies per-child TRS overrides and child suppression to the
// cloned scene by looking the object up via `nameToObject.get(name)`, where
// `name` is a `GltfAsset.nodeNameMap` KEY (the producer's sanitized name). But
// the clone's `o.name` is three's OWN sanitized/deduped name, and the two
// diverge on a real export (different sanitizer + dedup separator, plus
// material-split sub-meshes that are unnamed) — ~28% of children on the real
// cicada. So editing a TRS override or suppressing a name-mismatched child
// silently no-ops on the rendered clone (same root cause as the drill bug
// [[H90]], which was already fixed by drilling on the stamped id [[V44]]).
//
// THE FIX
// =======
// Every clone object already carries `userData.basherGltfChildId` (stamped by
// GltfAssetR via the glTF node-INDEX correspondence — the one key both sides
// agree on). `nodeNameMap[key]` IS that same childId (both are
// `hashId('gltfChild', assetRef, key)`), so resolve a child by id first
// (immune to name divergence) and fall back to the name only for un-stamped
// (pre-UX#7) projects → zero regression.
//
// REF: .anvi/hetvabhasa.md H90 (the FOLLOW-UP), .anvi/vyapti.md V44 (stamp by
//      stable index, never a re-derived name); src/viewport/SceneFromDAG.tsx
//      (GltfAssetR — the stamp site + the TRS/suppress consumers).

import type * as THREE from 'three';

/** Map every stamped clone object by its `userData.basherGltfChildId` (the
 *  GltfChild DAG node id). First stamp wins per id (the node's own object;
 *  material-split leaves share their ancestor's stamp only if re-stamped, which
 *  they are not — only node objects carry the association). */
export function buildChildIdToObject(root: THREE.Object3D): Map<string, THREE.Object3D> {
  const map = new Map<string, THREE.Object3D>();
  root.traverse((o) => {
    const id = (o.userData as { basherGltfChildId?: unknown })?.basherGltfChildId;
    if (typeof id === 'string' && id && !map.has(id)) map.set(id, o);
  });
  return map;
}

/** The clone object for a child, resolved by STAMPED id first (survives the
 *  H90 name divergence), then by three.js name (pre-stamp fallback). */
export function resolveChildObject(
  name: string,
  nodeNameMap: Record<string, string>,
  idToObject: Map<string, THREE.Object3D>,
  nameToObject: Map<string, THREE.Object3D>,
): THREE.Object3D | undefined {
  const childId = nodeNameMap[name];
  const byId = childId != null ? idToObject.get(childId) : undefined;
  return byId ?? nameToObject.get(name);
}
