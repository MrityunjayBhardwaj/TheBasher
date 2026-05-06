export type { StorageCapability, StorageQuota } from './StorageCapability';
export { OpfsStorage } from './OpfsStorage';
export { IndexedDbStorage } from './IndexedDbStorage';
export { TauriStorage } from './TauriStorage';
export { MemoryStorage } from './MemoryStorage';

import { IndexedDbStorage } from './IndexedDbStorage';
import { MemoryStorage } from './MemoryStorage';
import { OpfsStorage } from './OpfsStorage';
import type { StorageCapability } from './StorageCapability';

/**
 * Pick the best available storage for the current runtime.
 *
 *   OPFS  (preferred — filesystem-shaped, large quotas, sync access in workers)
 *   →  IndexedDB  (universal browser fallback — covers private-browsing modes
 *      and older Chromium where OPFS isn't available)
 *   →  Memory  (tests / SSR / catastrophic environments)
 *
 * Tauri arrives in v0.6.
 */
export async function pickStorage(): Promise<StorageCapability> {
  const opfs = new OpfsStorage();
  if (await opfs.isAvailable()) return opfs;
  const idb = new IndexedDbStorage();
  if (await idb.isAvailable()) return idb;
  return new MemoryStorage();
}
