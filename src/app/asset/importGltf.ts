// Shared glTF import core — Phase 7.9 Wave A (issue #110).
//
// One chokepoint for every disk → DAG glTF import path in the app:
//   - the AssetDropZone OS-file/folder drop branch (Wave C)
//   - the File-menu "Import glTF…" webkitdirectory picker (Wave D)
//   - the existing Library-drag path (Wave C — refactored to call here)
//   - the e2e `__basher_ingestGltfFolder` dev seam (Wave D)
//
// Why one core (B12, V20-adjacent): three call sites today already
// re-implement read-OPFS → detach-buffer → buildGltfImportOps →
// dispatchAtomic in subtly divergent shapes. Collapsing them here
// makes the glTF chokepoint a single audit point and matches the
// V20 read-side discipline (one import, many surfaces).
//
// What lives here:
//   - `importGltfFromOpfs(path)` — extracted verbatim from
//     `AssetDropZone.onDrop:67-90`. Reads OPFS bytes, detaches a fresh
//     ArrayBuffer (SharedArrayBuffer concern), calls buildGltfImportOps
//     with the resolver-aware resolveBuffer, dispatches atomically,
//     reports failures to assetErrorStore (not console.error — the
//     silent-failure fix), and bumps the My-Imports refresh signal on
//     success.
//   - `ingestGltfFolder(files, folderName)` — disk → OPFS write step.
//     Sanitises the folder name, applies suffix-on-collision against
//     `storage.list('user-imports')` (Task 3 collision policy), locates
//     the shallowest .gltf/.glb as the entry file, writes every file
//     under `user-imports/<resolvedName>/<relativePath>` preserving
//     full nesting (decision 4), returns the entry OPFS path. Failures
//     surface via assetErrorStore.
//
// Invariants honored:
//   - V8: no `src/viewport/` imports. App-layer module.
//   - V22: assetRef purely derived from folderName + numeric suffix —
//     no Date.now / Math.random anywhere in this file.
//   - V18: no localStorage / no persisted index — OPFS is source of truth.
//   - K6: ONE dispatchAtomic per import (never dispatchBatch).
//
// Observed dispatcher behavior (Task 1, recorded for the side-stepped
// latent case): dispatchAtomic with a duplicate `addNode` id THROWS
// `OpError: addNode: id already exists: <nodeId>` from applyAddNode
// (`src/core/dag/ops.ts:107`); the throw propagates before set() runs
// in dispatchAtomic (`store.ts:156`), so state is NOT mutated. Suffix-
// on-collision (below) is collision-safe regardless: distinct
// folderNames → distinct assetRefs → distinct fnv1a ids → no collision
// reaches the dispatcher.
//
// REF: phase 7.9 PLAN Waves A, C, D; CONTEXT D-01/D-02/D-03;
// AssetDropZone.tsx:65-92 (extracted source); opfsGltfResolver.ts:127-129;
// gltfImportChain.ts:72-83 (fnv1a id derivation); issue #110.

import { useDagStore } from '../../core/dag/store';
import { buildGltfImportOps, type GltfImportChainResult } from '../../core/import/gltfImportChain';
import type { DagState } from '../../core/dag/state';
import { getStorage } from '../boot';
import { opfsSiblingPath, missingGltfSiblings } from './opfsGltfResolver';
import { formatAssetError, useAssetErrorStore } from '../stores/assetErrorStore';
import { useImportRefreshStore } from '../stores/importRefreshStore';
import {
  USER_IMPORTS_ROOT,
  resolveFreeImportName,
  sanitizeFolderName,
  type IngestFile,
} from './importCommon';

// Format-agnostic helpers (`IngestFile`, `USER_IMPORTS_ROOT`,
// `sanitizeFolderName`, `resolveFreeImportName`) were lifted to
// `importCommon.ts` (Phase 7.14 D-07). Re-exported here so existing importers
// of `./importGltf` (ingestReaders, AssetDropZone, MenuBar, boot, the e2e) keep
// their import paths unchanged.
export { USER_IMPORTS_ROOT };
export type { IngestFile };

/**
 * Locate the entry .gltf / .glb in an ingest set. Returns the file
 * whose relativePath has the FEWEST path segments — i.e. the root-level
 * or shallowest-nested container. Picking the shallowest (not strictly
 * depth-0) handles a nested-entry export like `gltf/scene.gltf` where
 * the folder root contains no glTF directly.
 *
 * Returns null when no .gltf / .glb is present.
 */
export function locateEntryFile(files: readonly IngestFile[]): IngestFile | null {
  let best: IngestFile | null = null;
  let bestDepth = Number.POSITIVE_INFINITY;
  for (const f of files) {
    const lower = f.relativePath.toLowerCase();
    if (!lower.endsWith('.gltf') && !lower.endsWith('.glb')) continue;
    const depth = f.relativePath.split('/').filter(Boolean).length;
    if (depth < bestDepth) {
      best = f;
      bestDepth = depth;
    }
  }
  return best;
}

