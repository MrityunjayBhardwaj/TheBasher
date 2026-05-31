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

import { getStorage } from '../boot';

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
