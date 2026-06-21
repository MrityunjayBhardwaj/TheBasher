// gltfEntryChoice — the shared "which glTF + ingest + import" chokepoint (#214
// follow-up). When an imported folder holds more than one glTF entry, prompt the
// user to pick which model to import (the chooser modal) instead of silently
// auto-guessing the shallowest one. ONE entry → no prompt, behaves exactly as
// before. Used by every INTERACTIVE import path (menu picker, drag-drop, the e2e
// seam) so the behavior can't diverge (B12); the agent path and pure callers
// keep auto-locate via `ingestGltfFolder` directly.

import {
  ingestGltfFolder,
  importGltfFromOpfs,
  locateGltfEntries,
  summarizeGltfEntry,
  type IngestFile,
} from './importGltf';
import { chooseGltfEntry } from '../stores/gltfEntryChooserStore';

/** The resolved import intent: ONE entry (auto-located when undefined, or the
 *  chosen relativePath), ALL entries each as its own model (#219), or null
 *  (dismissed → abort). */
export type GltfEntryResolution =
  | { entry: string | undefined }
  | { all: readonly string[] }
  | null;

/**
 * Decide which glTF entry/entries to import from an ingest set:
 *   - 0 or 1 entry  → `{ entry: undefined }` (no prompt; `ingestGltfFolder`
 *     auto-locates as before).
 *   - 2+ entries    → open the chooser; `{ entry: <relativePath> }` on a single
 *     pick, `{ all: [...] }` on "import all", or `null` when dismissed.
 * Entries are offered richest-first (most textures, then materials) so the
 * "real" textured model is the default focus.
 */
export async function resolveGltfEntryChoice(
  files: readonly IngestFile[],
): Promise<GltfEntryResolution> {
  const entries = locateGltfEntries(files);
  if (entries.length <= 1) return { entry: undefined };

  const options = entries
    .map((e) => ({ relativePath: e.relativePath, ...summarizeGltfEntry(e.bytes) }))
    .sort((a, b) => (b.textures ?? -1) - (a.textures ?? -1) || (b.materials ?? -1) - (a.materials ?? -1));

  const chosen = await chooseGltfEntry(options);
  if (chosen === null) return null; // dismissed → abort
  if (chosen.type === 'all') return { all: options.map((o) => o.relativePath) };
  return { entry: chosen.relativePath };
}

/** A per-entry import folder name = the entry's filename stem (so each imported
 *  model is identifiable in My Imports, e.g. `car_red.gltf` → `car_red`). Falls
 *  back to the dropped folder name when the stem is empty. */
function entryFolderName(folderName: string, entryRelativePath: string): string {
  const base = entryRelativePath.split('/').pop() ?? entryRelativePath;
  const stem = base.replace(/\.(gltf|glb)$/i, '');
  return stem.length > 0 ? stem : folderName;
}

/**
 * Resolve the entry choice, ingest the folder, and import. Returns the last
 * imported entry's OPFS path, or null when the user cancelled the chooser. The
 * single glTF ingest+import path for interactive imports.
 *
 * "Import all" (#219) ingests EACH entry into its OWN resolved folder (named by
 * the entry's stem) and imports it as a separate model — so each entry's
 * spec/gloss conversion + baked sibling textures stay isolated (no cross-entry
 * collision). Entries that share heavy assets duplicate those bytes per model
 * (the documented v1 trade-off for isolation simplicity).
 */
export async function ingestAndImportGltf(
  files: readonly IngestFile[],
  folderName: string,
): Promise<string | null> {
  const choice = await resolveGltfEntryChoice(files);
  if (!choice) return null; // user dismissed the chooser

  if ('all' in choice) {
    let lastPath: string | null = null;
    for (const entryRelativePath of choice.all) {
      const entryPath = await ingestGltfFolder(
        files,
        entryFolderName(folderName, entryRelativePath),
        entryRelativePath,
      );
      await importGltfFromOpfs(entryPath);
      lastPath = entryPath;
    }
    return lastPath;
  }

  const entryPath = await ingestGltfFolder(files, folderName, choice.entry);
  await importGltfFromOpfs(entryPath);
  return entryPath;
}
