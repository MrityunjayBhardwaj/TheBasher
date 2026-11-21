// Tests for splitViewStore (#1709) — K11 persistence + V18 safeGet/Set, the timelineDockStore
// shape: an in-memory Storage installed BEFORE the store import; resetModules + dynamic import
// for the re-hydrate paths.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: (i: number) => Array.from(mem.keys())[i] ?? null,
      get length() {
        return mem.size;
      },
    },
  });
});

const KEY = 'basher.splitView.v1';

async function freshStore() {
  vi.resetModules();
  return (await import('./splitViewStore')).useSplitViewStore;
}

afterEach(() => mem.clear());

describe('splitViewStore', () => {
  it('defaults: UV opens split, Render and Generated do not; even share, expanded, 3D on the right', async () => {
    const s = (await freshStore()).getState();
    expect(s.split).toEqual({ uv: true, render: false, generated: false });
    expect(s.twoDShare).toBe(0.5);
    expect(s.collapsed).toBe(false);
    expect(s.swapped).toBe(false);
  });

  it('persists every change under one key and re-hydrates it', async () => {
    const store = await freshStore();
    store.getState().setSplit('render', true);
    store.getState().setTwoDShare(0.33);
    store.getState().setCollapsed(true);
    store.getState().toggleSwapped();
    expect(JSON.parse(mem.get(KEY)!)).toEqual({
      split: { uv: true, render: true, generated: false },
      twoDShare: 0.33,
      collapsed: true,
      swapped: true,
      outlinerFoldedBySplit: false,
    });
    const again = (await freshStore()).getState();
    expect(again.split).toEqual({ uv: true, render: true, generated: false });
    expect(again.twoDShare).toBe(0.33);
    expect(again.collapsed).toBe(true);
    expect(again.swapped).toBe(true);
  });

  it('clamps the share so neither side can be dragged to nothing', async () => {
    const store = await freshStore();
    store.getState().setTwoDShare(0.01);
    expect(store.getState().twoDShare).toBe(0.2);
    store.getState().setTwoDShare(5);
    expect(store.getState().twoDShare).toBe(0.8);
    store.getState().setTwoDShare(Number.NaN);
    expect(store.getState().twoDShare).toBe(0.8);
  });

  it('coerces a malformed record field by field instead of dropping it whole', async () => {
    mem.set(KEY, JSON.stringify({ split: { uv: 'yes', render: true }, twoDShare: 9, swapped: 1 }));
    const s = (await freshStore()).getState();
    expect(s.split).toEqual({ uv: true, render: true, generated: false });
    expect(s.twoDShare).toBe(0.8);
    expect(s.collapsed).toBe(false);
    expect(s.swapped).toBe(false);
    expect(s.outlinerFoldedBySplit).toBe(false);
    mem.set(KEY, JSON.stringify({ outlinerFoldedBySplit: true }));
    expect((await freshStore()).getState().outlinerFoldedBySplit).toBe(true);
    mem.set(KEY, JSON.stringify({ outlinerFoldedBySplit: 'yes' }));
    expect((await freshStore()).getState().outlinerFoldedBySplit).toBe(false);
    mem.set(KEY, '{not json');
    expect((await freshStore()).getState().split).toEqual({
      uv: true,
      render: false,
      generated: false,
    });
  });
});
