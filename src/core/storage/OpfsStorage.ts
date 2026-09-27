// OPFS-backed StorageCapability for browser builds.
//
// Read-back-verify on every save is mandatory — OPFS quota exhaustion can
// silently truncate writes, which manifests as "save succeeded but reload
// loses changes." (Hetvabhasa: OPFS quota silent fail.)
//
// REF: THESIS.md §33, krama K5 step 4, dharana B2.

import type { StorageCapability, StorageQuota } from './StorageCapability';

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
  // TEMP-DIAG #1294 — remove before merge: how long an op waited for its turn and how long it ran.
  const queuedAt = performance.now();
  const timed = async (): Promise<T> => {
    const startedAt = performance.now();
    try {
      return await op();
    } finally {
      const waited = startedAt - queuedAt;
      const ran = performance.now() - startedAt;
      if (waited > 1000 || ran > 1000)
        console.warn(`[opfs-queue] ${key} waited ${Math.round(waited)}ms ran ${Math.round(ran)}ms`);
    }
  };
  // After the previous operation SETTLES, success or not: one failed write must not wedge the path.
  const run = previous.then(timed, timed);
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

export class OpfsStorage implements StorageCapability {
  readonly id = 'opfs';
  readonly kind = 'opfs' as const;

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
    let dir = await this.getRoot();
    for (const part of parts) {
      if (part === '' || part === '.') continue;
      dir = await dir.getDirectoryHandle(part, { create });
    }
    return dir;
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
    const { dir, name } = this.split(path);
    const dirHandle = await this.resolveDir(dir, true);
    const fileHandle = await dirHandle.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    // Copy through a fresh ArrayBuffer to satisfy the strict BlobPart typing
    // in TS lib.dom (which excludes Uint8Array<SharedArrayBuffer>). At runtime
    // the buffer is always a plain ArrayBuffer here.
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    await writable.write(new Blob([ab]));
    await writable.close();
    // Read-back verification (K5 step 4). Cheap: the data is hot in cache. Unqueued: this write
    // already holds the path, so queueing it would wait on itself.
    const verify = await this.readNow(path);
    if (verify.byteLength !== bytes.byteLength) {
      throw new Error(
        `OpfsStorage: read-back size mismatch on ${path} (wrote ${bytes.byteLength}, read ${verify.byteLength}). Likely OPFS quota exhausted.`,
      );
    }
  }

  private async readNow(path: string): Promise<Uint8Array> {
    const { dir, name } = this.split(path);
    const dirHandle = await this.resolveDir(dir, false);
    const fileHandle = await dirHandle.getFileHandle(name, { create: false });
    const file = await fileHandle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async exists(path: string): Promise<boolean> {
    const { dir, name } = this.split(path);
    try {
      const dirHandle = await this.resolveDir(dir, false);
      await dirHandle.getFileHandle(name, { create: false });
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
    const dirHandle = await this.resolveDir(parts, false);
    const entries: string[] = [];
    // FileSystemDirectoryHandle is async-iterable in modern browsers.
    for await (const [entryName] of (
      dirHandle as unknown as { entries(): AsyncIterable<[string, unknown]> }
    ).entries()) {
      entries.push(entryName);
    }
    return entries;
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
