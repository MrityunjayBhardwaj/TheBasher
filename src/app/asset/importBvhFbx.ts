// BVH / FBX OPFS import chokepoints + the cross-format extension dispatcher —
// Phase 7.14 Wave A (issue #111).
//
// The BVH and FBX importers (`buildBvhImportOps` / `buildFbxImportOps`) already
// exist and emit ONLY a Skeleton + AnimationClip pair (FBX in Basher is MOTION,
// not a model — P3.1 Mixamo-retarget heritage). Until now they were reachable
// only through the `__basher_importBvh` / `__basher_importFbx` dev seams
// (boot.ts:240-255). This module is the missing INGESTION SURFACE: read the
// OPFS bytes a drop/picker wrote, decode them per-format, build the op chain,
// dispatch atomically (K6), and bump the My-Imports refresh signal.
//
// Asymmetry vs glTF (grounded, CONTEXT D-03): glTF persists an `assetRef` on
// its GltfAsset node; BVH/FBX leave NO persistent reference (they dispatch
// Skeleton+AnimationClip and nothing holds the OPFS path afterwards). So a
// re-import is a fresh import, and a My-Imports rename of a BVH/FBX entry is a
// folder move only — no ref rewrite.
//
// Invariants honored:
//   - V8: no `src/viewport/` imports. App-layer module.
//   - K6: ONE dispatchAtomic per import.
//   - silent-failure: every failure path routes to assetErrorStore — a bad
//     decode or a missing TimeSource surfaces in the banner, never console-only.
//
// REF: phase 7.14 PLAN Wave A (A2), CONTEXT D-02/D-03/D-04; boot.ts:240-255
//      (the existing seams); bvhImportChain.ts / fbxImportChain.ts (the
//      importers, unchanged).

import { useDagStore } from '../../core/dag/store';
import { buildBvhImportOps } from '../../core/import/bvhImportChain';
import { buildFbxImportOps } from '../../core/import/fbxImportChain';
import { getStorage } from '../boot';
import { formatAssetError, useAssetErrorStore } from '../stores/assetErrorStore';
import { useImportRefreshStore } from '../stores/importRefreshStore';
import { importGltfFromOpfs } from './importGltf';

/** Strip the directory + extension to a display name for the import label. */
function nameFromPath(path: string): string {
  const base = path.split('/').filter(Boolean).pop() ?? path;
  return base.replace(/\.[^.]+$/, '') || base;
}

/**
 * Read a `.bvh` from OPFS and import it as a Skeleton + AnimationClip.
 *
 * BVH is TEXT: decode the bytes with TextDecoder before parsing. A wrong decode
 * (or a TimeSource-less project) throws inside `buildBvhImportOps`; the catch
 * routes it to assetErrorStore so the failure is visible, not swallowed.
 */
export async function importBvhFromOpfs(path: string): Promise<void> {
  try {
    const storage = await getStorage();
    const bytes = await storage.read(path);
    const text = new TextDecoder().decode(bytes);
    const dag = useDagStore.getState();
    const { ops } = buildBvhImportOps({ text, name: nameFromPath(path) }, dag.state);
    dag.dispatchAtomic(ops, 'user', `import bvh: ${path}`);
    // Bump AFTER dispatch (pre-mortem: a pre-dispatch bump re-enumerates the
    // My-Imports list before the import lands → stale/empty on failure).
    useImportRefreshStore.getState().bump();
  } catch (err) {
    useAssetErrorStore.getState().report(path, `import failed: ${formatAssetError(err)}`);
  }
}

/**
 * Read a `.fbx` from OPFS and import it as a Skeleton + AnimationClip.
 *
 * FBX is BINARY: pass the raw ArrayBuffer straight to `buildFbxImportOps`
 * (`parseFbx` accepts ArrayBuffer | string). Detach a fresh, non-shared
 * ArrayBuffer (the OPFS read may back a SharedArrayBuffer) so the parser gets a
 * plain buffer — mirror of the glTF detach in buildGltfImportOpsFromOpfs.
 */
export async function importFbxFromOpfs(path: string): Promise<void> {
  try {
    const storage = await getStorage();
    const bytes = await storage.read(path);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const dag = useDagStore.getState();
    const { ops } = buildFbxImportOps({ data: copy.buffer, name: nameFromPath(path) }, dag.state);
    dag.dispatchAtomic(ops, 'user', `import fbx: ${path}`);
    useImportRefreshStore.getState().bump();
  } catch (err) {
    useAssetErrorStore.getState().report(path, `import failed: ${formatAssetError(err)}`);
  }
}

/**
 * Route an already-ingested OPFS entry to the right per-format importer by its
 * file extension. The single dispatch point that AssetDropZone + MenuBar call
 * after writing bytes to OPFS (D-04: one affordance accepts all four formats).
 *
 * An unrecognised extension is NOT a silent no-op — it reports to
 * assetErrorStore so a mistaken drop tells the user why nothing happened.
 */
export async function routeImportByExtension(entryPath: string): Promise<void> {
  const lower = entryPath.toLowerCase();
  if (lower.endsWith('.gltf') || lower.endsWith('.glb')) {
    await importGltfFromOpfs(entryPath);
  } else if (lower.endsWith('.bvh')) {
    await importBvhFromOpfs(entryPath);
  } else if (lower.endsWith('.fbx')) {
    await importFbxFromOpfs(entryPath);
  } else {
    useAssetErrorStore
      .getState()
      .report(entryPath, 'import failed: unsupported format (expected .gltf/.glb/.bvh/.fbx)');
  }
}
