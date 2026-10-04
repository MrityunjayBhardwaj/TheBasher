// Drop zone wrapping the viewport-slot. Catches HTML5 drops carrying
// `application/x-basher-asset` (Library payload) AND OS-level file/folder
// drops, translates them into a dispatchAtomic Op chain, and shows a
// faint visual hint while a drag is over. The viewport itself remains
// read-only (V8) — the drop handler lives in `src/app/`, not
// `src/viewport/`.
//
// REF: THESIS.md §11 (V8), §14, P1 Wave B, Phase 7.9 Wave C (#110).

import { useState, type DragEvent, type ReactNode } from 'react';
import { useDagStore } from '../core/dag/store';
import { DRAG_MIME } from './asset/catalog';
import { type IngestFile } from './asset/importGltf';
import { ingestAndImportGltf } from './asset/gltfEntryChoice';
import { ingestSingleFile } from './asset/importCommon';
import { routeImportByExtension } from './asset/importBvhFbx';
import { isFamilyPath } from './asset/importFormats';
import { dropToFiles } from './asset/ingestReaders';
import { formatAssetError, useAssetErrorStore } from './stores/assetErrorStore';
import { useNotificationStore } from './stores/notificationStore';
import type { DagState } from '../core/dag/state';

/** The warn toast shown when a library asset is dropped but the project has no
 *  scene to add it into. Exported so the test asserts the exact surfaced text. */
export const NO_SCENE_DROP_MESSAGE = 'Can’t add asset — this project has no scene to add it to.';

/** What a dropped catalog (library) asset resolves to. */
export type CatalogDropPlan =
  // → routeImportByExtension, which imports it by format, or refuses a file in none by name
  // (#1307 — this used to mint a GltfAsset reading any non-importable file)
  { kind: 'import'; path: string } | { kind: 'no-scene' }; // nothing to drop into — must be surfaced, never swallowed

/**
 * Decide what a dropped catalog asset should do — the pure core of `onDrop`'s
 * library-asset branch, lifted out so the "no scene to drop into" case is a
 * TESTABLE outcome rather than a silent `console.warn`. A drop that lands
 * nowhere must tell the user why (V38 — never silently swallow; the [[H70]]
 * void'd-fallible-action trap), and that can only be checked if the decision is
 * separable from the DOM event handler.
 */
export function planCatalogAssetDrop(state: DagState, path: string): CatalogDropPlan {
  const sceneRef = state.outputs.scene;
  if (!sceneRef) return { kind: 'no-scene' };
  return { kind: 'import', path };
}

interface Props {
  children: ReactNode;
}

/**
 * Strip the trailing file extension from a relativePath's basename. Used
 * to derive the single-file OS-drop folder name so the layout matches
 * the Wave D picker single-file path: `user-imports/<basename>/<basename>.glb`
 * (checker C5).
 */
