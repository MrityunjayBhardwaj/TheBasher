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

import { useTimelineDockStore } from './timelineDockStore';

const STORAGE_KEY = 'basher.timelineDock.v1';

describe('timelineDockStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useTimelineDockStore.setState({ activeTab: 'dopesheet' });
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
    expect(JSON.parse(raw as string)).toEqual({ activeTab: 'curve' });
  });

  it('persistence round-trip: setActiveTab → reload → state restored', async () => {
    useTimelineDockStore.getState().setActiveTab('curve');
    vi.resetModules();
    const mod = await import('./timelineDockStore');
    expect(mod.useTimelineDockStore.getState().activeTab).toBe('curve');
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
});
