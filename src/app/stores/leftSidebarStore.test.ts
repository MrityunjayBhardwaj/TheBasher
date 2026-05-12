// Unit tests for leftSidebarStore (P6 W3).
//
// Covers K11 step compliance:
//   - first-visit default = 'scene' (D-01)
//   - persistence round-trip ('scene' ↔ 'agent')
//   - K11 step 4 legacy-coercion: unknown values fall back to default
//   - corrupt JSON fall back without module-load crash
//   - safeSet PERSISTABLE filter blocks malformed writes
//
// V18 compliance + H26 mitigation: replaces happy-dom's non-functional
// localStorage with an in-memory implementation in beforeAll BEFORE
// importing the store, so module-load time sees a callable Storage API.
//
// REF: vyapti V18; krama K11; hetvabhasa H26; UI-SPEC §7.3.

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

// Static import is safe because beforeAll runs before any describe block.
import { useLeftSidebarStore } from './leftSidebarStore';

const STORAGE_KEY = 'basher.leftSidebar.v1';

describe('leftSidebarStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useLeftSidebarStore.setState({ activeTab: 'scene' });
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('isolation reset state matches the documented test fixture', () => {
    expect(useLeftSidebarStore.getState().activeTab).toBe('scene');
  });

  it('setActiveTab persists the new value', () => {
    useLeftSidebarStore.getState().setActiveTab('agent');
    expect(useLeftSidebarStore.getState().activeTab).toBe('agent');
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<
      string,
      string
    >;
    expect(persisted.activeTab).toBe('agent');
  });

  it('setActiveTab round-trip: scene → agent → scene', () => {
    useLeftSidebarStore.getState().setActiveTab('agent');
    useLeftSidebarStore.getState().setActiveTab('scene');
    expect(useLeftSidebarStore.getState().activeTab).toBe('scene');
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<
      string,
      string
    >;
    expect(persisted.activeTab).toBe('scene');
  });

  it('first-visit default = scene (D-01) when localStorage is empty', async () => {
    localStorage.clear();
    vi.resetModules();
    const mod = await import('./leftSidebarStore');
    expect(mod.useLeftSidebarStore.getState().activeTab).toBe('scene');
  });

  it('persistence: stored agent value rehydrates as agent', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ activeTab: 'agent' }));
    vi.resetModules();
    const mod = await import('./leftSidebarStore');
    expect(mod.useLeftSidebarStore.getState().activeTab).toBe('agent');
  });

  it('K11 step 4 — legacy value (e.g. pre-W2.5 "library") coerces to default', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ activeTab: 'library' }));
    vi.resetModules();
    const mod = await import('./leftSidebarStore');
    expect(mod.useLeftSidebarStore.getState().activeTab).toBe('scene');
  });

  it('corrupt JSON falls back to default without throwing', async () => {
    localStorage.setItem(STORAGE_KEY, '<<<not valid json>>>');
    vi.resetModules();
    const mod = await import('./leftSidebarStore');
    expect(mod.useLeftSidebarStore.getState().activeTab).toBe('scene');
  });

  it('non-object JSON (e.g. a plain string) falls back to default', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify('agent'));
    vi.resetModules();
    const mod = await import('./leftSidebarStore');
    // JSON.parse('"agent"') is the string 'agent', not an object with
    // activeTab field. activeTab is undefined → isLeftSidebarTab returns
    // false → falls back to default 'scene'.
    expect(mod.useLeftSidebarStore.getState().activeTab).toBe('scene');
  });

  it('setActiveTab with a non-persistable value is silently rejected', () => {
    useLeftSidebarStore.getState().setActiveTab('agent');
    // TypeScript would normally prevent this — cast simulates a runtime
    // path that bypassed the type system (e.g. a malformed dev-tools call).
    (useLeftSidebarStore.getState().setActiveTab as (t: string) => void)('library');
    // No change: still 'agent'.
    expect(useLeftSidebarStore.getState().activeTab).toBe('agent');
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<
      string,
      string
    >;
    expect(persisted.activeTab).toBe('agent');
  });
});
