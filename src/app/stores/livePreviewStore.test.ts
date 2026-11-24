// livePreviewStore — collapsing the live preview survives a reload; its box is layout, not
// persisted, and an unchanged box is not a store write (#1708).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const KEY = 'basher.livePreview.v1';

// happy-dom's localStorage is non-functional in this vitest config: an in-memory one stands in,
// as chromeStore.test.ts does.
beforeAll(() => {
  const mem = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
    },
  });
});

async function freshStore() {
  vi.resetModules();
  return (await import('./livePreviewStore')).useLivePreviewStore;
}

describe('livePreviewStore', () => {
  afterEach(() => localStorage.removeItem(KEY));

  it('starts expanded, and a collapse is read back by the next load', async () => {
    let store = await freshStore();
    expect(store.getState().collapsed).toBe(false);
    store.getState().toggleCollapsed();
    expect(store.getState().collapsed).toBe(true);
    store = await freshStore();
    expect(store.getState().collapsed).toBe(true);
    store.getState().setCollapsed(false);
    store = await freshStore();
    expect(store.getState().collapsed).toBe(false);
  });

  it('reads a corrupt saved value as expanded', async () => {
    localStorage.setItem(KEY, '{not json');
    expect((await freshStore()).getState().collapsed).toBe(false);
  });

  it('does not persist the box, and an equal box does not notify', async () => {
    const store = await freshStore();
    const seen: unknown[] = [];
    const off = store.subscribe((s) => seen.push(s.rect));
    store.getState().setRect({ x: 1, y: 2, width: 3, height: 4 });
    store.getState().setRect({ x: 1, y: 2, width: 3, height: 4 });
    off();
    expect(seen).toHaveLength(1);
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
