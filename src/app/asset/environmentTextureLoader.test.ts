// environmentTextureLoader — a failed read is a magenta stand-in, never a throw into render (#1309).
//
// The re-throw relied on an error boundary, and only the world environment has one: a studio
// light (`StudioAreaLightR`) whose texture was missing unmounted the whole app.
//
// REF: src/app/asset/environmentTextureLoader.ts; issues #1309, #1048.

import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadEnvHdri = vi.fn();
vi.mock('./envHdriStore', () => ({ loadEnvHdri: (...a: unknown[]) => loadEnvHdri(...a) }));
vi.mock('../boot', () => ({ getStorage: vi.fn(async () => ({})) }));

import {
  __resetEnvironmentTextureLoaderForTests,
  resolveEnvironmentTexture,
} from './environmentTextureLoader';
import { averageRadiance } from '../averageRadiance';
import { useAssetErrorStore } from '../stores/assetErrorStore';

const REF = 'env-hdri/b90a6094.hdr';

/** Resolve all microtasks so the fire-and-forget load settles. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('resolveEnvironmentTexture — a failed read', () => {
  beforeEach(() => {
    __resetEnvironmentTextureLoaderForTests();
    loadEnvHdri.mockReset();
    useAssetErrorStore.getState().clearAll();
  });

  it('returns a magenta equirect stand-in, one per asset, never a throw', async () => {
    loadEnvHdri.mockRejectedValue(new Error('A requested file or directory could not be found'));

    expect(() => resolveEnvironmentTexture(REF)).toThrow(); // the first call suspends on the read
    await flush();
    const stand = resolveEnvironmentTexture(REF);
    expect(stand.mapping).toBe(THREE.EquirectangularReflectionMapping);
    // Wide enough to prefilter: PMREM sizes an equirect at width / 4, and a 1×1 comes out black.
    expect((stand.image as { width: number }).width).toBeGreaterThanOrEqual(64);
    // The studio light reads the stand-in's mean as its tint: magenta, not the neutral white a
    // texture without pixels would give.
    const avg = averageRadiance(stand);
    expect([avg.r, avg.g, avg.b]).toEqual([1, 0, 1]);
    expect(resolveEnvironmentTexture(REF), 'one stand-in per failed asset').toBe(stand);
  });

  it('names the file in the asset banner, once', async () => {
    loadEnvHdri.mockRejectedValue(new Error('A requested file or directory could not be found'));

    expect(() => resolveEnvironmentTexture(REF)).toThrow();
    expect(() => resolveEnvironmentTexture(REF)).toThrow(); // the same read, not a second one
    await flush();
    resolveEnvironmentTexture(REF);
    const errors = useAssetErrorStore.getState().errors;
    expect(Object.keys(errors)).toEqual([REF]);
    expect(errors[REF]).toMatch(/drawn magenta: .*could not be found/);
    expect(loadEnvHdri).toHaveBeenCalledTimes(1);
  });

  it('a read that succeeds is returned as decoded, and reports nothing', async () => {
    const decoded = new THREE.Texture();
    loadEnvHdri.mockResolvedValue(decoded);

    expect(() => resolveEnvironmentTexture(REF)).toThrow();
    await flush();
    expect(resolveEnvironmentTexture(REF)).toBe(decoded);
    expect(useAssetErrorStore.getState().errors).toEqual({});
  });
});
