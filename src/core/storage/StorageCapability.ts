// Storage capability — the only contract code outside `core/storage/` may
// touch. Two impls: OpfsStorage (browser, v0.5) and TauriStorage (v0.6 stub).
//
// V6 (capability interfaces decouple browser/native impls): no caller imports
// `tauri-*` or `node:fs` directly. Switching backends is a one-line provider
// swap.
//
// REF: THESIS.md §33, vyapti V6, dharana B2.

/**
 * #1304 — "nothing is there", as every backend says it. It is the ONLY failure that licenses
 * treating a path as absent (rebuilding it, or listing its directory as empty). Anything else a
 * read throws means "could not look", and a caller that answers it by writing destroys whatever
 * was there: a locked, slow or corrupt file is not a missing one.
 */
export class StorageNotFoundError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`not found: ${path}`);
    this.name = 'StorageNotFoundError';
    this.path = path;
  }
}

export function isStorageNotFound(e: unknown): e is StorageNotFoundError {
  return e instanceof StorageNotFoundError;
}

export interface StorageQuota {
  /** Bytes used by Basher's storage in this origin. */
  usage: number;
  /** Total bytes available before the browser/host enforces eviction. */
  quota: number;
}

export interface StorageCapability {
  readonly id: string;
  /** Human-readable backend name (for diagnostics). */
  readonly kind: 'opfs' | 'indexeddb' | 'tauri-fs' | 'memory';

  /** True iff this backend can run in the current environment. */
  isAvailable(): Promise<boolean>;

  /** Persist the bytes; throws on write failure. K5 step 3. */
  write(path: string, bytes: Uint8Array): Promise<void>;

  /** Read bytes for a path; throws `StorageNotFoundError` if absent, anything else if unreadable. */
  read(path: string): Promise<Uint8Array>;

  /** True iff a file exists at the path. */
  exists(path: string): Promise<boolean>;

  /** Delete the file at path. No-op if absent. */
  delete(path: string): Promise<void>;

  /** Children at the directory (paths relative to root); a missing directory has none. */
  list(dirPath: string): Promise<string[]>;

  /** Returns current usage/quota where the backend exposes it. */
  quota(): Promise<StorageQuota | null>;
}
