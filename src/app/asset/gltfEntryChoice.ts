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

/**
 * Decide which glTF entry to import from an ingest set:
 *   - 0 or 1 entry  → `{ entry: undefined }` (no prompt; `ingestGltfFolder`
 *     auto-locates as before).
 *   - 2+ entries    → open the chooser; `{ entry: <relativePath> }` on pick,
 *     or `null` when the user dismisses (the import should abort).
 * Entries are offered richest-first (most textures, then materials) so the
 * "real" textured model is the default focus.
 */
export async function resolveGltfEntryChoice(
  files: readonly IngestFile[],
): Promise<{ entry: string | undefined } | null> {
  const entries = locateGltfEntries(files);
  if (entries.length <= 1) return { entry: undefined };

  const options = entries
    .map((e) => ({ relativePath: e.relativePath, ...summarizeGltfEntry(e.bytes) }))
    .sort((a, b) => (b.textures ?? -1) - (a.textures ?? -1) || (b.materials ?? -1) - (a.materials ?? -1));

  const chosen = await chooseGltfEntry(options);
  if (chosen === null) return null; // dismissed → abort
  return { entry: chosen };
}

/**
 * Resolve the entry choice, ingest the folder once, and import the chosen entry.
 * Returns the imported entry's OPFS path, or null when the user cancelled the
 * chooser. The single glTF ingest+import path for interactive imports.
 */
export async function ingestAndImportGltf(
  files: readonly IngestFile[],
  folderName: string,
): Promise<string | null> {
  const choice = await resolveGltfEntryChoice(files);
  if (!choice) return null; // user dismissed the chooser
  const entryPath = await ingestGltfFolder(files, folderName, choice.entry);
  await importGltfFromOpfs(entryPath);
  return entryPath;
}
