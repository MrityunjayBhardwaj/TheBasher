export type { StorageCapability, StorageQuota } from './StorageCapability';
export { OpfsStorage } from './OpfsStorage';
export { TauriStorage } from './TauriStorage';
export { MemoryStorage } from './MemoryStorage';

import { OpfsStorage } from './OpfsStorage';
import { MemoryStorage } from './MemoryStorage';
import type { StorageCapability } from './StorageCapability';

/**
 * Pick the best available storage for the current runtime. v0.5 only:
 * OPFS in the browser, Memory elsewhere (e.g. tests, SSR). Tauri arrives
 * in v0.6.
 */
export async function pickStorage(): Promise<StorageCapability> {
  const opfs = new OpfsStorage();
  if (await opfs.isAvailable()) return opfs;
  return new MemoryStorage();
}
