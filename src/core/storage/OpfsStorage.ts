// OPFS-backed StorageCapability for browser builds.
//
// Read-back-verify on every save is mandatory — OPFS quota exhaustion can
// silently truncate writes, which manifests as "save succeeded but reload
// loses changes." (Hetvabhasa: OPFS quota silent fail.)
//
// REF: THESIS.md §33, krama K5 step 4, dharana B2.

import type { StorageCapability, StorageQuota } from './StorageCapability';

export class OpfsStorage implements StorageCapability {
  readonly id = 'opfs';
  readonly kind = 'opfs' as const;

  constructor(private readonly rootName = 'basher') {}

  async isAvailable(): Promise<boolean> {
    return (
      typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function'
    );
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

  async write(path: string, bytes: Uint8Array): Promise<void> {
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
    // Read-back verification (K5 step 4). Cheap: the data is hot in cache.
    const verify = await this.read(path);
    if (verify.byteLength !== bytes.byteLength) {
      throw new Error(
        `OpfsStorage: read-back size mismatch on ${path} (wrote ${bytes.byteLength}, read ${verify.byteLength}). Likely OPFS quota exhausted.`,
      );
    }
  }

  async read(path: string): Promise<Uint8Array> {
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

  async delete(path: string): Promise<void> {
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
