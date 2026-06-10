// Import picker — the programmatic file-picker entries shared by every
// "Import…" affordance (MenuBar File ▸ Import…, the Spline outliner footer's
// Import button). Extracted from MenuBar in the Spline redesign Wave B so the
// outliner footer reuses this exact pipeline instead of forking a second one
// (V34 — one create path; no parallel ingest chokepoint).
//
// TWO entry points, ONE ingest core (`ingestOneModel`):
//   - openImportPicker()    — directory picker (webkitdirectory). Needed for
//     multi-file glTF whose `.bin`/textures siblings live in a folder (#82),
//     and for a lone BVH/FBX dropped in a folder.
//   - openGltfFilePicker()  — plain FILE picker (no webkitdirectory). The
//     Blender-style "pick a .gltf/.glb model file" path: inserts the model into
//     the CURRENT scene (additive — the ops ADD nodes, they never replace), so
//     repeated imports stack models up. Selecting several self-contained `.glb`
//     at once inserts one model per file.
//
// Failures route to useAssetErrorStore (V14/silent-failure fix), NOT
// console.error — same discipline as the AssetDropZone drop path (B12).
//
// REF: docs/UI-SPEC.md §5.5; THESIS.md §15, §17; vyapti V34 (one pipeline);
// hetvabhasa B12 (shared ingest chokepoint).

import { inputFilesToFiles } from './ingestReaders';
import { importGltfFromOpfs, ingestGltfFolder, type IngestFile } from './importGltf';
import { ingestSingleFile } from './importCommon';
import { routeImportByExtension } from './importBvhFbx';
import { useAssetErrorStore, formatAssetError } from '../stores/assetErrorStore';

/** True iff the path is a glTF container (the folder-import trigger). */
function isGltfPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.gltf') || lower.endsWith('.glb');
}

/** True iff any picked file is a glTF container. */
function hasGltfEntry(files: readonly IngestFile[]): boolean {
  return files.some((f) => isGltfPath(f.relativePath));
}

/**
 * Derive the OPFS folder name for an ingested model from its first file's
 * `relativePath`: the picked-folder root segment (directory picker), else
 * basename-without-extension (a root-level / file-picker selection) so the OPFS
 * layout matches the drop single-file layout
 * (`user-imports/<basename>/<basename>.glb`).
 */
function deriveFolderName(firstPath: string): string {
  const slash = firstPath.indexOf('/');
  if (slash > 0) return firstPath.slice(0, slash);
  const dot = firstPath.lastIndexOf('.');
  return dot > 0 ? firstPath.slice(0, dot) : firstPath;
}

/**
 * Ingest ONE model's file set into the current scene — glTF (possibly
 * multi-file) → folder ingest; a lone .bvh/.fbx → single-file ingest +
 * extension routing (D-04). The SINGLE ingest chokepoint shared by both
 * pickers (V34).
 */
async function ingestOneModel(files: IngestFile[]): Promise<void> {
  if (files.length === 0) return;
  const folderName = deriveFolderName(files[0].relativePath);
  if (hasGltfEntry(files)) {
    const entryPath = await ingestGltfFolder(files, folderName);
    await importGltfFromOpfs(entryPath);
  } else if (files.length === 1) {
    const entryPath = await ingestSingleFile(files[0], folderName);
    await routeImportByExtension(entryPath);
  } else {
    // No glTF entry and not a lone file — let ingestGltfFolder surface the
    // "no glTF/glb" banner (its existing error path).
    await ingestGltfFolder(files, folderName);
  }
}

function makeHiddenInput(accept: string, directory: boolean): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'file';
  if (directory) {
    (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
  }
  input.multiple = true;
  input.accept = accept;
  input.style.display = 'none';
  document.body.appendChild(input);
  return input;
}

/**
 * Open the OS DIRECTORY picker and ingest the selection as one model.
 *
 * Directory pickers ship in Chromium/Firefox/Safari natively, so no
 * `showDirectoryPicker` fallback is needed. The directory picker is kept (do
 * NOT regress multi-file glTF #82, whose `.bin`/textures siblings live
 * alongside the `.gltf` in a folder); a lone `.bvh`/`.fbx` placed in a folder
 * routes through the single-file path.
 */
export function openImportPicker(): void {
  const input = makeHiddenInput('.gltf,.glb,.bvh,.fbx', true);
  input.onchange = () => {
    void (async () => {
      try {
        if (!input.files || input.files.length === 0) return;
        const files = await inputFilesToFiles(input.files);
        await ingestOneModel(files);
      } catch (err) {
        useAssetErrorStore.getState().report('menu-import', formatAssetError(err));
      } finally {
        input.remove();
      }
    })();
  };
  input.click();
}

/**
 * Open a plain FILE picker for glTF models and insert them into the current
 * scene — the Blender-style `File ▸ Import ▸ glTF`. Accepts `.gltf` / `.glb`,
 * multi-select. Inserts are additive (the import ops ADD nodes), so this can be
 * re-run to stack models. Selecting several self-contained `.glb` at once
 * inserts one model per file (sequential awaits — each import reads fresh DAG
 * state, so monotonic ids never collide).
 *
 * A `.gltf` references external `.bin`/texture siblings; a plain file picker
 * can't capture siblings nested in sub-folders, so for those use the directory
 * `openImportPicker` (or drag-drop the folder). A self-contained `.glb` or a
 * flat `.gltf` selected together with its siblings works here.
 */
export function openGltfFilePicker(): void {
  const input = makeHiddenInput('.gltf,.glb', false);
  input.onchange = () => {
    void (async () => {
      try {
        if (!input.files || input.files.length === 0) return;
        const files = await inputFilesToFiles(input.files);
        const glbs = files.filter((f) => f.relativePath.toLowerCase().endsWith('.glb'));
        // Several self-contained .glb with no .gltf in the set → one model each.
        if (glbs.length > 1 && !files.some((f) => f.relativePath.toLowerCase().endsWith('.gltf'))) {
          for (const glb of glbs) {
            await ingestOneModel([glb]);
          }
        } else {
          await ingestOneModel(files);
        }
      } catch (err) {
        useAssetErrorStore.getState().report('menu-import-gltf', formatAssetError(err));
      } finally {
        input.remove();
      }
    })();
  };
  input.click();
}
