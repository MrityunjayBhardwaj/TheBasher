// #262 — seedAssetsIntoStorage must RE-SEED a 0-byte entry (a prior seed
// interrupted mid-write, e.g. OPFS cleared) rather than skip it on `exists`
// alone. An `exists`-only skip strands the empty file forever while the Library
// still marks it available → every import reads empty bytes → "not valid JSON".

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import { seedAssetsIntoStorage } from './seedOpfs';
import { ASSET_CATALOG } from './catalog';

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

/** Stub global.fetch to return `content` (200 OK) for every seed URL. */
function mockFetchAll(content: Uint8Array): void {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => content.buffer,
  })) as unknown as typeof fetch;
}

describe('seedAssetsIntoStorage', () => {
  it('re-seeds a 0-byte entry (interrupted prior seed) instead of skipping it', async () => {
    const storage = new MemoryStorage();
    const entry = ASSET_CATALOG[0];
    // Simulate an interrupted seed: the entry EXISTS but is empty.
    await storage.write(entry.path, new Uint8Array(0));
    expect(await storage.exists(entry.path)).toBe(true);

    const content = new Uint8Array([1, 2, 3, 4]);
    mockFetchAll(content);

    const written = await seedAssetsIntoStorage(storage);

    expect(written).toContain(entry.path); // it re-fetched the empty entry
    expect((await storage.read(entry.path)).byteLength).toBe(4); // now non-empty
  });

  it('skips entries that already have content (no redundant re-fetch)', async () => {
    const storage = new MemoryStorage();
    for (const e of ASSET_CATALOG) await storage.write(e.path, new Uint8Array([9, 9, 9]));
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const written = await seedAssetsIntoStorage(storage);

    expect(written).toEqual([]); // nothing re-written
    expect(fetchSpy).not.toHaveBeenCalled(); // no network for already-seeded content
  });
});
