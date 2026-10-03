// OPFS-backed StorageCapability for browser builds.
//
// Read-back-verify on every save is mandatory — OPFS quota exhaustion can
// silently truncate writes, which manifests as "save succeeded but reload
// loses changes." (Hetvabhasa: OPFS quota silent fail.)
//
// REF: THESIS.md §33, krama K5 step 4, dharana B2.

import {
  StorageNotFoundError,
  type StorageCapability,
  type StorageQuota,
} from './StorageCapability';

/** OPFS says "absent" with a DOMException named NotFoundError (a missing file or directory). */
const isOpfsNotFound = (e: unknown) => e instanceof DOMException && e.name === 'NotFoundError';

/**
 * #1293 — operations on ONE path run one at a time; different paths still run in parallel.
 *
 * A write is `createWritable → write → close`, then a read-back of the file (the check above).
 * When a second write to the same path lands between those steps, it replaces the file behind the
 * first write's `File`, and the read-back throws `NotReadableError` or `NotFoundError`. Measured in
 * Chromium: 17 of 40 overlapping writes of one 3 MB file failed; 40 of 40 one after another
 * succeeded. The overlap is ordinary, not exotic: the idle autosave writes the open project's
 * file, and so does every explicit save, including the one opening a `.basher` file makes first.
 *
 * Module-level and keyed by root + path, so two `OpfsStorage` instances over one origin share it.
 */
const pathQueues = new Map<string, Promise<void>>();

function exclusive<T>(key: string, op: () => Promise<T>): Promise<T> {
  const previous = pathQueues.get(key) ?? Promise.resolve();
  // After the previous operation SETTLES, success or not: one failed write must not wedge the path.
  const run = previous.then(op, op);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  pathQueues.set(key, tail);
  void tail.then(() => {
    if (pathQueues.get(key) === tail) pathQueues.delete(key);
  });
  return run;
}

/**
 * #1295 — dev-only: storage as slow as CI's. CI's OPFS took ~2.7 s per 3 MB write + read-back;
 * locally it takes milliseconds, and CPU throttling leaves disk speed alone, so CI-only failures on
 * save/load/list paths never reproduce here. Set before the app boots (a Playwright init script):
 *
 *   globalThis.__BASHER_SLOW_STORAGE__ = { msPerKb: 0.45 }
 *
 * Every byte written or read costs `msPerKb` per KB on ONE shared disk: operations on different
 * paths queue for it, as they share a real disk's bandwidth. CI's two measurements bracket the
 * rate: 0.45 matches its 3 MB write + read-back (2.7 s), 0.2 its 9.5 MB example write (4.1 s).
 * Production builds never read it: `import.meta.env.DEV` is false there and the body drops out.
 */
interface SlowStorage {
  msPerKb: number;
}
let diskFreeAt = 0;

async function occupyDisk(byteCount: number): Promise<void> {
  if (!import.meta.env.DEV) return;
  const slow = (globalThis as { __BASHER_SLOW_STORAGE__?: SlowStorage }).__BASHER_SLOW_STORAGE__;
  if (!slow || !(slow.msPerKb > 0)) return;
  const now = performance.now();
  diskFreeAt = Math.max(now, diskFreeAt) + (byteCount / 1024) * slow.msPerKb;
  await new Promise((resolve) => setTimeout(resolve, diskFreeAt - now));
}

export class OpfsStorage implements StorageCapability {
  readonly id = 'opfs';
  readonly kind = 'opfs' as const;

  /**
   * #1423 — folder handles by path (`''` is the root folder), so an operation on a folder already
   * seen costs only its file-level calls. Inside the app each awaited OPFS call costs about one
   * render frame, and re-walking from the origin root on every call made a `write` two folders
   * deep 12 calls, a `read` 6 and an `exists` 5.
   *
   * A handle names a path, not a folder: when its folder is removed (an empty folder through
   * `delete`, or the whole root by a test) every call on it throws `NotFoundError`, and once the
   * folder is recreated the same handle works again (measured in Chromium). So a cached handle is
   * wrong only while its folder is absent, and then a walk from the root finds nothing either:
   * a read, `exists`, `list` or `delete` that fails through the cache has its true answer. Only a
   * write must recreate the folders, so it alone walks again from the root (`fileHandle`).
   */
  private readonly dirs = new Map<string, FileSystemDirectoryHandle>();

  constructor(private readonly rootName = 'basher') {}

