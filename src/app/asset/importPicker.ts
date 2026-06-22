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
import { ingestGltfFolder, locateEntryFile, type IngestFile } from './importGltf';
import { ingestAndImportGltf } from './gltfEntryChoice';
import { missingGltfSiblings, formatMissingSiblingsError } from './opfsGltfResolver';
import { ingestSingleFile } from './importCommon';
import { routeImportByExtension } from './importBvhFbx';
import { useAssetErrorStore, formatAssetError } from '../stores/assetErrorStore';

/** The reason a lone FILE pick can't be fulfilled — its missing siblings. */
export interface GltfFolderNeed {
  /** Basename of the entry `.gltf` (e.g. `scene.gltf`). */
  readonly entryName: string;
  /** Decoded sibling URIs missing from the picked set (`.bin`, textures). */
  readonly missing: string[];
}

/**
 * Decide whether a picked file set is a multi-file `.gltf` that a lone FILE
 * pick cannot fulfill: its entry is a `.gltf` referencing external siblings
 * (`.bin`/textures) that are NOT all present in the set. Returns the entry
 * name + the missing sibling URIs, or null when the set is self-fulfilling —
 * a `.glb`, a flat `.gltf` selected together with its siblings, or no glTF.
 *
 * Pure — this is the auto-escalation trigger, unit-tested independently of the
 * DOM picker wiring. Reuses `locateEntryFile` + `missingGltfSiblings` (the same
 * shallowest-entry + sibling-resolution logic the importer uses), so the
 * decision can never diverge from what `ingestGltfFolder` would later check.
 */
export function gltfImportNeedsFolder(files: readonly IngestFile[]): GltfFolderNeed | null {
  const entry = locateEntryFile(files);
  if (!entry || !entry.relativePath.toLowerCase().endsWith('.gltf')) return null;
  const present = new Set(files.map((f) => f.relativePath));
  const missing = missingGltfSiblings(entry.bytes, entry.relativePath, present);
  if (missing.length === 0) return null;
  const entryName = entry.relativePath.split('/').pop() ?? entry.relativePath;
  return { entryName, missing };
}

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
    // A multi-glTF folder prompts the user to pick which model; one entry imports
    // straight through (#214). Cancelling the chooser returns null → no-op.
    await ingestAndImportGltf(files, folderName);
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
 * Open the OS DIRECTORY picker and ingest the selection as one model. The
 * shared implementation behind `openImportPicker` AND the file-picker auto-
 * escalation (`openGltfFilePicker`). Directory pickers ship natively in
 * Chromium/Firefox/Safari (no `showDirectoryPicker` fallback needed) and are
 * the only affordance that captures a multi-file glTF's `.bin`/texture siblings
 * (#82); a lone `.bvh`/`.fbx` placed in a folder routes through the single-file
 * path.
 *
 * `opts.onCancel` fires when the user dismisses the dialog WITHOUT choosing
 * (the input's `cancel` event — Chrome 113+/Firefox/Safari 16.4+, plus the
 * empty-selection guard). The escalation path uses it to fall back to an
 * actionable banner so a dismissed escalation is never a silent no-op (V38).
 */
function openDirectoryImport(opts?: { onCancel?: () => void }): void {
  const input = makeHiddenInput('.gltf,.glb,.bvh,.fbx', true);
  let handled = false;
  input.onchange = () => {
    handled = true;
    void (async () => {
      try {
        if (!input.files || input.files.length === 0) {
          opts?.onCancel?.();
          return;
        }
        const files = await inputFilesToFiles(input.files);
        await ingestOneModel(files);
      } catch (err) {
        const message = formatAssetError(err);
        // ingestGltfFolder already reports "import failed:"-prefixed errors to
        // the banner before re-throwing — don't double-report them here.
        if (!message.startsWith('import failed:')) {
          useAssetErrorStore.getState().report('menu-import', message);
        }
      } finally {
        input.remove();
      }
    })();
  };
  // `cancel` fires when the dialog is dismissed (no `change` event is emitted
  // on cancel). Without this, a dismissed escalation would leave the user with
  // nothing — the silent no-op H88/V38 exist to prevent.
  input.addEventListener('cancel', () => {
    if (handled) return;
    opts?.onCancel?.();
    input.remove();
  });
  input.click();
}

export function openImportPicker(): void {
  openDirectoryImport();
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
 * can't capture siblings nested in sub-folders. Rather than dead-end, picking a
 * multi-file `.gltf` here AUTO-ESCALATES to the directory picker
 * (`gltfImportNeedsFolder` → `openDirectoryImport`) so the siblings come along —
 * the user never has to know which menu item to reach for. A self-contained
 * `.glb` or a flat `.gltf` selected together with its siblings imports directly.
 */
export function openGltfFilePicker(): void {
  const input = makeHiddenInput('.gltf,.glb', false);
  input.onchange = () => {
    void (async () => {
      try {
        if (!input.files || input.files.length === 0) return;
        const files = await inputFilesToFiles(input.files);

        // Auto-escalate (#H88): a multi-file `.gltf` references sibling
        // `.bin`/textures by relative URI, which a lone FILE pick can't capture
        // (browser security — a file input never exposes siblings). Rather than
        // dead-end with an error, re-open as the DIRECTORY picker WITHIN this
        // same user-activation window so the user grants the whole folder and
        // the siblings come along. On dismiss, fall back to actionable guidance
        // (never a silent no-op — V38). Self-contained `.glb` / flat `.gltf`
        // picked with its siblings return null here and import normally.
        const need = gltfImportNeedsFolder(files);
        if (need) {
          openDirectoryImport({
            onCancel: () => {
              useAssetErrorStore
                .getState()
                .report(need.entryName, formatMissingSiblingsError(need.entryName, need.missing));
            },
          });
          return;
        }

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
        const message = formatAssetError(err);
        // ingestGltfFolder already reports "import failed:"-prefixed errors to
        // the banner before re-throwing — don't double-report them here.
        if (!message.startsWith('import failed:')) {
          useAssetErrorStore.getState().report('menu-import-gltf', message);
        }
      } finally {
        input.remove();
      }
    })();
  };
  input.click();
}
