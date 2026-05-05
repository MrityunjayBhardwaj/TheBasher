// Storage capability — the only contract code outside `core/storage/` may
// touch. Two impls: OpfsStorage (browser, v0.5) and TauriStorage (v0.6 stub).
//
// V6 (capability interfaces decouple browser/native impls): no caller imports
// `tauri-*` or `node:fs` directly. Switching backends is a one-line provider
// swap.
//
// REF: THESIS.md §33, vyapti V6, dharana B2.

export interface StorageQuota {
  /** Bytes used by Basher's storage in this origin. */
  usage: number;
  /** Total bytes available before the browser/host enforces eviction. */
  quota: number;
}

export interface StorageCapability {
  readonly id: string;
  /** Human-readable backend name (for diagnostics). */
  readonly kind: 'opfs' | 'tauri-fs' | 'memory';

  /** True iff this backend can run in the current environment. */
  isAvailable(): Promise<boolean>;

  /** Persist the bytes; throws on write failure. K5 step 3. */
  write(path: string, bytes: Uint8Array): Promise<void>;

  /** Read bytes for a path; throws if absent. */
  read(path: string): Promise<Uint8Array>;

  /** True iff a file exists at the path. */
  exists(path: string): Promise<boolean>;

  /** Delete the file at path. No-op if absent. */
  delete(path: string): Promise<void>;

  /** Children at the directory (paths relative to root). */
  list(dirPath: string): Promise<string[]>;

  /** Returns current usage/quota where the backend exposes it. */
  quota(): Promise<StorageQuota | null>;
}
