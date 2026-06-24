import { describe, expect, it, beforeEach, beforeAll } from 'vitest';

// happy-dom has no localStorage surface — install a Map-backed mock (the same
// pattern as timelineDockStore.test.ts) BEFORE importing the store.
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

import { useSettingsStore } from './settingsStore';
import { DEFAULT_COMFYUI_URL } from '../../core/comfy';

const KEY = 'basher.settings.v1';

describe('settingsStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({
      comfyUrl: DEFAULT_COMFYUI_URL,
      comfyAuthHeader: '',
      isOpen: false,
    });
  });

  it('defaults the ComfyUI URL to DEFAULT_COMFYUI_URL', () => {
    expect(useSettingsStore.getState().comfyUrl).toBe(DEFAULT_COMFYUI_URL);
    expect(useSettingsStore.getState().comfyAuthHeader).toBe('');
  });

  it('setComfyUrl persists the trimmed value to localStorage', () => {
    useSettingsStore.getState().setComfyUrl('  http://my-box:9000  ');
    expect(useSettingsStore.getState().comfyUrl).toBe('http://my-box:9000');
    const persisted = JSON.parse(localStorage.getItem(KEY)!);
    expect(persisted.comfyUrl).toBe('http://my-box:9000');
  });

  it('an empty URL falls back to the default (never persists a blank server)', () => {
    useSettingsStore.getState().setComfyUrl('   ');
    expect(useSettingsStore.getState().comfyUrl).toBe(DEFAULT_COMFYUI_URL);
  });

  it('setComfyAuthHeader persists alongside the URL', () => {
    useSettingsStore.getState().setComfyUrl('http://x:1');
    useSettingsStore.getState().setComfyAuthHeader('Bearer abc');
    const persisted = JSON.parse(localStorage.getItem(KEY)!);
    expect(persisted).toEqual({ comfyUrl: 'http://x:1', comfyAuthHeader: 'Bearer abc' });
  });

  it('open/close toggles the modal flag WITHOUT persisting it (ephemeral chrome)', () => {
    useSettingsStore.getState().open();
    expect(useSettingsStore.getState().isOpen).toBe(true);
    useSettingsStore.getState().close();
    expect(useSettingsStore.getState().isOpen).toBe(false);
    // open/close never wrote to storage
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
