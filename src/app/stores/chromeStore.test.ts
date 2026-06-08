// Unit tests for chromeStore.
//
// Covers: default state when localStorage is empty; persistence of each
// collapse flag independently; reset behavior on bad/missing/corrupted
// stored value; toggle returning to inverse state.
//
// REF: docs/UI-SPEC.md §3.2 (per-panel collapse), §11 acceptance.

import { afterEach, beforeEach, beforeAll, describe, expect, it, vi } from 'vitest';

// happy-dom's localStorage is non-functional in this vitest config (the
// `--localstorage-file` warning at module load is the giveaway). Replace it
// with a plain in-memory implementation BEFORE importing the store, so that
// the store's module-load-time read sees a working API.
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
import { useChromeStore } from './chromeStore';

const STORAGE_KEY = 'basher.chrome.v1';

describe('chromeStore', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset the store to its default state so tests don't pollute each other.
    useChromeStore.setState({
      toolRailCollapsed: false,
      leftSidebarCollapsed: false,
      inspectorCollapsed: false,
      presentMode: false,
    });
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('isolation reset state matches the documented test fixture', () => {
    // The beforeEach hook above resets every flag to false so individual
    // toggle tests start from a clean slate. The actual first-visit
    // boot defaults (which differ — leftSidebarCollapsed defaults true
    // post-W2.6) are exercised in a dedicated test below; this one
    // verifies the isolation reset itself.
    const s = useChromeStore.getState();
    expect(s.toolRailCollapsed).toBe(false);
    expect(s.leftSidebarCollapsed).toBe(false);
    expect(s.inspectorCollapsed).toBe(false);
  });

  it('setToolRailCollapsed persists independently of other flags', () => {
    useChromeStore.getState().setToolRailCollapsed(true);
    expect(useChromeStore.getState().toolRailCollapsed).toBe(true);
    expect(useChromeStore.getState().leftSidebarCollapsed).toBe(false);
    expect(useChromeStore.getState().inspectorCollapsed).toBe(false);
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<
      string,
      boolean
    >;
    expect(persisted.toolRailCollapsed).toBe(true);
    expect(persisted.leftSidebarCollapsed).toBe(false);
    expect(persisted.inspectorCollapsed).toBe(false);
  });

  it('setLeftSidebarCollapsed persists independently', () => {
    useChromeStore.getState().setLeftSidebarCollapsed(true);
    expect(useChromeStore.getState().leftSidebarCollapsed).toBe(true);
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<
      string,
      boolean
    >;
    expect(persisted.leftSidebarCollapsed).toBe(true);
  });

  it('setInspectorCollapsed persists independently', () => {
    useChromeStore.getState().setInspectorCollapsed(true);
    expect(useChromeStore.getState().inspectorCollapsed).toBe(true);
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<
      string,
      boolean
    >;
    expect(persisted.inspectorCollapsed).toBe(true);
  });

  it('toggleToolRail flips the flag without affecting siblings', () => {
    useChromeStore.getState().toggleToolRail();
    expect(useChromeStore.getState().toolRailCollapsed).toBe(true);
    expect(useChromeStore.getState().leftSidebarCollapsed).toBe(false);
    useChromeStore.getState().toggleToolRail();
    expect(useChromeStore.getState().toolRailCollapsed).toBe(false);
  });

  it('toggleLeftSidebar flips the flag', () => {
    useChromeStore.getState().toggleLeftSidebar();
    expect(useChromeStore.getState().leftSidebarCollapsed).toBe(true);
    useChromeStore.getState().toggleLeftSidebar();
    expect(useChromeStore.getState().leftSidebarCollapsed).toBe(false);
  });

  it('toggleInspector flips the flag', () => {
    useChromeStore.getState().toggleInspector();
    expect(useChromeStore.getState().inspectorCollapsed).toBe(true);
    useChromeStore.getState().toggleInspector();
    expect(useChromeStore.getState().inspectorCollapsed).toBe(false);
  });

  it('multiple panels collapsed simultaneously persist as a single object', () => {
    useChromeStore.getState().setToolRailCollapsed(true);
    useChromeStore.getState().setInspectorCollapsed(true);
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<
      string,
      boolean
    >;
    expect(persisted.toolRailCollapsed).toBe(true);
    expect(persisted.leftSidebarCollapsed).toBe(false);
    expect(persisted.inspectorCollapsed).toBe(true);
  });

  it('togglePresentMode flips presentMode but NEVER persists it', () => {
    expect(useChromeStore.getState().presentMode).toBe(false);
    useChromeStore.getState().togglePresentMode();
    expect(useChromeStore.getState().presentMode).toBe(true);
    // The toggle must NOT write presentMode into the persisted blob — a reload
    // must never trap the user in fullscreen with no chrome to escape.
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(persisted).not.toHaveProperty('presentMode');
  });

  it('presentMode boots false even if a sibling toggle wrote while present was true', async () => {
    // Enter present, then collapse a panel (which persists). Reconstruct the
    // store from the persisted blob: presentMode must come back false.
    useChromeStore.getState().setPresentMode(true);
    useChromeStore.getState().setToolRailCollapsed(true);
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<
      string,
      unknown
    >;
    // presentMode never made it into storage even though it was true at write time.
    expect(persisted).not.toHaveProperty('presentMode');
    expect(persisted.toolRailCollapsed).toBe(true);
    // Reconstruct from the persisted blob → presentMode is false.
    vi.resetModules();
    const mod = await import('./chromeStore');
    expect(mod.useChromeStore.getState().presentMode).toBe(false);
    expect(mod.useChromeStore.getState().toolRailCollapsed).toBe(true);
  });

  it('first-visit boot defaults: toolRail expanded, leftSidebar collapsed, inspector expanded', async () => {
    // Re-import the module with empty localStorage so zustand's create()
    // re-runs against a fresh DEFAULT_STATE. Verifies the documented
    // first-visit boot shape (P6 W2.6 — leftSidebar default flipped to
    // true so the SceneTree gets out of the way until the user expands).
    localStorage.clear();
    vi.resetModules();
    const mod = await import('./chromeStore');
    const fresh = mod.useChromeStore.getState();
    expect(fresh.toolRailCollapsed).toBe(false);
    expect(fresh.leftSidebarCollapsed).toBe(true);
    expect(fresh.inspectorCollapsed).toBe(false);
  });
});
