// Unit tests for inspectorSectionsStore (P6 W4 C3).
//
// V18 + H26 mitigation: in-memory Storage mock installed in beforeAll
// BEFORE the store import.

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

import { resolveCollapsed, useInspectorSectionsStore } from './inspectorSectionsStore';

const STORAGE_KEY = 'basher.inspectorSections.v1';

describe('inspectorSectionsStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useInspectorSectionsStore.setState({ collapsedByNodeType: {} });
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('starts with empty collapsedByNodeType', () => {
    expect(useInspectorSectionsStore.getState().collapsedByNodeType).toEqual({});
  });

  it('setCollapsed persists per (nodeType, sectionId)', () => {
    useInspectorSectionsStore.getState().setCollapsed('BoxMesh', 'material', true);
    expect(useInspectorSectionsStore.getState().collapsedByNodeType.BoxMesh?.material).toBe(true);
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(persisted.collapsedByNodeType.BoxMesh.material).toBe(true);
  });

  it('setCollapsed for a different node type is isolated', () => {
    useInspectorSectionsStore.getState().setCollapsed('BoxMesh', 'material', true);
    useInspectorSectionsStore.getState().setCollapsed('SphereMesh', 'transform', true);
    const s = useInspectorSectionsStore.getState().collapsedByNodeType;
    expect(s.BoxMesh).toEqual({ material: true });
    expect(s.SphereMesh).toEqual({ transform: true });
  });

  it('toggleCollapsed flips from undefined → true → false → true', () => {
    const store = useInspectorSectionsStore.getState();
    expect(store.getUserCollapsed('BoxMesh', 'transform')).toBeUndefined();
    store.toggleCollapsed('BoxMesh', 'transform');
    expect(useInspectorSectionsStore.getState().getUserCollapsed('BoxMesh', 'transform')).toBe(
      true,
    );
    useInspectorSectionsStore.getState().toggleCollapsed('BoxMesh', 'transform');
    expect(useInspectorSectionsStore.getState().getUserCollapsed('BoxMesh', 'transform')).toBe(
      false,
    );
    useInspectorSectionsStore.getState().toggleCollapsed('BoxMesh', 'transform');
    expect(useInspectorSectionsStore.getState().getUserCollapsed('BoxMesh', 'transform')).toBe(
      true,
    );
  });

  it('setCollapsed silently ignores invalid section ids', () => {
    (
      useInspectorSectionsStore.getState().setCollapsed as (
        n: string,
        s: string,
        c: boolean,
      ) => void
    )('BoxMesh', 'metadata', true);
    expect(useInspectorSectionsStore.getState().collapsedByNodeType).toEqual({});
  });

  it('persistence round-trip: setCollapsed → reload → state restored', async () => {
    useInspectorSectionsStore.getState().setCollapsed('BoxMesh', 'material', true);
    vi.resetModules();
    const mod = await import('./inspectorSectionsStore');
    expect(mod.useInspectorSectionsStore.getState().collapsedByNodeType.BoxMesh?.material).toBe(
      true,
    );
  });

  it('K11 step 4 — legacy section ids dropped on read', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        collapsedByNodeType: {
          BoxMesh: { material: true, metadata: true, fooBar: false },
        },
      }),
    );
    vi.resetModules();
    const mod = await import('./inspectorSectionsStore');
    const s = mod.useInspectorSectionsStore.getState().collapsedByNodeType;
    expect(s.BoxMesh).toEqual({ material: true });
    expect((s.BoxMesh as Record<string, unknown>).metadata).toBeUndefined();
    expect((s.BoxMesh as Record<string, unknown>).fooBar).toBeUndefined();
  });

  it('corrupt JSON falls back to empty without throwing', async () => {
    localStorage.setItem(STORAGE_KEY, '<<<not json>>>');
    vi.resetModules();
    const mod = await import('./inspectorSectionsStore');
    expect(mod.useInspectorSectionsStore.getState().collapsedByNodeType).toEqual({});
  });

  it('malformed JSON (string body) falls back', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify('not an object'));
    vi.resetModules();
    const mod = await import('./inspectorSectionsStore');
    expect(mod.useInspectorSectionsStore.getState().collapsedByNodeType).toEqual({});
  });
});

describe('resolveCollapsed', () => {
  it('user choice wins when set', () => {
    expect(resolveCollapsed(true, false)).toBe(true);
    expect(resolveCollapsed(false, true)).toBe(false);
  });
  it('falls back to default when user choice is undefined', () => {
    expect(resolveCollapsed(undefined, true)).toBe(true);
    expect(resolveCollapsed(undefined, false)).toBe(false);
  });
});
