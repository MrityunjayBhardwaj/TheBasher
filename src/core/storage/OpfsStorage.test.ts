// #1423 — OpfsStorage resolves a folder it has seen without walking from the origin root again.
//
// Inside the app each awaited OPFS call costs about one render frame, so the count of calls per
// operation is the cost. Re-walking the path on every call made a write two folders deep 12
// calls, a read 6 and an exists 5 (measured in Chromium in the editor, with the calls wrapped).
//
// The fake below follows what Chromium showed for a handle whose folder is removed: every call on
// it throws NotFoundError, and once the folder is recreated the same handle works again. A handle
// here holds only its path, and each call looks the path up at that moment.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpfsStorage } from './OpfsStorage';
import { StorageNotFoundError } from './StorageCapability';

type Dir = Map<string, Dir | Uint8Array>;

/** An in-memory origin file system, counting every awaited call the way the e2e probe does. */
function fakeOpfs() {
  const top: Dir = new Map();
  let calls = 0;
  const notFound = () => new DOMException('not found', 'NotFoundError');
  const lookup = (path: readonly string[]): Dir => {
    let d = top;
    for (const name of path) {
      const next = d.get(name);
      if (!(next instanceof Map)) throw notFound();
      d = next;
    }
    return d;
  };
  const fileHandle = (path: readonly string[], name: string) => ({
    async getFile() {
      calls++;
      const bytes = lookup(path).get(name);
      if (!(bytes instanceof Uint8Array)) throw notFound();
      return { arrayBuffer: async () => bytes.slice().buffer };
    },
    async createWritable() {
      calls++;
      let pending = new Uint8Array();
      return {
        async write(blob: Blob) {
          pending = new Uint8Array(await blob.arrayBuffer());
        },
        async close() {
          lookup(path).set(name, pending);
        },
      };
    },
  });
  const dirHandle = (path: readonly string[]): unknown => ({
    async getDirectoryHandle(name: string, o?: { create?: boolean }) {
      calls++;
      const d = lookup(path);
      const next = d.get(name);
      if (next instanceof Uint8Array) throw new DOMException('a file', 'TypeMismatchError');
      if (!next) {
        if (!o?.create) throw notFound();
        d.set(name, new Map());
      }
      return dirHandle([...path, name]);
    },
    async getFileHandle(name: string, o?: { create?: boolean }) {
      calls++;
      const d = lookup(path);
      const entry = d.get(name);
      if (entry instanceof Map) throw new DOMException('a folder', 'TypeMismatchError');
      if (!entry) {
        if (!o?.create) throw notFound();
        d.set(name, new Uint8Array());
      }
      return fileHandle(path, name);
    },
    async removeEntry(name: string, o?: { recursive?: boolean }) {
      calls++;
      const d = lookup(path);
      const entry = d.get(name);
      if (!entry) throw notFound();
      if (entry instanceof Map && entry.size > 0 && !o?.recursive)
        throw new DOMException('not empty', 'InvalidModificationError');
      d.delete(name);
    },
    async *entries() {
      for (const name of [...lookup(path).keys()]) yield [name, null];
    },
  });
  const storage = {
    async getDirectory() {
      calls++;
      return dirHandle([]);
    },
  };
  return {
    storage,
    calls: () => calls,
    /** Remove `name` from the origin root, as a test's cleanup does from the page. */
    removeTop: (name: string) => top.delete(name),
    /** Remove a folder under the store's root, as another tab or instance would. */
    removeUnder: (root: string, path: string[]) => {
      lookup([root, ...path.slice(0, -1)]).delete(path[path.length - 1]);
    },
  };
}

let fs: ReturnType<typeof fakeOpfs>;
beforeEach(() => {
  fs = fakeOpfs();
  vi.stubGlobal('navigator', { storage: fs.storage } as unknown as Navigator);
});
afterEach(() => vi.unstubAllGlobals());

const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const PATH = 'renders/job/frame_0000.png';

async function callsFor(op: () => Promise<unknown>): Promise<number> {
  const before = fs.calls();
  await op();
  return fs.calls() - before;
}

describe('#1423 — OpfsStorage on a warm path', () => {
  it('a cold write walks the path; then write, read and exists cost only their file calls', async () => {
    const s = new OpfsStorage();
    // Cold: the origin root, the store's root, two folders, then the file.
    expect(await callsFor(() => s.write(PATH, BYTES))).toBe(7);
    // Warm (was 12 / 6 / 5 in Chromium): the file handle, its writable, and the read-back.
    expect(await callsFor(() => s.write(PATH, BYTES))).toBe(3);
    expect(await callsFor(() => s.read(PATH))).toBe(2);
    expect(await callsFor(() => s.exists(PATH))).toBe(1);
    expect(await s.read(PATH)).toEqual(BYTES);
  });

  it('a missing file on a warm path costs one call and reads as missing', async () => {
    const s = new OpfsStorage();
    await s.write(PATH, BYTES);
    expect(await callsFor(() => s.exists('renders/job/frame_0001.png'))).toBe(1);
    expect(await s.exists('renders/job/frame_0001.png')).toBe(false);
    await expect(s.read('renders/job/frame_0001.png')).rejects.toBeInstanceOf(StorageNotFoundError);
  });
});

describe('#1423 — a cached folder removed underneath', () => {
  it('the whole store wiped from the page: reads miss, and the next write recreates it', async () => {
    const s = new OpfsStorage();
    await s.write(PATH, BYTES);
    fs.removeTop('basher');

    expect(await s.exists(PATH)).toBe(false);
    await expect(s.read(PATH)).rejects.toBeInstanceOf(StorageNotFoundError);
    expect(await s.list('renders/job')).toEqual([]);
    await s.delete(PATH); // still idempotent

    await s.write(PATH, BYTES);
    expect(await s.read(PATH)).toEqual(BYTES);
    expect(await s.list('renders/job')).toEqual(['frame_0000.png']);
  });

  it('a folder removed by someone else, then recreated: the cached handle sees the new one', async () => {
    const s = new OpfsStorage();
    const other = new OpfsStorage();
    await s.write(PATH, BYTES);
    fs.removeUnder('basher', ['renders', 'job']);
    expect(await s.exists(PATH)).toBe(false);

    await other.write(PATH, new Uint8Array([9]));
    expect(await s.read(PATH)).toEqual(new Uint8Array([9]));
  });

  it('an empty folder deleted through the store, then written into again', async () => {
    const s = new OpfsStorage();
    await s.write(PATH, BYTES);
    await s.delete(PATH);
    await s.delete('renders/job'); // removeEntry takes an empty folder (importCommon relies on it)
    expect(await s.list('renders')).toEqual([]);

    await s.write(PATH, BYTES);
    expect(await s.read(PATH)).toEqual(BYTES);
  });
});
