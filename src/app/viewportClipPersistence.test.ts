// #192 — per-project viewport clip override persistence + the pure normalizer.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

// happy-dom's localStorage is non-functional in this vitest config — install a
// plain in-memory implementation BEFORE importing the module (mirrors
// editorViewPersistence.test.ts / chromeStore.test.ts).
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

import { loadViewportClip, saveViewportClip } from './viewportClipPersistence';
import { normalizeViewportClip } from './stores/viewportStore';

beforeEach(() => {
  localStorage.clear();
});

describe('normalizeViewportClip', () => {
  it('passes a valid frustum through unchanged', () => {
    expect(normalizeViewportClip({ near: 0.5, far: 200 })).toEqual({ near: 0.5, far: 200 });
  });

  it('returns null for AUTO (null/undefined input)', () => {
    expect(normalizeViewportClip(null)).toBeNull();
    expect(normalizeViewportClip(undefined)).toBeNull();
  });

  it('rejects a non-positive near (would be an invalid frustum)', () => {
    expect(normalizeViewportClip({ near: 0, far: 100 })).toBeNull();
    expect(normalizeViewportClip({ near: -1, far: 100 })).toBeNull();
  });

  it('rejects far <= near (degenerate / inverted range)', () => {
    expect(normalizeViewportClip({ near: 10, far: 10 })).toBeNull();
    expect(normalizeViewportClip({ near: 10, far: 2 })).toBeNull();
  });

  it('rejects non-finite values', () => {
    expect(normalizeViewportClip({ near: Number.NaN, far: 100 })).toBeNull();
    expect(normalizeViewportClip({ near: 1, far: Number.POSITIVE_INFINITY })).toBeNull();
  });
});

describe('viewportClipPersistence', () => {
  it('round-trips a saved override per project id', () => {
    saveViewportClip('proj_a', { near: 0.2, far: 500 });
    expect(loadViewportClip('proj_a')).toEqual({ near: 0.2, far: 500 });
  });

  it('keeps overrides isolated per project', () => {
    saveViewportClip('proj_a', { near: 0.2, far: 500 });
    saveViewportClip('proj_b', { near: 1, far: 50 });
    expect(loadViewportClip('proj_a')).toEqual({ near: 0.2, far: 500 });
    expect(loadViewportClip('proj_b')).toEqual({ near: 1, far: 50 });
  });

  it('saving null CLEARS the entry (back to AUTO)', () => {
    saveViewportClip('proj_a', { near: 0.2, far: 500 });
    saveViewportClip('proj_a', null);
    expect(loadViewportClip('proj_a')).toBeNull();
  });

  it('saving an invalid clip clears the entry rather than storing garbage', () => {
    saveViewportClip('proj_a', { near: 0.2, far: 500 });
    saveViewportClip('proj_a', { near: 5, far: 1 }); // inverted → clear
    expect(loadViewportClip('proj_a')).toBeNull();
  });

  it('returns null for a missing id or absent entry', () => {
    expect(loadViewportClip(null)).toBeNull();
    expect(loadViewportClip('never-saved')).toBeNull();
  });

  it('treats a corrupt stored value as AUTO', () => {
    localStorage.setItem('basher.viewportClip.proj_a', '{not json');
    expect(loadViewportClip('proj_a')).toBeNull();
  });

  it('degrades a degenerate stored pair to AUTO (normalizer guards load)', () => {
    localStorage.setItem('basher.viewportClip.proj_a', JSON.stringify({ near: -5, far: 10 }));
    expect(loadViewportClip('proj_a')).toBeNull();
  });
});
