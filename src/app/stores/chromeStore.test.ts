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
import { chromeStateFromSaved, useChromeStore } from './chromeStore';

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
      showFpsMeter: false,
    });
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('isolation reset state matches the documented test fixture', () => {
    // The beforeEach hook above resets every flag to false so individual
    // toggle tests start from a clean slate. The first-visit boot defaults
    // (leftSidebarCollapsed defaults FALSE — always-on outliner, Spline
    // redesign Wave B) are exercised in a dedicated test below; this one
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
    // #1952 — the panels were not set, so they are not saved (they keep reading as the default).
    expect(persisted).not.toHaveProperty('leftSidebarCollapsed');
    expect(persisted).not.toHaveProperty('inspectorCollapsed');
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
    expect(persisted).not.toHaveProperty('leftSidebarCollapsed');
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

  it('first-visit boot defaults: toolRail expanded, outliner and inspector as RAILS (#1952)', async () => {
    // Re-import the module with empty localStorage so zustand's create() re-runs against a fresh
    // default. #1952: the decided editor design opens on the picture, so the outliner and the
    // inspector start folded to their rails (reverses Spline redesign Wave B's always-on outliner).
    localStorage.clear();
    vi.resetModules();
    const mod = await import('./chromeStore');
    const fresh = mod.useChromeStore.getState();
    expect(fresh.toolRailCollapsed).toBe(false);
    expect(fresh.leftSidebarCollapsed).toBe(true);
    expect(fresh.inspectorCollapsed).toBe(true);
    // The dev FPS overlay boots OFF — a clean editor canvas is the default.
    expect(fresh.showFpsMeter).toBe(false);
  });

  it("a director's own choice is remembered and wins on the next start (#1952)", async () => {
    localStorage.clear();
    vi.resetModules();
    let mod = await import('./chromeStore');
    mod.useChromeStore.getState().toggleLeftSidebar();
    expect(mod.useChromeStore.getState().leftSidebarCollapsed).toBe(false);
    vi.resetModules();
    mod = await import('./chromeStore');
    expect(mod.useChromeStore.getState().leftSidebarCollapsed).toBe(false);
    // The inspector was never touched: still the first-start rail.
    expect(mod.useChromeStore.getState().inspectorCollapsed).toBe(true);
  });

  it('setting one field never records the others as choices (#1952)', () => {
    // A fresh store whose panels sit at their default rails.
    useChromeStore.setState({ leftSidebarCollapsed: true, inspectorCollapsed: true });
    useChromeStore.getState().toggleShowFpsMeter();
    useChromeStore.getState().setToolRailCollapsed(true);
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<
      string,
      boolean
    >;
    expect(persisted).toEqual({ showFpsMeter: true, toolRailCollapsed: true });
  });

  describe('chromeStateFromSaved', () => {
    it('nothing saved, unreadable or not an object: the first-start rails', () => {
      for (const raw of [null, '', '{not json', '42', 'null', '[]']) {
        const s = chromeStateFromSaved(raw);
        expect(s.leftSidebarCollapsed, String(raw)).toBe(true);
        expect(s.inspectorCollapsed, String(raw)).toBe(true);
        expect(s.toolRailCollapsed, String(raw)).toBe(false);
      }
    });
    it('a saved boolean wins; a missing or malformed field falls back to the default', () => {
      const s = chromeStateFromSaved(
        JSON.stringify({ leftSidebarCollapsed: false, inspectorCollapsed: 'no' }),
      );
      expect(s.leftSidebarCollapsed).toBe(false);
      expect(s.inspectorCollapsed).toBe(true);
      expect(
        chromeStateFromSaved(JSON.stringify({ inspectorCollapsed: false })).inspectorCollapsed,
      ).toBe(false);
    });
    it('present mode and the narrow drawers always boot closed', () => {
      const s = chromeStateFromSaved(
        JSON.stringify({
          presentMode: true,
          narrowLeftDrawerOpen: true,
          narrowRightDrawerOpen: true,
        }),
      );
      expect(s.presentMode).toBe(false);
      expect(s.narrowLeftDrawerOpen).toBe(false);
      expect(s.narrowRightDrawerOpen).toBe(false);
    });
  });

  it('toggleShowFpsMeter flips and persists the dev FPS overlay flag', () => {
    expect(useChromeStore.getState().showFpsMeter).toBe(false);
    useChromeStore.getState().toggleShowFpsMeter();
    expect(useChromeStore.getState().showFpsMeter).toBe(true);
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<
      string,
      boolean
    >;
    // Unlike presentMode, this dev preference DOES persist (survives reload).
    expect(persisted.showFpsMeter).toBe(true);
    // The collapse flags are not recorded by an FPS toggle (#1952: only what was set is saved).
    expect(persisted).not.toHaveProperty('toolRailCollapsed');
    useChromeStore.getState().toggleShowFpsMeter();
    expect(useChromeStore.getState().showFpsMeter).toBe(false);
  });
});
