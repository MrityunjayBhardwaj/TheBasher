// Write notice — every storage `pickStorage` hands out says which path it just wrote (#1312).
//
// The asset loaders cache a read that failed, so a missing file does not suspend forever. Their
// stores are content-addressed, so the file usually comes back under the SAME path: the same HDRI
// imported again, an identical mesh baked, the same image imported. Without a signal the cached
// failure outlives the fact, and new work of identical content inherits it (measured: a fresh
// bake drew empty, a fresh import drew the stand-in, until a reload). A write to the path is the
// event that makes the old verdict false, so this is where it is announced.
//
// It wraps the backend inside `pickStorage`, not at one caller, so no writer can go around it:
// four call sites take a storage straight from `pickStorage` rather than `getStorage`.
//
// REF: src/app/asset/readFailures.ts (the listener); issue #1312.

import type { StorageCapability } from './StorageCapability';

type WriteListener = (path: string) => void;

const listeners = new Set<WriteListener>();

/** Listen for completed writes. Returns the unsubscribe. */
export function onStorageWrite(listener: WriteListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The same storage, announcing each write once it has landed. A write that throws announces
 * nothing: the file is not there, so nothing cached about it has become false.
 */
export function withWriteNotice(storage: StorageCapability): StorageCapability {
  return {
    get id() {
      return storage.id;
    },
    get kind() {
      return storage.kind;
    },
    isAvailable: () => storage.isAvailable(),
    async write(path, bytes) {
      await storage.write(path, bytes);
      for (const listener of [...listeners]) listener(path);
    },
    read: (path) => storage.read(path),
    exists: (path) => storage.exists(path),
    delete: (path) => storage.delete(path),
    list: (dirPath) => storage.list(dirPath),
    quota: () => storage.quota(),
  };
}
