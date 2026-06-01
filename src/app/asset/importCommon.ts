// Format-agnostic imported-asset core — Phase 7.14 Wave A (issues #111, #112).
//
// The B12 import chokepoint now spans THREE formats (glTF, BVH, FBX) plus the
// My-Imports management surface (rename / delete / ref-scan). The concerns that
// are identical across every format — OPFS naming, collision-free folder
// resolution, the user-imports root — live here; the per-format build-ops step
// stays format-specific (`importGltf.ts`, `importBvhFbx.ts`). This applies the
// domain-aligned-abstraction test: the invariant's span grew, so the module
// boundary tracks it (D-07).
//
// Lifted verbatim from `importGltf.ts` (Phase 7.9 Wave A) — `IngestFile`,
// `USER_IMPORTS_ROOT`, `sanitizeFolderName`, `resolveFreeImportName`. Public
// names are kept stable: `importGltf.ts` re-exports `IngestFile` +
// `USER_IMPORTS_ROOT` so every existing importer (`ingestReaders`,
// `AssetDropZone`, `MenuBar`, `boot`, the e2e) is unaffected.
//
// Invariants honored:
//   - V8: no `src/viewport/` imports. App-layer module.
//   - V22: every derived name is a pure function of the folder name + a numeric
//     suffix — no Date.now / Math.random anywhere in this file.
//   - V18: no localStorage / no persisted index — OPFS is source of truth.
//
// REF: phase 7.14 PLAN Wave A (A1/A2), CONTEXT D-07; importGltf.ts (the glTF
//      chokepoint this generalizes); StorageCapability.ts:17-42 (no move/copy
//      primitive — the recursive helpers below fill that gap).

import { useDagStore } from '../../core/dag/store';
import type { Op } from '../../core/dag/types';
import { importGroupNodeIds } from '../../core/import/gltfImportChain';
import type { StorageCapability } from '../../core/storage/StorageCapability';
import { getStorage } from '../boot';
import { formatAssetError, useAssetErrorStore } from '../stores/assetErrorStore';
import { useImportRefreshStore } from '../stores/importRefreshStore';
import { importPathPrefix, nodesReferencingImport } from './importRefs';

/**
 * One ingested file. All readers (drop entries, webkitdirectory input,
 * single-file input) normalise into this shape.
 *
 * `relativePath` is the in-folder path of the file with ONLY the picked-folder
 * root segment stripped — all deeper nesting preserved verbatim so a
 * nested-entry .gltf (e.g. `gltf/scene.gltf` referencing `../textures/foo.png`)
 * resolves its siblings correctly against its own dir post-write.
 */
export interface IngestFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

/** Root OPFS directory for user-imported assets. */
export const USER_IMPORTS_ROOT = 'user-imports';

/**
 * Sanitise a folder name into an OPFS-safe directory name. Keeps alphanumeric +
 * `-_.`, replaces every other character with `_`, collapses leading/trailing
 * whitespace, and falls back to `import` when the result is empty.
 */
export function sanitizeFolderName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return 'import';
  const safe = trimmed.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe === '' ? 'import' : safe;
}

/**
 * Resolve a free subdirectory name under `user-imports/` for `desired`.
 * Suffix-on-collision policy: if `<desired>` already exists under
 * `user-imports/`, try `<desired>-2`, `<desired>-3`, … until a free name is
 * found. Returns the chosen name (NOT the full path).
 *
 * NB: `storage.list` THROWS on a missing dir (the first-run case); wrapped in
 * try/catch → [] (mirror the OpfsStorage `exists` pattern).
 *
 * V22 — purely derived (folderName + numeric suffix). No RNG / Date.now.
 */
