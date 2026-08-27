import { describe, expect, it, beforeEach, beforeAll, vi } from 'vitest';

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

import { DEFAULT_SETTINGS, useSettingsStore } from './settingsStore';
import { DEFAULT_COMFYUI_URL } from '../../core/comfy';
import { DEFAULT_MOTIONGEN_MODEL, DEFAULT_MOTIONGEN_URL } from '../../core/motiongen';
import {
  aBlockedHuggingFaceRecord,
  aBlockedRecord,
  qualifiedIdOf,
} from '../../core/licensing/blockedModelForTests';

// Derived, never spelled — see blockedModelForTests.
const BLOCKED = aBlockedRecord().id;
const BLOCKED_QUALIFIED = qualifiedIdOf(aBlockedHuggingFaceRecord())!;

const KEY = 'basher.settings.v1';

describe('settingsStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({
      comfyUrl: DEFAULT_COMFYUI_URL,
      comfyAuthHeader: '',
      comfyLiveGenerate: false,
      motionGenUrl: DEFAULT_MOTIONGEN_URL,
      motionGenModel: DEFAULT_MOTIONGEN_MODEL,
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

  it('setComfyUrl keeps the persisted comfyLiveGenerate (regression: URL edit reset it)', () => {
    useSettingsStore.getState().setComfyLiveGenerate(true);
    useSettingsStore.getState().setComfyUrl('http://my-box:9000');
    const persisted = JSON.parse(localStorage.getItem(KEY)!);
    expect(persisted.comfyLiveGenerate).toBe(true);
  });

  it('setComfyAuthHeader persists alongside the URL', () => {
    // The property this test's NAME states. It used to be asserted through an
    // exhaustive literal of the whole blob, which was exact only while the blob
    // had three fields — so it reported failure on correct code the day a
    // fourth arrived. The exhaustiveness it was accidentally carrying is now a
    // test of its own, below, where it is about the right subject.
    useSettingsStore.getState().setComfyUrl('http://x:1');
    useSettingsStore.getState().setComfyAuthHeader('Bearer abc');
    const persisted = JSON.parse(localStorage.getItem(KEY)!);
    expect(persisted).toMatchObject({
      comfyUrl: 'http://x:1',
      comfyAuthHeader: 'Bearer abc',
      comfyLiveGenerate: false,
    });
  });

  it('persists the WHOLE settings slice and nothing else — no ephemeral leak', () => {
    // What the exhaustive literal above was really guarding: `isOpen` and the
    // actions must never reach localStorage, and no persisted field may go
    // missing when a sibling is edited (which has happened — see the
    // comfyLiveGenerate regression above).
    useSettingsStore.getState().open();
    useSettingsStore.getState().setComfyAuthHeader('Bearer abc');
    const persisted = JSON.parse(localStorage.getItem(KEY)!) as Record<string, unknown>;
    // Derived from DEFAULT_SETTINGS — the INDEPENDENT declaration of which
    // fields persist — and deliberately not from `persistedSliceOf`, which is
    // the function that writes this blob. Comparing the blob against its own
    // writer would hold for every implementation, including one that silently
    // dropped a field. These two restate the same shape, and catching them
    // diverging is this test's entire job.
    expect(Object.keys(persisted).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    expect(persisted).not.toHaveProperty('isOpen');
  });

  it('a BLOCKED checkpoint never becomes persisted configuration', () => {
    // localStorage outlives a verdict. A checkpoint recorded usable today can be
    // re-recorded BLOCKED tomorrow, and an id already sitting in a browser would
    // be read back as configuration by a session that has no idea it was refused.
    useSettingsStore.getState().setMotionGenModel(BLOCKED);
    expect(useSettingsStore.getState().motionGenModel).toBe(DEFAULT_MOTIONGEN_MODEL);
  });

  it('a BLOCKED checkpoint already in storage is refused on the way back IN', async () => {
    // The half a setter cannot cover, because the id got there before the verdict
    // moved. Written by hand exactly as a stale browser would hold it, then read
    // through a FRESH module instance — the real path a new session takes, not a
    // test-only hook.
    localStorage.setItem(
      KEY,
      JSON.stringify({
        comfyUrl: DEFAULT_COMFYUI_URL,
        comfyAuthHeader: '',
        comfyLiveGenerate: false,
        motionGenUrl: DEFAULT_MOTIONGEN_URL,
        motionGenModel: BLOCKED_QUALIFIED,
      }),
    );
    vi.resetModules();
    const fresh = await import('./settingsStore');
    expect(fresh.useSettingsStore.getState().motionGenModel).toBe(DEFAULT_MOTIONGEN_MODEL);
  });

  it('an UNRECORDED id IS kept, so a typo can be seen and corrected', () => {
    // The refusal that matters lives at generate, where the use would happen. A
    // setter that silently substituted would hide the typo instead of letting the
    // director find it.
    useSettingsStore.getState().setMotionGenModel('nvidia/Kimodo-Typo-v9');
    expect(useSettingsStore.getState().motionGenModel).toBe('nvidia/Kimodo-Typo-v9');
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
