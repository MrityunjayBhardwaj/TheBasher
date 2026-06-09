// editorViewPersistence — per-project editor orbit view in localStorage (#165 E).

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

// happy-dom's localStorage is non-functional in this vitest config — install a
// plain in-memory implementation BEFORE importing the module (mirrors
// chromeStore.test.ts).
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

import { loadEditorView, saveEditorView } from './editorViewPersistence';

beforeEach(() => {
  localStorage.clear();
});

describe('editorViewPersistence', () => {
  it('round-trips a saved view for a project', () => {
    saveEditorView('proj-a', { position: [1, 2, 3], target: [0, 1, 0] });
    expect(loadEditorView('proj-a')).toEqual({ position: [1, 2, 3], target: [0, 1, 0] });
  });

  it('keys views per project (no cross-talk)', () => {
    saveEditorView('proj-a', { position: [1, 1, 1], target: [0, 0, 0] });
    saveEditorView('proj-b', { position: [9, 9, 9], target: [2, 2, 2] });
    expect(loadEditorView('proj-a')?.position).toEqual([1, 1, 1]);
    expect(loadEditorView('proj-b')?.position).toEqual([9, 9, 9]);
  });

  it('returns null when nothing is saved', () => {
    expect(loadEditorView('never-saved')).toBeNull();
  });

  it('returns null for a missing/empty project id (save is a no-op)', () => {
    saveEditorView(null, { position: [1, 2, 3], target: [0, 0, 0] });
    saveEditorView(undefined, { position: [1, 2, 3], target: [0, 0, 0] });
    expect(loadEditorView(null)).toBeNull();
    expect(loadEditorView(undefined)).toBeNull();
  });

  it('returns null for a corrupt entry', () => {
    localStorage.setItem('basher.editorView.proj-c', '{not json');
    expect(loadEditorView('proj-c')).toBeNull();
  });

  it('returns null for a malformed (wrong-shape) entry', () => {
    localStorage.setItem(
      'basher.editorView.proj-d',
      JSON.stringify({ position: [1, 2], target: 'x' }),
    );
    expect(loadEditorView('proj-d')).toBeNull();
  });

  it('rejects a save with non-finite components', () => {
    saveEditorView('proj-e', { position: [Number.NaN, 0, 0], target: [0, 0, 0] });
    expect(loadEditorView('proj-e')).toBeNull();
  });
});
