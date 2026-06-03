import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndexedDbStorage } from './IndexedDbStorage';
import { MemoryStorage } from './MemoryStorage';
import { OpfsStorage } from './OpfsStorage';
import { TauriStorage } from './TauriStorage';
import { pickStorage } from './index';

describe('MemoryStorage', () => {
  it('round-trips bytes', async () => {
    const s = new MemoryStorage();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await s.write('a/b/c.bin', bytes);
    const read = await s.read('a/b/c.bin');
    expect(Array.from(read)).toEqual([1, 2, 3, 4, 5]);
  });

  it('exists is false before write, true after, false after delete', async () => {
    const s = new MemoryStorage();
    expect(await s.exists('x.txt')).toBe(false);
    await s.write('x.txt', new Uint8Array([0]));
    expect(await s.exists('x.txt')).toBe(true);
    await s.delete('x.txt');
    expect(await s.exists('x.txt')).toBe(false);
  });

  it('list returns immediate children only', async () => {
    const s = new MemoryStorage();
    await s.write('projects/a/project.json', new Uint8Array([1]));
    await s.write('projects/b/project.json', new Uint8Array([2]));
    await s.write('projects/c/extra/inner.txt', new Uint8Array([3]));
    const top = await s.list('projects');
    expect(top.sort()).toEqual(['a', 'b', 'c']);
  });

  it('delete is idempotent', async () => {
    const s = new MemoryStorage();
    await s.delete('missing.txt'); // no throw
    expect(await s.exists('missing.txt')).toBe(false);
  });
});

// IndexedDB tests run only when the test environment provides an IDB
// shim (happy-dom does not as of v15 — but a real browser does). The
// E2E suite exercises the real path; the unit suite proves at least
// that the feature-detect doesn't crash and falls back gracefully.
describe('IndexedDbStorage (feature-detect)', () => {
  it('isAvailable returns false in environments without IndexedDB', async () => {
    const hasIDB = typeof (globalThis as { indexedDB?: unknown }).indexedDB !== 'undefined';
    if (hasIDB) return; // skip — real path is exercised in E2E
    expect(await new IndexedDbStorage('basher-test').isAvailable()).toBe(false);
  });
});

// #146: the OPFS probe must test the CAPABILITY (does getDirectory() run?),
// not the PRESENCE (does the symbol exist?). `navigator.storage.getDirectory`
// exists in contexts where calling it rejects with a SecurityError (opaque
// origins, sandboxed iframes, blocked site-data, some private modes); a
// presence-only check selected OPFS and killed boot before the fallback chain.
describe('OpfsStorage.isAvailable (capability probe, not presence) — #146', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubStorage = (storage: unknown) => {
    vi.stubGlobal('navigator', { storage } as unknown as Navigator);
  };

  it('returns false when getDirectory() REJECTS (SecurityError context)', async () => {
    stubStorage({
      getDirectory: () => Promise.reject(new DOMException('denied', 'SecurityError')),
    });
    expect(await new OpfsStorage().isAvailable()).toBe(false);
  });

  it('returns false when getDirectory() throws synchronously', async () => {
    stubStorage({
      getDirectory: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    expect(await new OpfsStorage().isAvailable()).toBe(false);
  });

  it('returns false when getDirectory is absent', async () => {
    stubStorage({});
    expect(await new OpfsStorage().isAvailable()).toBe(false);
  });

  it('returns true when getDirectory() RESOLVES', async () => {
    stubStorage({
      getDirectory: () => Promise.resolve({} as FileSystemDirectoryHandle),
    });
    expect(await new OpfsStorage().isAvailable()).toBe(true);
  });

  it('pickStorage does NOT select OPFS when getDirectory() rejects — fallback chain engages', async () => {
    stubStorage({
      getDirectory: () => Promise.reject(new DOMException('denied', 'SecurityError')),
    });
    const picked = await pickStorage();
    // The bug: pickStorage returned OpfsStorage anyway and boot died on first
    // use. The fix: OPFS reports unavailable → IndexedDB (or Memory) serves.
    expect(picked.kind).not.toBe('opfs');
  });
});

describe('TauriStorage', () => {
  it('reports unavailable in v0.5', async () => {
    expect(await new TauriStorage().isAvailable()).toBe(false);
  });

  it('throws "v0.6" on every method', async () => {
    const s = new TauriStorage();
    await expect(s.read('x')).rejects.toThrow(/v0\.6/);
    await expect(s.write('x', new Uint8Array())).rejects.toThrow(/v0\.6/);
    await expect(s.exists('x')).rejects.toThrow(/v0\.6/);
    await expect(s.delete('x')).rejects.toThrow(/v0\.6/);
    await expect(s.list('x')).rejects.toThrow(/v0\.6/);
    await expect(s.quota()).rejects.toThrow(/v0\.6/);
  });
});