function stripExt(p: string): string {
  const base = p.split('/').pop() ?? p;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Route a normalized IngestFile set through the Wave A ingest core.
 *
 * Determines the OPFS folder name:
 *   - If any dropped item was a directory entry → use the directory's
 *     name (the top entry).
 *   - Else if exactly one file → basename-without-ext (matches the Wave D
 *     picker single-file layout, checker C5).
 *   - Else (multi-file no-dir drop) → fallback `imported`.
 *
 * Failures inside `ingestGltfFolder` are already reported to assetError-
 * Store before re-throwing; the caller's outer catch is a secondary net.
 */
async function routeIngest(files: IngestFile[], items: DataTransferItem[]): Promise<void> {
  if (files.length === 0) {
    useAssetErrorStore.getState().report('os-drop', 'import failed: no files');
    return;
  }

  let folderName: string;
  if (items.length > 0) {
    let dirName: string | null = null;
    for (const item of items) {
      const entry = item.webkitGetAsEntry?.();
      if (entry && entry.isDirectory) {
        dirName = entry.name;
        break;
      }
    }
    if (dirName) {
      folderName = dirName;
    } else if (files.length === 1) {
      // Lone file dropped via items API — use basename-without-ext so the
      // single-file layout matches the Wave D picker (checker C5).
      folderName = stripExt(files[0].relativePath);
    } else {
      folderName = 'imported';
    }
  } else if (files.length === 1) {
    folderName = stripExt(files[0].relativePath);
  } else {
    folderName = 'imported';
  }

  // BVH/FBX are self-contained motion files — a lone .bvh/.fbx drop ingests
  // as a single file (no sibling resolution) and routes by extension. A
  // glTF (or glTF + sibling .bin/textures) keeps the folder-ingest path.
  if (files.length === 1 && isFamilyPath(files[0].relativePath, 'motion')) {
    const entryPath = await ingestSingleFile(files[0], folderName);
    await routeImportByExtension(entryPath);
    return;
  }

  // A multi-glTF folder prompts the user to pick which model; one entry imports
  // straight through (#214). Cancelling the chooser returns null → no-op.
  await ingestAndImportGltf(files, folderName);
}

export function AssetDropZone({ children }: Props) {
  const [over, setOver] = useState(false);

  function carriesAsset(e: DragEvent): boolean {
    return Array.from(e.dataTransfer.types).includes(DRAG_MIME);
  }

  function isOsFileDrop(e: DragEvent): boolean {
    return Array.from(e.dataTransfer.types).includes('Files');
  }

  function onDragOver(e: DragEvent) {
    if (!carriesAsset(e) && !isOsFileDrop(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!over) setOver(true);
  }

  function onDragLeave() {
    setOver(false);
  }

  function onDrop(e: DragEvent) {
    if (carriesAsset(e)) {
      e.preventDefault();
      setOver(false);
      const path = e.dataTransfer.getData(DRAG_MIME);
      if (!path) return;
      const plan = planCatalogAssetDrop(useDagStore.getState().state, path);
      if (plan.kind === 'no-scene') {
        // V38 — a drop that lands nowhere must be surfaced, never swallowed. A
        // TRANSIENT toast, NOT assetErrorStore (whose banner mounts in a slot the
        // compositor can cover, and whose lifecycle would entangle with a
        // fire-and-forget message). notify() dedups on (severity, message).
        useNotificationStore
          .getState()
          .notify({ severity: 'warn', message: NO_SCENE_DROP_MESSAGE });
        return;
      }

      // P7.5 + #90 + Phase 7.9/7.14 — single-path importable-asset routing.
      // glTF (.glb/.gltf), BVH (.bvh) and FBX (.fbx) all route through the
      // shared extension dispatcher `routeImportByExtension` (B12 chokepoint:
      // the sole importer call site in `src/app/`), which also refuses a file in
      // no import format by name (#1307).
      void routeImportByExtension(plan.path);
      return;
    }

    if (!isOsFileDrop(e)) return;

    e.preventDefault();
    setOver(false);

    // SEQUENCE-CRITICAL (Phase 7.9 PLAN Task 6 pre-mortem): snapshot the
    // DataTransferItemList / FileList SYNCHRONOUSLY here — they are
    // detached after this event handler returns. The first await inside
    // the async IIFE below would observe an empty list and the import
    // would silently no-op.
    const items: DataTransferItem[] = e.dataTransfer.items ? Array.from(e.dataTransfer.items) : [];
    const fileList: FileList | null = e.dataTransfer.files ?? null;

    void (async () => {
      try {
        // The items door first (only it recovers a folder's shape), the plain
        // FileList when the items give no entry (#1454).
        const read = await dropToFiles(items as unknown as DataTransferItemList, fileList);
        await routeIngest(read.files, read.viaItems ? items : []);
      } catch (err) {
        // `ingestGltfFolder` already reports + throws on "no glTF in
        // folder", so the banner is showing by the time this catch
        // fires for that case. This is the secondary safety net for
        // write/quota/unexpected errors. Failures route to the asset
        // error store (banner) — never to a silent console-only log.
        useAssetErrorStore.getState().report('os-drop', formatAssetError(err));
      }
    })();
  }

  return (
    <div
      data-testid="asset-drop-zone"
      data-drop-active={over || undefined}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="relative h-full w-full"
    >
      {children}
      {over && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 border-2 border-dashed border-accent bg-accent/5"
        />
      )}
    </div>
  );
}
