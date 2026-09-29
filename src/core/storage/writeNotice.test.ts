// writeNotice — the storage `pickStorage` hands out announces each write once it has landed (#1312).
//
// REF: src/core/storage/writeNotice.ts; issue #1312.

import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStorage } from './MemoryStorage';
import type { StorageCapability } from './StorageCapability';
import { onStorageWrite, withWriteNotice } from './writeNotice';

let off: (() => void) | null = null;
afterEach(() => off?.());

/** A memory storage whose `write` records when it finished, or throws when told to. */
function probeStorage(opts: { fail?: boolean } = {}) {
  const inner = new MemoryStorage();
  const landed = new Set<string>();
  const storage: StorageCapability = {
    id: 'probe',
    kind: 'memory',
    isAvailable: () => inner.isAvailable(),
    async write(path, bytes) {
      if (opts.fail) throw new Error('quota exceeded');
      await inner.write(path, bytes);
      landed.add(path);
    },
    read: (p) => inner.read(p),
    exists: (p) => inner.exists(p),
    delete: (p) => inner.delete(p),
    list: (p) => inner.list(p),
    quota: () => inner.quota(),
  };
  return { storage, landed };
}

describe('withWriteNotice', () => {
  it('announces a write after the bytes are there, and is otherwise the same storage', async () => {
    const { storage: inner, landed } = probeStorage();
    const storage = withWriteNotice(inner);
    const seen: { path: string; landed: boolean }[] = [];
    off = onStorageWrite((path) => seen.push({ path, landed: landed.has(path) }));

    await storage.write('a/b.bin', new Uint8Array([1, 2, 3]));

    expect(seen).toEqual([{ path: 'a/b.bin', landed: true }]);
    expect(Array.from(await storage.read('a/b.bin'))).toEqual([1, 2, 3]);
    expect(await storage.exists('a/b.bin')).toBe(true);
    expect([storage.id, storage.kind]).toEqual(['probe', 'memory']);
  });

  it('a write that throws announces nothing', async () => {
    const storage = withWriteNotice(probeStorage({ fail: true }).storage);
    const seen: string[] = [];
    off = onStorageWrite((path) => seen.push(path));

    await expect(storage.write('x.bin', new Uint8Array([1]))).rejects.toThrow('quota exceeded');
    expect(seen).toEqual([]);
  });
});
