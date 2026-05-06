// IndexedDB-backed StorageCapability — universal browser fallback.
//
// Why both OPFS + IDB? OPFS is the modern path (filesystem-shaped, large
// quotas, sync access in workers). IDB is the universal fallback —
// available in every browser since ~2017, including private-browsing
// modes where OPFS is sometimes restricted. We keep OPFS preferred (faster,
// quota-friendlier) but add IDB so projects survive in environments OPFS
// can't serve.
//
// Key mapping: the path string IS the IDB key. The capability surface is
// "filesystem-shaped" (write/read/list at directory paths), so we store
// each file as one record and emulate `list(dir)` with a key-range scan.
//
// Dharana B2 still holds: this file is the only place outside core/storage/
// that knows about IDB. Callers see only `StorageCapability`.
//
// REF: THESIS.md §33, vyapti V6, dharana B2.

import type { StorageCapability, StorageQuota } from './StorageCapability';

const DB_NAME_DEFAULT = 'basher';
const STORE_NAME = 'files';
const DB_VERSION = 1;

function isAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function awaitRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export class IndexedDbStorage implements StorageCapability {
  readonly id = 'indexeddb';
  readonly kind = 'indexeddb' as const;

  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly dbName = DB_NAME_DEFAULT) {}

  async isAvailable(): Promise<boolean> {
    if (!isAvailable()) return false;
    try {
      // Probe by opening — private-browsing modes occasionally throw on open.
      await this.getDb();
      return true;
    } catch {
      return false;
    }
  }

  private getDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openDb(this.dbName);
    return this.dbPromise;
  }

  private async withStore<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => Promise<T> | T,
  ): Promise<T> {
    const db = await this.getDb();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      let result: T;
      Promise.resolve(fn(store))
        .then((v) => {
          result = v;
        })
        .catch(reject);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB tx failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB tx aborted'));
    });
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    // Copy through a fresh ArrayBuffer so we store a clean owned buffer
    // (mirrors H4's pattern in OpfsStorage — ArrayBufferLike vs ArrayBuffer
    // structural-clone gotchas in older Chromium builds).
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    await this.withStore('readwrite', (store) => {
      store.put(ab, path);
    });
    // Read-back verify (K5 step 4) — same discipline as OPFS.
    const back = await this.read(path);
    if (back.byteLength !== bytes.byteLength) {
      throw new Error(`IndexedDbStorage.write: round-trip length mismatch at ${path}`);
    }
  }

  async read(path: string): Promise<Uint8Array> {
    const value = await this.withStore('readonly', (store) => awaitRequest(store.get(path)));
    if (value === undefined) throw new Error(`IndexedDbStorage.read: not found: ${path}`);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array((value as ArrayBufferView).buffer);
    throw new Error(`IndexedDbStorage.read: unexpected stored shape at ${path}`);
  }

  async exists(path: string): Promise<boolean> {
    const count = await this.withStore('readonly', (store) => awaitRequest(store.count(path)));
    return count > 0;
  }

  async delete(path: string): Promise<void> {
    await this.withStore('readwrite', (store) => {
      store.delete(path);
    });
  }

  async list(dirPath: string): Promise<string[]> {
    const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
    const range = IDBKeyRange.bound(prefix, `${prefix}￿`, false, false);
    const out: string[] = [];
    await this.withStore('readonly', (store) => {
      return new Promise<void>((resolve, reject) => {
        const req = store.openKeyCursor(range);
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve();
            return;
          }
          const key = String(cursor.key);
          // Return immediate children only, like a directory listing.
          const rest = key.slice(prefix.length);
          const slash = rest.indexOf('/');
          const child = slash === -1 ? rest : rest.slice(0, slash);
          if (child && !out.includes(child)) out.push(child);
          cursor.continue();
        };
        req.onerror = () => reject(req.error ?? new Error('IndexedDB cursor failed'));
      });
    });
    return out;
  }

  async quota(): Promise<StorageQuota | null> {
    if (typeof navigator?.storage?.estimate !== 'function') return null;
    const est = await navigator.storage.estimate();
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  }
}