  async isAvailable(): Promise<boolean> {
    // Presence is a fast pre-gate, NOT the answer. `navigator.storage
    // .getDirectory` exists as a symbol in contexts where actually CALLING it
    // rejects with a SecurityError — opaque origins, sandboxed iframes,
    // blocked site-data, and some private-browsing modes. A presence-only
    // check returns true there, pickStorage selects OPFS, and the first real
    // call (getRoot) dies at boot ("Security error when calling GetDirectory")
    // — the IndexedDB/Memory fallback never runs. So PROBE the capability:
    // attempt getDirectory() and catch. Mirrors IndexedDbStorage.isAvailable,
    // which opens the DB to catch the same class of private-mode throw.
    // (Capability-detection, not feature-detection — dharana B2.)
    if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
      return false;
    }
    try {
      await navigator.storage.getDirectory();
      return true;
    } catch {
      return false;
    }
  }

  private async getRoot(): Promise<FileSystemDirectoryHandle> {
    const top = await navigator.storage.getDirectory();
    return top.getDirectoryHandle(this.rootName, { create: true });
  }

  private async resolveDir(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
    const names = parts.filter((part) => part !== '' && part !== '.');
    // Start from the deepest folder on this path the cache already holds.
    let depth = names.length;
    let dir = this.dirs.get(names.join('/'));
    while (!dir && depth > 0) dir = this.dirs.get(names.slice(0, --depth).join('/'));
    if (!dir) {
      dir = await this.getRoot();
      this.dirs.set('', dir);
    }
    for (let i = depth; i < names.length; i++) {
      dir = await dir.getDirectoryHandle(names[i], { create });
      this.dirs.set(names.slice(0, i + 1).join('/'), dir);
    }
    return dir;
  }

  private async fileHandle(path: string, create: boolean): Promise<FileSystemFileHandle> {
    const { dir, name } = this.split(path);
    const open = async () => (await this.resolveDir(dir, create)).getFileHandle(name, { create });
    if (!create) return open();
    try {
      return await open();
    } catch (e) {
      // A cached folder on this path was removed; walk from the root, creating it.
      if (!isOpfsNotFound(e)) throw e;
      this.dirs.clear();
      return open();
    }
  }

  private async readFile(fileHandle: FileSystemFileHandle): Promise<Uint8Array> {
    const file = await fileHandle.getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    await occupyDisk(bytes.byteLength);
    return bytes;
  }

  private split(path: string): { dir: string[]; name: string } {
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) throw new Error(`OpfsStorage: empty path`);
    return { dir: parts.slice(0, -1), name: parts[parts.length - 1] };
  }

  /** One key per file, however the path is spelled (`a//b` and `/a/b` are `a/b`, as in `split`). */
  private key(path: string): string {
    return `${this.rootName}/${path.split('/').filter(Boolean).join('/')}`;
  }

  write(path: string, bytes: Uint8Array): Promise<void> {
    return exclusive(this.key(path), () => this.writeNow(path, bytes));
  }

  read(path: string): Promise<Uint8Array> {
    return exclusive(this.key(path), () => this.readNow(path));
  }

  delete(path: string): Promise<void> {
    return exclusive(this.key(path), () => this.deleteNow(path));
  }

  private async writeNow(path: string, bytes: Uint8Array): Promise<void> {
    const fileHandle = await this.fileHandle(path, true);
    const writable = await fileHandle.createWritable();
    // Copy through a fresh ArrayBuffer to satisfy the strict BlobPart typing
    // in TS lib.dom (which excludes Uint8Array<SharedArrayBuffer>). At runtime
    // the buffer is always a plain ArrayBuffer here.
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    await writable.write(new Blob([ab]));
    await occupyDisk(bytes.byteLength);
    await writable.close();
    // Read-back verification (K5 step 4). Cheap: the data is hot in cache. Through the handle just
    // written (#1423), so the path is not resolved a second time.
    const verify = await this.readFile(fileHandle);
    if (verify.byteLength !== bytes.byteLength) {
      throw new Error(
        `OpfsStorage: read-back size mismatch on ${path} (wrote ${bytes.byteLength}, read ${verify.byteLength}). Likely OPFS quota exhausted.`,
      );
    }
  }

  private async readNow(path: string): Promise<Uint8Array> {
    let fileHandle: FileSystemFileHandle;
    try {
      fileHandle = await this.fileHandle(path, false);
    } catch (e) {
      // #1304 — only a missing file or directory is "absent"; every other failure stays itself.
      if (isOpfsNotFound(e)) throw new StorageNotFoundError(path);
      throw e;
    }
    return this.readFile(fileHandle);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.fileHandle(path, false);
      return true;
    } catch {
      return false;
    }
  }

  private async deleteNow(path: string): Promise<void> {
    const { dir, name } = this.split(path);
    try {
      const dirHandle = await this.resolveDir(dir, false);
      await dirHandle.removeEntry(name);
    } catch {
      // Idempotent: deleting a missing file is success.
    }
  }

  async list(dirPath: string): Promise<string[]> {
    const parts = dirPath.split('/').filter(Boolean);
    try {
      const dirHandle = await this.resolveDir(parts, false);
      const entries: string[] = [];
      // FileSystemDirectoryHandle is async-iterable in modern browsers.
      for await (const [entryName] of (
        dirHandle as unknown as { entries(): AsyncIterable<[string, unknown]> }
      ).entries()) {
        entries.push(entryName);
      }
      return entries;
    } catch (e) {
      // #1304 — a directory that does not exist has no children, as in every other backend.
      // A removed folder's cached handle throws the same NotFoundError while iterating.
      if (isOpfsNotFound(e)) return [];
      throw e;
    }
  }

  async quota(): Promise<StorageQuota | null> {
    if (typeof navigator?.storage?.estimate !== 'function') return null;
    const est = await navigator.storage.estimate();
    return {
      usage: est.usage ?? 0,
      quota: est.quota ?? 0,
    };
  }
}
