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
import { buildGltfImportOps } from '../../core/import/gltfImportChain';
import { getStorage } from '../boot';
import { opfsSiblingPath } from './opfsGltfResolver';
import { formatAssetError, useAssetErrorStore } from '../stores/assetErrorStore';
import { useImportRefreshStore } from '../stores/importRefreshStore';

/**
 * One ingested file. All three readers (drop entries, webkitdirectory
 * input, single-file input — Wave B) normalise into this shape.
 *
 * `relativePath` is the in-folder path of the file with ONLY the picked-
 * folder root segment stripped — all deeper nesting preserved verbatim
 * so a nested-entry .gltf (e.g. `gltf/scene.gltf` referencing
 * `../textures/foo.png`) resolves its siblings correctly against its
 * own dir post-write.
 */
export interface IngestFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

/** Root OPFS directory for user-imported assets. */
export const USER_IMPORTS_ROOT = 'user-imports';

/**
 * Sanitise a folder name into an OPFS-safe directory name. Keeps
 * alphanumeric + `-_.`, replaces every other character with `_`,
 * collapses leading/trailing whitespace, and falls back to `import`
 * when the result is empty.
 */
function sanitizeFolderName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return 'import';
  const safe = trimmed.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe === '' ? 'import' : safe;
}

/**
 * Resolve a free subdirectory name under `user-imports/` for `desired`.
 * Suffix-on-collision policy (Task 3): if `<desired>` already exists
 * under `user-imports/`, try `<desired>-2`, `<desired>-3`, … until a
 * free name is found. Returns the chosen name (NOT the full path).
 *
 * NB: `storage.list` THROWS on a missing dir (the first-run case);
 * wrapped in try/catch → [] (mirror the OpfsStorage `exists` pattern).
 *
 * V22 — purely derived (folderName + numeric suffix). No RNG / Date.now.
 */
async function resolveFreeImportName(desired: string): Promise<string> {
  let existing: string[];
  const storage = await getStorage();
  try {
    existing = await storage.list(USER_IMPORTS_ROOT);
  } catch {
    existing = [];
  }
  const taken = new Set(existing);
  if (!taken.has(desired)) return desired;
  let i = 2;
  while (taken.has(`${desired}-${i}`)) i += 1;
  return `${desired}-${i}`;
}

/**
 * Locate the entry .gltf / .glb in an ingest set. Returns the file
 * whose relativePath has the FEWEST path segments — i.e. the root-level
 * or shallowest-nested container. Picking the shallowest (not strictly
 * depth-0) handles a nested-entry export like `gltf/scene.gltf` where
 * the folder root contains no glTF directly.
 *
 * Returns null when no .gltf / .glb is present.
 */
function locateEntryFile(files: readonly IngestFile[]): IngestFile | null {
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
 * Import a glTF asset whose bytes already live in OPFS at `path`.
 *
 * Extracted verbatim from `AssetDropZone.onDrop:67-90`. Both the OS-file
 * drop branch (Wave C), the picker branch (Wave D), and the existing
 * library-drag funnel through this single chokepoint.
 *
 * On success: dispatchAtomic with the import Ops (K6, one undo), then
 * bumps the My-Imports refresh signal — pre-mortem #3 mitigation: the
 * bump happens ONLY after dispatchAtomic returns, never before.
 *
 * On failure: reports a human-readable message to assetErrorStore so the
 * AssetErrorBanner surfaces "asset failed: <reason>" — the silent
 * `console.error` catch in the original onDrop path was the user-side
 * silent failure this replaces.
 */
export async function importGltfFromOpfs(path: string): Promise<void> {
  try {
    const dag = useDagStore.getState();
    const sceneRef = dag.state.outputs.scene;
    if (!sceneRef) {
      useAssetErrorStore.getState().report(path, 'import failed: project has no scene output');
      return;
    }
    const storage = await getStorage();
    const bytes = await storage.read(path);
    // Detach a non-shared ArrayBuffer view for the importer. Uint8Array.buffer
    // is typed `ArrayBufferLike`, including SharedArrayBuffer — the parser
    // wants a plain ArrayBuffer. (Verbatim from AssetDropZone.onDrop:74-76.)
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const buffer = copy.buffer;
    const result = await buildGltfImportOps(
      {
        buffer,
        assetRef: path,
        sceneNodeId: sceneRef.node,
        resolveBuffer: (uri) => storage.read(opfsSiblingPath(path, uri)),
      },
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
