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
import { bindMotionToCharacter, type BindMotionOutcome } from './bindMotionToCharacter';

/**
 * What a motion import produced, so a caller can act on it (#807).
 *
 * These two ids were always minted and always thrown away: `buildBvhImportOps`
 * returns them and this module destructured `{ ops }` alone, which left the
 * clip that had just landed unaddressable by anything downstream. Returning them
 * is what lets a drop bind the motion to a character instead of stopping at "the
 * nodes exist somewhere".
 */
export interface MotionImportResult {
  readonly skeletonId: string;
  readonly clipId: string;
}

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
export async function importBvhFromOpfs(path: string): Promise<MotionImportResult | null> {
  try {
    const storage = await getStorage();
    const bytes = await storage.read(path);
    const text = new TextDecoder().decode(bytes);
    const dag = useDagStore.getState();
    const { ops, skeletonId, clipId } = buildBvhImportOps(
      { text, name: nameFromPath(path) },
      dag.state,
    );
    dag.dispatchAtomic(ops, 'user', `import bvh: ${path}`);
    // Bump AFTER dispatch (pre-mortem: a pre-dispatch bump re-enumerates the
    // My-Imports list before the import lands → stale/empty on failure).
    useImportRefreshStore.getState().bump();
    return { skeletonId, clipId };
  } catch (err) {
    useAssetErrorStore.getState().report(path, `import failed: ${formatAssetError(err)}`);
    // `null` means "nothing landed", and the banner is already showing why. It is
    // NOT an empty success — a caller that went on to bind would find no clip.
    return null;
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
export async function importFbxFromOpfs(path: string): Promise<MotionImportResult | null> {
  try {
    const storage = await getStorage();
    const bytes = await storage.read(path);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const dag = useDagStore.getState();
    const { ops, skeletonId, clipId } = buildFbxImportOps(
      { data: copy.buffer, name: nameFromPath(path) },
      dag.state,
    );
    dag.dispatchAtomic(ops, 'user', `import fbx: ${path}`);
    useImportRefreshStore.getState().bump();
    return { skeletonId, clipId };
  } catch (err) {
    useAssetErrorStore.getState().report(path, `import failed: ${formatAssetError(err)}`);
    return null;
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
    bindImportedMotion(await importBvhFromOpfs(entryPath));
  } else if (lower.endsWith('.fbx')) {
    bindImportedMotion(await importFbxFromOpfs(entryPath));
  } else {
    useAssetErrorStore
      .getState()
      .report(entryPath, 'import failed: unsupported format (expected .gltf/.glb/.bvh/.fbx)');
  }
}

/**
 * Put a just-landed motion clip onto a character (#807).
 *
 * This sits at the extension dispatcher rather than in the drop handler on
 * purpose: the drop zone, the Import… picker and the Library all funnel through
 * here, and motion that animates a character when it is dropped but not when it
 * is picked would be a difference no director could predict. `null` means the
 * import itself failed and already reported — there is nothing to bind, and
 * saying anything more would be a second message about one problem.
 *
 * EXPORTED for the generation road (#820), which is the same argument one step
 * wider: a clip that animates a character when it is dropped but not when it is
 * generated is the same unpredictable difference, on the pair a director is far
 * more likely to notice. The generated road calls THIS function rather than
 * `bindMotionToCharacter` directly, so "bind after motion lands" — and the
 * null-handling that goes with it — is decided in exactly one place.
 *
 * `bindMotionToCharacter` surfaces its own outcome, so a caller that only wants
 * the motion bound can keep ignoring the return — the drop road above does, and
 * nothing is left unreported when it does.
 *
 * It is RETURNED rather than swallowed because the generation road needs to know
 * WHICH character was chosen (#730): a motion generated along an authored path
 * has to move that character to the path's start, and the choice is made in here.
 * `null` means no bind was attempted at all, which is a different answer from a
 * bind that was attempted and refused.
 */
export function bindImportedMotion(imported: MotionImportResult | null): BindMotionOutcome | null {
  if (!imported) return null;
  return bindMotionToCharacter(imported);
}