/**
 * Non-dispatching core of the glTF import: read the OPFS bytes at `path`,
 * detach a plain ArrayBuffer, and build the deterministic import Op chain
 * (GltfAsset + per-child GltfChild + Transform + Group + — when the file
 * carries embedded animations — N TransformClip + 1 ClipSelect + connects)
 * against a CALLER-SUPPLIED DAG `state`. Returns the full
 * `GltfImportChainResult`; the caller decides whether to dispatch.
 *
 * Two callers, one chokepoint (B12):
 *   - `importGltfFromOpfs` (disk path) passes the live store state and then
 *     `dispatchAtomic`s the result.
 *   - `library.import` (agent tool, V7) passes the FORKED `ctx.dagState` and
 *     returns the ops for the Diff to apply — it NEVER dispatches.
 *
 * Sharing this with the agent tool closes the #81-class silent drop on the
 * agent surface: before, `library.import` called the static
 * `buildAssetDropOps` (no clip extraction), so an animated glTF imported as
 * a static mesh. Now both surfaces extract clips identically (H40 boundary-
 * pair: same node-type set on both paths).
 *
 * The `resolveBuffer` resolver mirrors the disk path verbatim
 * (`opfsSiblingPath` against the OPFS sibling dir) so multi-file `.gltf`
 * (#82) resolves its `.bin` / textures the same way regardless of surface.
 */
export async function buildGltfImportOpsFromOpfs(
  path: string,
  sceneNodeId: string,
  state: DagState,
): Promise<GltfImportChainResult> {
  const storage = await getStorage();
  const bytes = await storage.read(path);
  // Detach a non-shared ArrayBuffer view for the importer. Uint8Array.buffer
  // is typed `ArrayBufferLike`, including SharedArrayBuffer — the parser
  // wants a plain ArrayBuffer. (Verbatim from AssetDropZone.onDrop:74-76.)
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const buffer = copy.buffer;
  return buildGltfImportOps(
    {
      buffer,
      assetRef: path,
      sceneNodeId,
      resolveBuffer: (uri) => storage.read(opfsSiblingPath(path, uri)),
    },
    state,
  );
}

export async function importGltfFromOpfs(path: string): Promise<void> {
  try {
    const dag = useDagStore.getState();
    const sceneRef = dag.state.outputs.scene;
    if (!sceneRef) {
      useAssetErrorStore.getState().report(path, 'import failed: project has no scene output');
      return;
    }
    const result = await buildGltfImportOpsFromOpfs(
      path,
      sceneRef.node,
      useDagStore.getState().state,
    );
    dag.dispatchAtomic(result.ops, 'user', `import asset: ${path}`);
    // Bump AFTER dispatchAtomic returns (pre-mortem #3): a pre-dispatch
    // bump would cause the My-Imports list to re-enumerate before the
    // import succeeded, yielding stale/empty results on failure.
    useImportRefreshStore.getState().bump();
  } catch (err) {
    useAssetErrorStore.getState().report(path, `import failed: ${formatAssetError(err)}`);
  }
}

/**
 * Ingest a folder's worth of files into OPFS and trigger the import.
 *
 * Steps:
 *   (a) sanitise the folder name
 *   (b) resolve a free subdirectory via suffix-on-collision (Task 3)
 *   (c) locate the shallowest .gltf / .glb as the entry file (or fail)
 *   (d) write every file at `user-imports/<resolvedName>/<relativePath>`
 *       — full nesting preserved (decision 4)
 *   (e) return the entry's OPFS path (callers may then call
 *       importGltfFromOpfs(returnedPath) — Wave C/D wires this).
 *
 * On any failure (no glTF found, write/quota error, etc.) the function
 * reports to assetErrorStore BEFORE re-throwing, so callers don't need
 * a second catch-and-report wrapper.
 *
 * V22: assetRef is derived purely from folderName + numeric suffix.
 * V18: no localStorage index — the OPFS dir is enumerated live.
 */
export async function ingestGltfFolder(
  files: readonly IngestFile[],
  folderName: string,
): Promise<string> {
  const desired = sanitizeFolderName(folderName);
  try {
    const entry = locateEntryFile(files);
    if (!entry) {
      const msg = 'import failed: no glTF/glb in folder';
      useAssetErrorStore.getState().report(desired, msg);
      throw new Error(msg);
    }
    // A multi-file `.gltf` references sibling `.bin`/textures by relative URI.
    // The plain file picker (Import glTF…) captures only the `.gltf`, so detect a
    // missing sibling and fail EARLY with guidance — instead of writing a partial
    // asset and dying mid-load on a cryptic NotFoundError ("…could not be found",
    // a.k.a. "Entry not found" on WebKit). `.glb` is self-contained, so skipped.
    if (entry.relativePath.toLowerCase().endsWith('.gltf')) {
      const present = new Set(files.map((f) => f.relativePath));
      const missing = missingGltfSiblings(entry.bytes, entry.relativePath, present);
      if (missing.length > 0) {
        const name = entry.relativePath.split('/').pop() ?? entry.relativePath;
        const msg = `import failed: ${name} needs ${missing.join(', ')} — pick the .gltf together with those files, or use File ▸ Import Folder…`;
        useAssetErrorStore.getState().report(desired, msg);
        throw new Error(msg);
      }
    }
    const resolvedName = await resolveFreeImportName(desired);
    const storage = await getStorage();
    // Write each file under the chosen subdirectory, preserving its
    // full in-folder relativePath verbatim. OpfsStorage.write auto-
    // creates nested directories (OpfsStorage.ts:43-45), so no mkdir
    // step is needed.
    for (const f of files) {
      const opfsPath = `${USER_IMPORTS_ROOT}/${resolvedName}/${f.relativePath}`;
      await storage.write(opfsPath, f.bytes);
    }
    return `${USER_IMPORTS_ROOT}/${resolvedName}/${entry.relativePath}`;
  } catch (err) {
    // The "no glTF" path already reported above — guard against double-
    // reporting by checking whether the message survived. For other
    // errors (write/quota), surface them through the same banner.
    const message = formatAssetError(err);
    if (!message.startsWith('import failed:')) {
      useAssetErrorStore.getState().report(desired, `import failed: ${message}`);
    }
    throw err;
  }
}
