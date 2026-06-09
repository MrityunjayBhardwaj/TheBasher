// Import picker — the ONE programmatic file-picker entry shared by every
// "Import…" affordance (MenuBar File ▸ Import…, the Spline outliner footer's
// Import button). Extracted from MenuBar in the Spline redesign Wave B so the
// outliner footer reuses this exact pipeline instead of forking a second one
// (V34 — one create path; no parallel ingest chokepoint).
//
// Accepts all four importable formats through ONE entry (D-04): glTF (possibly
// multi-file, folder ingest) + lone BVH/FBX (single-file ingest + extension
// routing). Failures route to useAssetErrorStore (V14/silent-failure fix), NOT
// console.error — same discipline as the AssetDropZone drop path (B12).
//
// REF: docs/UI-SPEC.md §5.5; THESIS.md §15, §17; vyapti V34 (one pipeline);
// hetvabhasa B12 (shared ingest chokepoint).

import { inputFilesToFiles } from './ingestReaders';
import { importGltfFromOpfs, ingestGltfFolder, type IngestFile } from './importGltf';
import { ingestSingleFile } from './importCommon';
import { routeImportByExtension } from './importBvhFbx';
import { useAssetErrorStore, formatAssetError } from '../stores/assetErrorStore';

/** True iff any picked file is a glTF container (the folder-import trigger). */
function hasGltfEntry(files: readonly IngestFile[]): boolean {
  return files.some((f) => {
    const lower = f.relativePath.toLowerCase();
    return lower.endsWith('.gltf') || lower.endsWith('.glb');
  });
}

/**
 * Open the OS file picker (directory-capable) and ingest the selection.
 *
 * Programmatic hidden `<input type="file" webkitdirectory multiple>`:
 * directory pickers ship in Chromium/Firefox/Safari natively, so no
 * `showDirectoryPicker` fallback is needed. The directory picker is kept (do
 * NOT regress multi-file glTF #82, whose `.bin`/textures siblings live
 * alongside the `.gltf` in a folder); a lone `.bvh`/`.fbx` placed in a folder
 * routes through the single-file path.
 *
 * folderName derivation: the picked-folder root segment of the first file's
 * `webkitRelativePath`. The `slash < 0` fallback (a `webkitdirectory` picker
 * yielding a single root-level file) uses basename-without-extension so the
 * OPFS layout matches the drop single-file layout
 * (`user-imports/<basename>/<basename>.glb`).
 */
export function openImportPicker(): void {
  const input = document.createElement('input');
  input.type = 'file';
  (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
  input.multiple = true;
  input.accept = '.gltf,.glb,.bvh,.fbx';
  input.style.display = 'none';
  document.body.appendChild(input);

  input.onchange = () => {
    void (async () => {
      try {
        if (!input.files || input.files.length === 0) return;
        const ingestFiles = await inputFilesToFiles(input.files);
        if (ingestFiles.length === 0) return;
        const first = ingestFiles[0].relativePath;
        const slash = first.indexOf('/');
        let folderName: string;
        if (slash > 0) {
          folderName = first.slice(0, slash);
        } else {
          const dot = first.lastIndexOf('.');
          folderName = dot > 0 ? first.slice(0, dot) : first;
        }
        // glTF (possibly multi-file) → folder ingest. A lone .bvh/.fbx (no
        // glTF in the set) → single-file ingest + extension routing (D-04).
        if (hasGltfEntry(ingestFiles)) {
          const entryPath = await ingestGltfFolder(ingestFiles, folderName);
          await importGltfFromOpfs(entryPath);
        } else if (ingestFiles.length === 1) {
          const entryPath = await ingestSingleFile(ingestFiles[0], folderName);
          await routeImportByExtension(entryPath);
        } else {
          // No glTF entry and not a lone file — let ingestGltfFolder surface
          // the "no glTF/glb" banner (its existing error path).
          await ingestGltfFolder(ingestFiles, folderName);
        }
      } catch (err) {
        useAssetErrorStore.getState().report('menu-import', formatAssetError(err));
      } finally {
        input.remove();
      }
    })();
  };

  input.click();
}
