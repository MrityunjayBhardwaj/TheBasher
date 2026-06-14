// peekBakedTexture — the NON-throwing read used by the UV-editor texture
// backdrop (UX #10), which lives OUTSIDE a Suspense boundary and must never
// throw/hang. Contrast with resolveBakedTexture (the Suspense core), which
// throws the in-flight promise. happy-dom has no real decoder, so we inject
// loadBakedTexture + getStorage and drive the cache/error state machine.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import type { BakedTextureRef } from '../../nodes/types';

const loadBakedTexture = vi.fn();
vi.mock('./bakedTextureStore', () => ({
  loadBakedTexture: (...args: unknown[]) => loadBakedTexture(...args),
}));
vi.mock('../boot', () => ({
  getStorage: vi.fn(async () => ({})),
}));

import {
  peekBakedTexture,
  resolveBakedTexture,
  __resetBakedTextureLoaderForTests,
} from './bakedTextureLoader';

const REF: BakedTextureRef = {
  hash: 'deadbeef.png',
  colorSpace: 'srgb',
  flipY: false,
  wrapS: THREE.RepeatWrapping,
  wrapT: THREE.ClampToEdgeWrapping,
};

/** Resolve all microtasks so the fire-and-forget load settles. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('peekBakedTexture (non-throwing UV-backdrop read)', () => {
  beforeEach(() => {
    __resetBakedTextureLoaderForTests();
    loadBakedTexture.mockReset();
  });

  it('returns null on a cache MISS instead of throwing, and kicks off ONE load', async () => {
    const tex = new THREE.Texture();
    loadBakedTexture.mockResolvedValue(tex);

    // First peek: miss → null (NOT a thrown promise like resolveBakedTexture).
    expect(peekBakedTexture(REF)).toBeNull();
    // A second peek before the load settles must NOT start a second load.
    expect(peekBakedTexture(REF)).toBeNull();
    await flush();
    expect(loadBakedTexture).toHaveBeenCalledTimes(1);

    // Once decoded, the peek returns the cached texture (the backdrop fills in).
    expect(peekBakedTexture(REF)).toBe(tex);
  });

  it('returns null (no throw, no permanent hang) when the decode FAILS', async () => {
    loadBakedTexture.mockRejectedValue(new Error('corrupt texture bytes'));

    expect(peekBakedTexture(REF)).toBeNull();
    await flush();
    // The cached error keeps peek returning null — the editor shows the grid,
    // never crashes (resilience by construction, V48).
    expect(peekBakedTexture(REF)).toBeNull();
  });

  it('a failed decode makes resolveBakedTexture (the Suspense core) re-THROW', async () => {
    const err = new Error('corrupt texture bytes');
    loadBakedTexture.mockRejectedValue(err);

    // Prime the error cache through the non-throwing peek.
    expect(peekBakedTexture(REF)).toBeNull();
    await flush();
    // The Suspense consumer surfaces the error (so its error boundary catches it).
    expect(() => resolveBakedTexture(REF)).toThrow('corrupt texture bytes');
  });
});
