// Coverage for the Wave B browser-API readers (Phase 7.9, issue #110).
//
// Non-negotiable assertion: `dropItemsToFiles` LOOPS `readEntries`
// until the callback yields an empty array. A single-call implementation
// passes the "single batch" test but fails the "two batches" test — the
// Chrome ~100/call cap is the documented footgun this guards against.
//
// Nesting assertion: directory entries surface their `entry.fullPath`
// verbatim (minus the leading slash). Flattening to `file.name` would
// break the nested-entry glTF case (the resolver depends on the path).
//
// REF: Phase 7.9 PLAN Wave B verify clauses; RESEARCH §1.

import { describe, expect, it } from 'vitest';
import { dropItemsToFiles, inputFilesToFiles, plainFilesToFiles } from './ingestReaders';

// ---------- stubs ----------

interface StubFile {
  name: string;
  webkitRelativePath: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

function stubFile(
  name: string,
  bytes: Uint8Array,
  opts: { webkitRelativePath?: string } = {},
): StubFile {
  return {
    name,
    webkitRelativePath: opts.webkitRelativePath ?? '',
    // Slice into a fresh ArrayBuffer (detached, like the real File would
    // produce) so callers can safely wrap with Uint8Array.
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function stubFileEntry(fullPath: string, file: StubFile): FileSystemFileEntry {
  const name = fullPath.split('/').filter(Boolean).pop() ?? '';
  return {
    isFile: true,
    isDirectory: false,
    name,
    fullPath,
    filesystem: {} as FileSystem,
    file: (cb: (f: File) => void) => cb(file as unknown as File),
    getParent: () => undefined,
  } as unknown as FileSystemFileEntry;
}

/**
 * Stub a directory entry whose `createReader().readEntries` returns the
 * supplied batches in order, then `[]`. `batches` is the ordered list
 * of batches; the loop should observe ALL of them before stopping.
 */
function stubDirEntry(fullPath: string, batches: FileSystemEntry[][]): FileSystemDirectoryEntry {
  const name = fullPath.split('/').filter(Boolean).pop() ?? '';
  const queue = [...batches, [] as FileSystemEntry[]];
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath,
    filesystem: {} as FileSystem,
    createReader: () => ({
      readEntries: (cb: (entries: FileSystemEntry[]) => void) => {
        const next = queue.shift();
        cb(next ?? []);
      },
    }),
    getFile: () => undefined,
    getDirectory: () => undefined,
  } as unknown as FileSystemDirectoryEntry;
}

function stubItem(entry: FileSystemEntry | null): DataTransferItem {
  return {
    kind: 'file',
    type: '',
    getAsFile: () => null,
    getAsString: () => undefined,
    webkitGetAsEntry: () => entry,
  } as unknown as DataTransferItem;
}

function stubItemList(items: DataTransferItem[]): DataTransferItemList {
  const list = {
    length: items.length,
    add: () => null,
    clear: () => undefined,
    remove: () => undefined,
    [Symbol.iterator]: function* () {
      for (const it of items) yield it;
    },
  } as unknown as DataTransferItemList;
  // index access
  items.forEach((it, i) => {
    (list as unknown as Record<number, DataTransferItem>)[i] = it;
  });
  return list;
}

function stubFileList(files: StubFile[]): FileList {
  const list = {
    length: files.length,
    item: (i: number) => files[i] as unknown as File,
  } as unknown as FileList;
  files.forEach((f, i) => {
    (list as unknown as Record<number, File>)[i] = f as unknown as File;
  });
  return list;
}

// ---------- tests ----------

describe('dropItemsToFiles', () => {
  it('reads a single dropped file (entry.fullPath → relativePath)', async () => {
    const f = stubFile('foo.glb', new Uint8Array([1, 2, 3]));
    const entry = stubFileEntry('/foo.glb', f);
    const items = stubItemList([stubItem(entry)]);

    const out = await dropItemsToFiles(items);

    expect(out).toHaveLength(1);
    expect(out[0].relativePath).toBe('foo.glb');
    expect(out[0].bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('drains a directory whose readEntries returns one batch then empty', async () => {
    const a = stubFileEntry('/dir/a.glb', stubFile('a.glb', new Uint8Array([1])));
    const b = stubFileEntry('/dir/b.bin', stubFile('b.bin', new Uint8Array([2])));
    const c = stubFileEntry('/dir/c.png', stubFile('c.png', new Uint8Array([3])));
    const dir = stubDirEntry('/dir', [[a, b, c]]);
    const items = stubItemList([stubItem(dir)]);

    const out = await dropItemsToFiles(items);

    const paths = out.map((x) => x.relativePath).sort();
    expect(paths).toEqual(['dir/a.glb', 'dir/b.bin', 'dir/c.png']);
  });

  it('LOOPS readEntries until empty: a two-batch directory yields ALL files', async () => {
    // Non-negotiable: a single-call reader implementation passes the
    // one-batch test but truncates here. Chrome's ~100-cap is the
    // documented footgun this case guards against.
    const a = stubFileEntry('/dir/a.glb', stubFile('a.glb', new Uint8Array([1])));
    const b = stubFileEntry('/dir/b.bin', stubFile('b.bin', new Uint8Array([2])));
    const c = stubFileEntry('/dir/c.png', stubFile('c.png', new Uint8Array([3])));
    const dir = stubDirEntry('/dir', [[a, b], [c]]);
    const items = stubItemList([stubItem(dir)]);

    const out = await dropItemsToFiles(items);

    expect(out).toHaveLength(3);
    const paths = out.map((x) => x.relativePath).sort();
    expect(paths).toEqual(['dir/a.glb', 'dir/b.bin', 'dir/c.png']);
  });

  it('preserves nesting verbatim for a nested-entry directory', async () => {
    // /myasset/gltf/scene.gltf — the file's fullPath survives as
    // relativePath, NOT flattened to scene.gltf (resolver depends on it).
    const sceneFile = stubFileEntry(
      '/myasset/gltf/scene.gltf',
      stubFile('scene.gltf', new Uint8Array([9])),
    );
    const gltfDir = stubDirEntry('/myasset/gltf', [[sceneFile]]);
    const rootDir = stubDirEntry('/myasset', [[gltfDir]]);
    const items = stubItemList([stubItem(rootDir)]);

    const out = await dropItemsToFiles(items);

    expect(out).toHaveLength(1);
    expect(out[0].relativePath).toBe('myasset/gltf/scene.gltf');
  });

  it('skips items whose webkitGetAsEntry returns null', async () => {
    const f = stubFile('keep.glb', new Uint8Array([1]));
    const entry = stubFileEntry('/keep.glb', f);
    const items = stubItemList([stubItem(null), stubItem(entry)]);

    const out = await dropItemsToFiles(items);

    expect(out).toHaveLength(1);
    expect(out[0].relativePath).toBe('keep.glb');
  });
});

describe('plainFilesToFiles', () => {
  it('maps each File to an IngestFile with relativePath = name', async () => {
    const files = stubFileList([
      stubFile('a.glb', new Uint8Array([1, 2])),
      stubFile('b.txt', new Uint8Array([3, 4])),
    ]);

    const out = await plainFilesToFiles(files);

    expect(out).toHaveLength(2);
    expect(out[0].relativePath).toBe('a.glb');
    expect(out[0].bytes).toEqual(new Uint8Array([1, 2]));
    expect(out[1].relativePath).toBe('b.txt');
    expect(out[1].bytes).toEqual(new Uint8Array([3, 4]));
  });
});

describe('inputFilesToFiles', () => {
  it('preserves webkitRelativePath for the directory <input> shape', async () => {
    const files = stubFileList([
      stubFile('foo.png', new Uint8Array([5]), {
        webkitRelativePath: 'myasset/textures/foo.png',
      }),
    ]);

    const out = await inputFilesToFiles(files);

    expect(out).toHaveLength(1);
    expect(out[0].relativePath).toBe('myasset/textures/foo.png');
  });

  it('falls back to file.name for the single-file <input> shape', async () => {
    const files = stubFileList([
      stubFile('cube.glb', new Uint8Array([7]), { webkitRelativePath: '' }),
    ]);

    const out = await inputFilesToFiles(files);

    expect(out).toHaveLength(1);
    expect(out[0].relativePath).toBe('cube.glb');
  });
});