export async function resolveFreeImportName(desired: string): Promise<string> {
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
 * Ingest a SINGLE file into OPFS under `user-imports/<resolvedName>/<file>`.
 *
 * The simpler sibling of `ingestGltfFolder` (importGltf.ts): BVH and FBX have
 * no sibling files (a `.bvh` is self-contained text; a `.fbx` is a single
 * binary), so there is no folder to locate an entry within — one file in, one
 * OPFS path out. Returns the written file's OPFS path; callers route it through
 * the per-format importer.
 *
 * On a write/quota failure the error is reported to assetErrorStore BEFORE
 * re-throwing (so callers need no second catch-and-report), mirroring
 * `ingestGltfFolder`.
 *
 * V22: the path is derived purely from folderName + numeric suffix.
 * V18: no localStorage index — OPFS is enumerated live.
 */
export async function ingestSingleFile(file: IngestFile, folderName: string): Promise<string> {
  const desired = sanitizeFolderName(folderName);
  try {
    const resolvedName = await resolveFreeImportName(desired);
    const storage = await getStorage();
    // Use only the basename so a `relativePath` like `anim/walk.bvh` (from a
    // folder-shaped drop) still lands as a flat single file under the import
    // dir — BVH/FBX never carry siblings, so nesting would be spurious.
    const base = file.relativePath.split('/').filter(Boolean).pop() ?? file.relativePath;
    const opfsPath = `${USER_IMPORTS_ROOT}/${resolvedName}/${base}`;
    await storage.write(opfsPath, file.bytes);
    return opfsPath;
  } catch (err) {
    const message = formatAssetError(err);
    if (!message.startsWith('import failed:')) {
      useAssetErrorStore.getState().report(desired, `import failed: ${message}`);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// My-Imports management — rename / delete (Phase 7.14 Wave B, issue #112)
// ---------------------------------------------------------------------------

/**
 * Recursively collect every FILE path under `dir`, returned RELATIVE to `dir`
 * (e.g. `scene.gltf`, `textures/foo.png`). `StorageCapability` has no recursive
 * list (StorageCapability.ts:17-42), so we walk one level at a time.
 *
 * Backend asymmetry handled: `storage.list(filePath)` returns `[]` on
 * MemoryStorage but THROWS on OpfsStorage — both are caught and treated as
 * "leaf" (a file), so the walk is backend-agnostic. (Import dirs never contain
 * empty subdirs, so the leaf-vs-empty-dir ambiguity does not arise.)
 */
export async function listFilesDeep(storage: StorageCapability, dir: string): Promise<string[]> {
  async function walk(prefix: string): Promise<string[]> {
    let children: string[];
    try {
      children = await storage.list(`${dir}/${prefix}`.replace(/\/$/, ''));
    } catch {
      return [];
    }
    if (children.length === 0) return [];
    const out: string[] = [];
    for (const child of children) {
      const rel = prefix ? `${prefix}/${child}` : child;
      let grandchildren: string[];
      try {
        grandchildren = await storage.list(`${dir}/${rel}`);
      } catch {
        grandchildren = [];
      }
      if (grandchildren.length === 0) {
        out.push(rel); // leaf → a file
      } else {
        out.push(...(await walk(rel)));
      }
    }
    return out;
  }
  return walk('');
}

/**
 * Delete an entire import tree from OPFS: every file, then every now-empty
 * subdirectory (deepest-first), then the root dir itself. `StorageCapability.
 * delete` maps to `removeEntry`, which removes an EMPTY directory too — so
 * after the files are gone, removing dirs bottom-up leaves no lingering empty
 * folder (OpfsStorage.ts:83-90). On MemoryStorage the dir-deletes are harmless
 * no-ops (it stores files only).
 *
 * `rels` is the file list (relative to `root`) — pass the same list captured
 * before the move so a rename/delete removes exactly what it copied/listed.
 */
export async function deleteOpfsTree(
  storage: StorageCapability,
  root: string,
  rels: readonly string[],
): Promise<void> {
  for (const rel of rels) {
    await storage.delete(`${root}/${rel}`);
  }
  // Unique ancestor dirs of every file, deepest-first.
  const dirs = new Set<string>();
  for (const rel of rels) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }
  const ordered = [...dirs].sort((a, b) => b.split('/').length - a.split('/').length);
  for (const dir of ordered) {
    await storage.delete(`${root}/${dir}`);
  }
  await storage.delete(root);
}

/** Result of a delete attempt. `deleted:false` + `referencedBy` means the asset
 *  was blocked because live nodes reference it (D-06) — the caller surfaces the
 *  break-refs banner. */
export interface DeleteImportResult {
  readonly deleted: boolean;
  /** GltfAsset node ids still referencing the asset when blocked. */
  readonly referencedBy?: readonly string[];
}

/**
 * Rename a My-Imports asset: move its OPFS folder AND rewrite every glTF
 * `assetRef` that pointed inside it, atomically. Returns the resolved new name
 * (suffix-adjusted on collision), or null on failure (reported to the banner).
 *
 * FAIL-SAFE ORDER (the central invariant — risk #1):
 *   copy-all-new → verify-all-new → rewrite-assetRefs (1 dispatchAtomic, K6) →
 *   delete-old → bump.
 * NEVER delete-old before new is fully written+verified: a crash mid-rename
 * then leaves a recoverable DUPLICATE, never a live `assetRef` pointing at a
 * deleted path. The assetRef rewrite is a single dispatchAtomic so it is
 * all-or-nothing and Cmd+Z-reversible.
 *
 * Asymmetry (D-03): glTF persists `assetRef` → rewrite required. BVH/FBX leave
 * no persistent ref → `nodesReferencingImport` returns [] → folder move only.
 */
export async function renameImportedAsset(
  oldName: string,
  newName: string,
): Promise<string | null> {
  const oldRoot = `${USER_IMPORTS_ROOT}/${oldName}`;
  try {
    const desired = sanitizeFolderName(newName);
    if (desired === oldName) return oldName; // no-op rename
    const resolved = await resolveFreeImportName(desired);
    const newRoot = `${USER_IMPORTS_ROOT}/${resolved}`;
    const storage = await getStorage();

    // 1. Recursive list of the source tree.
    const rels = await listFilesDeep(storage, oldRoot);
    if (rels.length === 0) {
      useAssetErrorStore.getState().report(oldName, `rename failed: "${oldName}" not found`);
      return null;
    }

    // 2. Copy every file to the new root (read + write — no move primitive).
    for (const rel of rels) {
      const bytes = await storage.read(`${oldRoot}/${rel}`);
      await storage.write(`${newRoot}/${rel}`, bytes);
    }

    // 3. Verify ALL new files exist BEFORE touching the old tree.
    for (const rel of rels) {
      if (!(await storage.exists(`${newRoot}/${rel}`))) {
        throw new Error(`rename failed: verify error for ${rel}`);
      }
    }

    // 4. Rewrite assetRefs (glTF only) in ONE dispatchAtomic (K6, undoable).
    const dag = useDagStore.getState();
    const refIds = nodesReferencingImport(oldName, dag.state);
    if (refIds.length > 0) {
      const oldPrefix = importPathPrefix(oldName);
      const newPrefix = importPathPrefix(resolved);
      const ops: Op[] = [];
      for (const id of refIds) {
        const ref = (dag.state.nodes[id].params as { assetRef: string }).assetRef;
        ops.push({
          type: 'setParam',
          nodeId: id,
          paramPath: 'assetRef',
          value: ref.replace(oldPrefix, newPrefix),
        });
      }
      dag.dispatchAtomic(ops, 'user', `rename import: ${oldName} → ${resolved}`);
    }

    // 5. Delete the old tree (only now — new is verified + refs repointed).
    await deleteOpfsTree(storage, oldRoot, rels);

    // 6. Refresh the My-Imports list.
    useImportRefreshStore.getState().bump();
    return resolved;
  } catch (err) {
    useAssetErrorStore.getState().report(oldName, `rename failed: ${formatAssetError(err)}`);
    return null;
  }
}

/**
 * Delete a My-Imports asset.
 *
 * If any node references it (glTF assetRef) and `breakRefs` is not set, the
 * delete is BLOCKED (D-06): returns `{ deleted:false, referencedBy }` and the
 * caller shows a banner offering "delete anyway". With `breakRefs`, the entire
 * import footprint of each referencing asset — the GltfAsset PLUS its wrapper
 * Transform/Group, GltfChild satellites, and TransformClip/ClipSelect nodes
 * (#127, via importGroupNodeIds) — is removed first (disconnect every incident
 * edge then removeNode — the op layer rejects removing a still-consumed node)
 * in one dispatchAtomic, then the OPFS tree is deleted.
 *
 * Unreferenced (always true for BVH/FBX — no persistent ref) → delete OPFS now.
 */
export async function deleteImportedAsset(
  name: string,
  opts: { breakRefs?: boolean } = {},
): Promise<DeleteImportResult> {
  try {
    const dag = useDagStore.getState();
    const refIds = nodesReferencingImport(name, dag.state);

    if (refIds.length > 0 && !opts.breakRefs) {
      return { deleted: false, referencedBy: refIds };
    }

    if (refIds.length > 0) {
      // Break refs: remove the WHOLE import footprint, not just the referencing
      // GltfAsset (#127). Removing only the GltfAsset left orphan ghosts — the
      // wrapper Transform/Group (an empty group in the scene tree), the inputless
      // GltfChild satellites, and the TransformClip/ClipSelect clip nodes. Each
      // referencing node's assetRef expands to its content-addressed import group
      // (importGroupNodeIds) — never reaching user-wired nodes (their ids don't
      // match the import scheme) nor the shared Scene anchor (not content-
      // addressed off assetRef).
      const targets = new Set<string>();
      for (const id of refIds) {
        const assetRef = (dag.state.nodes[id].params as { assetRef?: string }).assetRef;
        if (!assetRef) {
          targets.add(id); // defensive: a referencing node with no assetRef
          continue;
        }
        for (const groupId of importGroupNodeIds(assetRef, dag.state)) targets.add(groupId);
      }
      // Disconnect EVERY edge incident to a target (internal AND boundary): after
      // this no target is consumed by anything, so removeNode succeeds in any
      // order (ops.ts applyRemoveNode rejects a still-consumed node). Boundary
      // edges — Group.out → Scene.children, or a user node consuming a GltfChild —
      // are disconnected but their out-of-group endpoint survives.
      const ops: Op[] = [];
      for (const consumer of Object.values(dag.state.nodes)) {
        for (const [socket, binding] of Object.entries(consumer.inputs)) {
          const refs = Array.isArray(binding) ? binding : [binding];
          for (const ref of refs) {
            if (!targets.has(ref.node) && !targets.has(consumer.id)) continue;
            ops.push({
              type: 'disconnect',
              from: { node: ref.node, socket: ref.socket },
              to: { node: consumer.id, socket },
            });
          }
        }
      }
      for (const id of targets) ops.push({ type: 'removeNode', nodeId: id });
      dag.dispatchAtomic(ops, 'user', `delete import (break refs): ${name}`);
    }

    // Delete the OPFS tree (files + now-empty dirs + root).
    const storage = await getStorage();
    const root = `${USER_IMPORTS_ROOT}/${name}`;
    const rels = await listFilesDeep(storage, root);
    await deleteOpfsTree(storage, root, rels);

    useImportRefreshStore.getState().bump();
    return { deleted: true };
  } catch (err) {
    useAssetErrorStore.getState().report(name, `delete failed: ${formatAssetError(err)}`);
    return { deleted: false };
  }
}
