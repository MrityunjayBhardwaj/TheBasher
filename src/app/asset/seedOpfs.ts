// Seed the asset catalog into OPFS at first boot. Subsequent boots see the
// files already present and skip the network fetch.
//
// V6 (capability interface): only StorageCapability is touched here, no
// direct OPFS API. The seeder has no opinion about which backend serves
// the writes.
//
// REF: THESIS.md §14, §33; vyapti V6.

import type { StorageCapability } from '../../core/storage';
import { ASSET_CATALOG } from './catalog';

/**
 * Ensure each catalog entry exists in storage. Returns the list of paths
 * that were newly written this run (empty after the first boot).
 */
export async function seedAssetsIntoStorage(storage: StorageCapability): Promise<string[]> {
  const written: string[] = [];
  for (const entry of ASSET_CATALOG) {
    // #262 — skip only when the existing file is NON-EMPTY. A 0-byte entry
    // means a prior seed was interrupted (e.g. OPFS cleared mid-write); an
    // `exists`-only skip would strand that empty file forever while the Library
    // still marks it available, so every import reads empty bytes → "not valid
    // JSON". Treat a 0-byte (or unreadable) entry as unseeded and re-fetch.
    if (await storage.exists(entry.path)) {
      try {
        const existing = await storage.read(entry.path);
        if (existing.byteLength > 0) continue;
      } catch {
        /* unreadable → fall through and re-seed */
      }
    }
    const res = await fetch(entry.seedUrl);
    if (!res.ok) {
      // Skip missing seeds rather than crash boot — Library will simply not
      // list this asset until `npm run seed:assets` runs and a reload occurs.
      console.warn(`seedAssetsIntoStorage: ${entry.seedUrl} → ${res.status}; skipped`);
      continue;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    await storage.write(entry.path, buf);
    written.push(entry.path);
  }
  return written;
}
