// gltfCloneRegistry — a PRODUCTION-SAFE accessor to the mounted SkeletonUtils
// clone of a GltfAsset, keyed by assetRef (Phase 151 Apply-Transform, Wave 4,
// issue #151).
//
// THE PROBLEM (the Wave 4 crux): a GltfChild's geometry + material live BY NAME
// inside the GltfAsset's SkeletonUtils clone. `geometryRegistry.get()` returns
// null for gltf (the bytes live in the loaded asset, not the box/sphere builder),
// so `dispatchApplyTransform` — a non-React helper — has no handle to that clone.
//
// THE OPTIONS WEIGHED (RESEARCH §Q4 / the crux brief):
//   (a) a module-level registry mapping assetRef → the mounted cloned Group,
//       populated by GltfAssetR on mount/unmount. The captured geometry/material
//       is then the RESOLVED, POST-OVERRIDE render state (H58/H59 bake-what-
//       renders) WITHOUT re-resolution — it is the exact object the renderer drew.
//   (b) re-load the glTF fresh in the dispatch helper and walk it. Heavier, AND
//       it would re-introduce a PARALLEL resolution walk (re-apply MaterialOverride
//       + TRS resolution by hand) — exactly the H40/H58/H59 drift the one-resolver
//       discipline forbids.
//
// CHOSEN: (a). It mirrors the existing live-three accessor pattern already in
// GltfAssetR (`__basher_gltf_skin` / `__basher_gltf_meshes` window getters off the
// SAME clone), but is NOT DEV-gated — `__basher_gltf_meshes` is `import.meta.env.DEV`
// only, and shipping a DEV-only seam in the production Apply path would make Apply
// silently no-op in prod (a silent-failure footgun). This registry is always on.
//
// LIFECYCLE: GltfAssetR registers the clone on mount (and on every clone swap)
// and unregisters on unmount. The last asset to mount for a given assetRef wins —
// matching the single-asset-per-assetRef assumption the other clone seams make
// (and the gizmo/skin getters). dispatchApplyTransform reads the clone, clones the
// child geometry (H45 — never mutate the shared clone), and READS the material
// (read-only capture, H45/M9).
//
// REF: PLAN.md Wave 4 Task 10; RESEARCH §Q4/§M2; hetvabhasa H45/H58/H59;
//      SceneFromDAG.tsx GltfAssetR (the populator + the mirrored DEV seams).

import type * as THREE from 'three';

/** assetRef → the live, mounted, post-override SkeletonUtils clone Group. */
const clones = new Map<string, THREE.Group>();

/** Register (or replace) the mounted clone for an assetRef. Called by GltfAssetR
 *  on mount + clone swap. The newest mount wins (single-asset-per-ref assumption). */
export function registerGltfClone(assetRef: string, clone: THREE.Group): void {
  clones.set(assetRef, clone);
}

/** Unregister on unmount. Only clears the entry if it still points at THIS clone
 *  — avoids a late unmount clobbering a newer asset that re-registered the ref. */
export function unregisterGltfClone(assetRef: string, clone: THREE.Group): void {
  if (clones.get(assetRef) === clone) clones.delete(assetRef);
}

/** The mounted clone for an assetRef, or null if none is currently rendered. */
export function getGltfClone(assetRef: string): THREE.Group | null {
  return clones.get(assetRef) ?? null;
}

/** Test-only — clear the registry between cases. */
export function __clearGltfCloneRegistryForTests(): void {
  clones.clear();
}
