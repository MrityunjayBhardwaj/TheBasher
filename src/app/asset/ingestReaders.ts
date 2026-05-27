// Browser-API → IngestFile adapters — Phase 7.9 Wave B (issue #110).
//
// Three thin readers, all producing the `IngestFile[]` shape that
// `importGltfFromOpfs` / `ingestGltfFolder` (Wave A) consume:
//
//   - `dropItemsToFiles(DataTransferItemList)` — webkitGetAsEntry +
//     readEntries LOOPED UNTIL EMPTY. Chrome's FileSystemDirectoryReader
//     caps each `readEntries` call at ~100 entries (the documented
//     footgun): a single-call implementation silently truncates real
//     exports. Looping until the callback yields an empty array is the
//     non-negotiable fix.
//   - `plainFilesToFiles(FileList)` — the no-folder OS-drop branch
//     (single-file drop without `webkitGetAsEntry`).
//   - `inputFilesToFiles(FileList)` — picker-side. Prefers
//     `file.webkitRelativePath` (the directory `<input>` pre-flattens
//     nesting into it) and falls back to `file.name` (the single-file
//     picker has no relative path).
//
// Nesting discipline (matches Wave A `ingestGltfFolder`):
//   `relativePath` is built from `entry.fullPath` for drop entries and
//   from `webkitRelativePath || name` for input files. Deeper segments
//   are preserved verbatim — flattening to `file.name` would break the
//   nested-entry case (a `gltf/scene.gltf` referencing
//   `../textures/foo.png` must keep its `gltf/` segment so sibling
//   resolution works post-write).
//
// REF: Phase 7.9 PLAN Wave B (Tasks 4 + 5); RESEARCH §1 (drop API +
//      readEntries footgun + webkitRelativePath); importGltf.ts
//      (IngestFile contract).

import type { IngestFile } from './importGltf';

/** Promisified wrapper around `FileSystemFileEntry.file(cb, err?)`. */
function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

/** Promisified single-batch readEntries call. */
function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });
}

/**
 * Drain a directory entry by calling `readEntries` REPEATEDLY until
 * the callback yields an empty array. Chrome caps each call at ~100
 * entries — looping is mandatory. Returns the flat list of all child
 * entries (files and directories alike).
 */
async function drainDirectory(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await readBatch(reader);
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

/**
 * Strip the leading slash from a `FileSystemEntry.fullPath` so it
 * matches the IngestFile contract (no leading `/`).
 */
function stripLeadingSlash(p: string): string {
  return p.replace(/^\//, '');
}

/**
 * Recursively collect every file under an entry into IngestFile[].
 * `relativePath` is built from `entry.fullPath`, preserving the full
 * nesting verbatim.
 */
async function collectFromEntry(entry: FileSystemEntry): Promise<IngestFile[]> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await fileFromEntry(fileEntry);
    const buf = await file.arrayBuffer();
    return [
      {
        relativePath: stripLeadingSlash(fileEntry.fullPath),
        bytes: new Uint8Array(buf),
      },
    ];
  }
  if (entry.isDirectory) {
    const children = await drainDirectory(entry as FileSystemDirectoryEntry);
    const nested: IngestFile[][] = await Promise.all(children.map((c) => collectFromEntry(c)));
    const out: IngestFile[] = [];
    for (const arr of nested) out.push(...arr);
    return out;
  }
  return [];
}

/**
 * Convert an OS drag-drop `DataTransferItemList` into `IngestFile[]`.
 *
 * For each item, `webkitGetAsEntry()` gives us the (possibly directory)
 * entry. Directories are drained via the readEntries-until-empty loop
 * (the footgun fix). File entries become a single IngestFile with
 * `relativePath = entry.fullPath` (leading `/` stripped).
 *
 * Items whose `webkitGetAsEntry()` returns null (non-file drag types,
 * e.g. text/uri-list) are skipped.
 */
export async function dropItemsToFiles(items: DataTransferItemList): Promise<IngestFile[]> {
  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    // webkitGetAsEntry is the standard drop-entry hook even though the
    // name suggests vendor-prefix; it's implemented in every modern
    // browser and is the only path that exposes the directory shape.
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  const nested = await Promise.all(entries.map((e) => collectFromEntry(e)));
  const out: IngestFile[] = [];
  for (const arr of nested) out.push(...arr);
  return out;
}

/**
 * Convert a `DataTransfer.files` FileList into `IngestFile[]` for the
 * no-folder OS-drop branch (drops on browsers/versions where
 * `webkitGetAsEntry` is unavailable, or single-file drops).
 *
 * No directory shape is recoverable here — `relativePath` is just the
 * file name.
 */
export async function plainFilesToFiles(files: FileList): Promise<IngestFile[]> {
  const out: IngestFile[] = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const buf = await file.arrayBuffer();
    out.push({ relativePath: file.name, bytes: new Uint8Array(buf) });
  }
  return out;
}

/**
 * Convert an `<input type="file">` FileList into `IngestFile[]`.
 *
 * Serves BOTH picker affordances Wave D wires up:
 *   - `<input webkitdirectory multiple>` — the browser pre-flattens
 *     nesting into `file.webkitRelativePath` (e.g.
 *     `myasset/textures/foo.png`).
 *   - `<input accept=".glb,.gltf">` — single-file picker; only
 *     `file.name` is populated.
 *
 * The `webkitRelativePath || name` fallback covers both shapes
 * uniformly.
 */
export async function inputFilesToFiles(files: FileList): Promise<IngestFile[]> {
  const out: IngestFile[] = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const relativePath = file.webkitRelativePath || file.name;
    const buf = await file.arrayBuffer();
    out.push({ relativePath, bytes: new Uint8Array(buf) });
  }
  return out;
}
