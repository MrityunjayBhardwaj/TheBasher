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
import { buildAssetDropOps } from './asset/dropChain';
import { importGltfFromOpfs, ingestGltfFolder, type IngestFile } from './asset/importGltf';
import { dropItemsToFiles, plainFilesToFiles } from './asset/ingestReaders';
import { formatAssetError, useAssetErrorStore } from './stores/assetErrorStore';

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

  const entryPath = await ingestGltfFolder(files, folderName);
  await importGltfFromOpfs(entryPath);
}

export function AssetDropZone({ children }: Props) {
  const dispatchAtomic = useDagStore((s) => s.dispatchAtomic);
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
      const state = useDagStore.getState().state;
      const sceneRef = state.outputs.scene;
      if (!sceneRef) {
        console.warn('AssetDropZone: project has no `scene` output; drop ignored');
        return;
      }

      // P7.5 + #90 + Phase 7.9 — single-path glTF routing (CONTEXT D-02).
      // Both `.glb` (binary container) and `.gltf` (JSON-only container)
      // now route through the shared Wave A core `importGltfFromOpfs`,
      // which is the sole importer call site in `src/app/` (B12
      // chokepoint). Non-glTF library drops fall through to the catalog
      // `buildAssetDropOps` path unchanged.
      const lower = path.toLowerCase();
      if (lower.endsWith('.glb') || lower.endsWith('.gltf')) {
        void importGltfFromOpfs(path);
        return;
      }

      const ops = buildAssetDropOps({ assetRef: path, sceneNodeId: sceneRef.node });
      dispatchAtomic(ops, 'user', `import asset: ${path}`);
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
        // Path 1: items API (preferred — exposes directory entries via
        // webkitGetAsEntry, which is the only way to recover folder
        // shape for drag-drop).
        if (items.length > 0) {
          const ingestFiles = await dropItemsToFiles(items as unknown as DataTransferItemList);
          await routeIngest(ingestFiles, items);
          return;
        }
        // Path 2: plain FileList (no items API). No directory shape is
        // recoverable here — single or multi flat-file drops only.
        if (fileList && fileList.length > 0) {
          const ingestFiles = await plainFilesToFiles(fileList);
          await routeIngest(ingestFiles, []);
          return;
        }
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
