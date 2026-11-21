// Tests for timelineDockStore — K11 8-step persistence + V18 safeGet/Set.
// Mirrors the inspectorSectionsStore test shape (in-memory Storage mock
// installed in beforeAll BEFORE the store import; vi.resetModules() +
// dynamic import for re-init paths).

import { afterEach, beforeEach, beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, String(v));
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => {
        store.clear();
      },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
});

import {
  DEFAULT_DRAWER_HEIGHT_PX,
  drawerHeightFor,
  MAX_DRAWER_HEIGHT_PX,
  MIN_DRAWER_HEIGHT_PX,
  useTimelineDockStore,
} from './timelineDockStore';

const STORAGE_KEY = 'basher.timelineDock.v1';

describe('timelineDockStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useTimelineDockStore.setState({ activeTab: 'dopesheet', heights: {} });
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('defaults to dopesheet tab when no persisted value', () => {
    expect(useTimelineDockStore.getState().activeTab).toBe('dopesheet');
  });

  it('setActiveTab updates state and persists to localStorage', () => {
    useTimelineDockStore.getState().setActiveTab('curve');
    expect(useTimelineDockStore.getState().activeTab).toBe('curve');
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string)).toEqual({ activeTab: 'curve', heights: {} });
  });

  it('persistence round-trip: setActiveTab → reload → state restored', async () => {
    useTimelineDockStore.getState().setActiveTab('curve');
    vi.resetModules();
    const mod = await import('./timelineDockStore');
    expect(mod.useTimelineDockStore.getState().activeTab).toBe('curve');
  });

  it("#1956 — the 'animLayers' tab is a tab: it is kept, persisted and survives re-init", async () => {
    useTimelineDockStore.getState().setActiveTab('animLayers');
    expect(useTimelineDockStore.getState().activeTab).toBe('animLayers');
    vi.resetModules();
    const mod = await import('./timelineDockStore');
    expect(mod.useTimelineDockStore.getState().activeTab).toBe('animLayers');
  });

  it("persistence round-trip for the 'nla' tab (#283 Phase 5) — survives re-init", async () => {
    useTimelineDockStore.getState().setActiveTab('nla');
    expect(useTimelineDockStore.getState().activeTab).toBe('nla');
    vi.resetModules();
    const mod = await import('./timelineDockStore');
    expect(mod.useTimelineDockStore.getState().activeTab).toBe('nla');
  });

  it('K11 step 4 — malformed activeTab value coerces back to default', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ activeTab: 'unknown' }));
    vi.resetModules();
    const mod = await import('./timelineDockStore');
    expect(mod.useTimelineDockStore.getState().activeTab).toBe('dopesheet');
  });

  it('corrupt JSON falls back to default without throwing', async () => {
    localStorage.setItem(STORAGE_KEY, '<<<not json>>>');
    vi.resetModules();
    const mod = await import('./timelineDockStore');
    expect(mod.useTimelineDockStore.getState().activeTab).toBe('dopesheet');
  });

  it('setActiveTab silently ignores invalid tab strings (V18 safety)', () => {
    useTimelineDockStore.getState().setActiveTab('curve');
    (useTimelineDockStore.getState().setActiveTab as (t: string) => void)('garbage');
    expect(useTimelineDockStore.getState().activeTab).toBe('curve');
  });

  // #1703 — per-tab drawer heights.
  it('a tab never resized opens at its default height', () => {
    expect(drawerHeightFor(useTimelineDockStore.getState().heights, 'curve')).toBe(
      DEFAULT_DRAWER_HEIGHT_PX,
    );
  });

  it('setTabHeight remembers one tab without touching another, and persists', () => {
    useTimelineDockStore.getState().setTabHeight('dopesheet', 333);
    const { heights } = useTimelineDockStore.getState();
    expect(drawerHeightFor(heights, 'dopesheet')).toBe(333);
    expect(drawerHeightFor(heights, 'curve')).toBe(DEFAULT_DRAWER_HEIGHT_PX);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) as string)).toEqual({
      activeTab: 'dopesheet',
      heights: { dopesheet: 333 },
    });
  });

  it('setTabHeight clamps to the absolute range and ignores non-finite values', () => {
    useTimelineDockStore.getState().setTabHeight('nla', 5);
    expect(useTimelineDockStore.getState().heights.nla).toBe(MIN_DRAWER_HEIGHT_PX);
    useTimelineDockStore.getState().setTabHeight('nla', 1e9);
    expect(useTimelineDockStore.getState().heights.nla).toBe(MAX_DRAWER_HEIGHT_PX);
    useTimelineDockStore.getState().setTabHeight('nla', Number.NaN);
    expect(useTimelineDockStore.getState().heights.nla).toBe(MAX_DRAWER_HEIGHT_PX);
  });

  it('heights survive a reload; a legacy record without heights reads as none', async () => {
    useTimelineDockStore.getState().setTabHeight('curve', 300);
    vi.resetModules();
    let mod = await import('./timelineDockStore');
    expect(mod.useTimelineDockStore.getState().heights).toEqual({ curve: 300 });

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ activeTab: 'nla' }));
    vi.resetModules();
    mod = await import('./timelineDockStore');
    expect(mod.useTimelineDockStore.getState().activeTab).toBe('nla');
    expect(mod.useTimelineDockStore.getState().heights).toEqual({});
  });

  it('unknown tabs, non-numbers and out-of-range heights are coerced on read', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        activeTab: 'garbage',
        heights: { dopesheet: 'tall', retiredTab: 400, curve: -50, nla: 280 },
      }),
    );
    vi.resetModules();
    const mod = await import('./timelineDockStore');
    expect(mod.useTimelineDockStore.getState().activeTab).toBe('dopesheet');
    expect(mod.useTimelineDockStore.getState().heights).toEqual({
      curve: MIN_DRAWER_HEIGHT_PX,
      nla: 280,
    });
  });

  it('#1703 — a remembered Light Studio tab (moved to the right panel) falls back to the default', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ activeTab: 'lightStudio', heights: { lightStudio: 300, nla: 260 } }),
    );
    vi.resetModules();
    const mod = await import('./timelineDockStore');
    expect(mod.useTimelineDockStore.getState().activeTab).toBe('dopesheet');
    expect(mod.useTimelineDockStore.getState().heights).toEqual({ nla: 260 });
  });
});
