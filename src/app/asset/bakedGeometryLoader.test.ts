// bakedGeometryLoader — suspense round-trip unit coverage (Phase 151 Wave 1 t2).
//
// boot.getStorage is mocked to a fresh MemoryStorage per test (mirrors
// importCommon.test.ts). Asserts the OPFS round-trip: write (Wave 1 t1) →
// resolveBakedGeometry throws the in-flight promise (miss) → after it resolves it
// primes the registry → a re-call is a sync hit whose bounds match the written
// geometry (SC-3 unit half).

import { BoxGeometry } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import * as geometryRegistry from '../geometryRegistry';
import { writeBakedGeometry } from './bakedGeometryStore';
import { __resetBakedGeometryLoaderForTests, resolveBakedGeometry } from './bakedGeometryLoader';

let currentStorage: MemoryStorage = new MemoryStorage();
vi.mock('../boot', () => ({
  getStorage: async () => currentStorage,
}));

beforeEach(() => {
  currentStorage = new MemoryStorage();
  geometryRegistry.clear();
  __resetBakedGeometryLoaderForTests();
});
afterEach(() => geometryRegistry.clear());

/**
 * Drive the suspense hook to resolution: call once (throws the in-flight
 * promise), await that promise, then call again (sync hit).
 */
async function resolveSuspense(ref: Parameters<typeof resolveBakedGeometry>[0]) {
  try {
    resolveBakedGeometry(ref);
    throw new Error('expected resolveBakedGeometry to suspend (throw a promise) on first call');
  } catch (thrown) {
    if (!(thrown instanceof Promise)) throw thrown;
    await thrown;
  }
  return resolveBakedGeometry(ref);
}

describe('bakedGeometryLoader', () => {
  it('write → resolveBakedGeometry suspends, then primes the registry; bounds match the written geometry (SC-3)', async () => {
    const box = new BoxGeometry(2, 1, 1);
    box.computeBoundingBox();
    const ref = await writeBakedGeometry(currentStorage, box);

    // Unprimed: a direct registry get is a miss.
    expect(geometryRegistry.get(ref)).toBeNull();

    const loaded = await resolveSuspense(ref);
    loaded.computeBoundingBox();

    // Registry is now primed — a subsequent get is a sync hit (same instance).
    expect(geometryRegistry.get(ref)).toBe(loaded);

    // Bounds match the written geometry (round-trip fidelity).
    const src = box.boundingBox!;
    const out = loaded.boundingBox!;
    expect(out.min.toArray()).toEqual(src.min.toArray());
    expect(out.max.toArray()).toEqual(src.max.toArray());
    expect(loaded.getAttribute('position').count).toBe(box.getAttribute('position').count);
  });

  it('a second resolveBakedGeometry after prime is a sync hit (no re-suspend)', async () => {
    const box = new BoxGeometry(1, 1, 1);
    const ref = await writeBakedGeometry(currentStorage, box);
    const loaded = await resolveSuspense(ref);
    // No throw on the synchronous re-call.
    expect(resolveBakedGeometry(ref)).toBe(loaded);
  });
});
