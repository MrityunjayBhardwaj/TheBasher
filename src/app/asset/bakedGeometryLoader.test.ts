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
import { withWriteNotice } from '../../core/storage/writeNotice';
import type { StorageCapability } from '../../core/storage/StorageCapability';
import * as geometryRegistry from '../geometryRegistry';
import { useAssetErrorStore } from '../stores/assetErrorStore';
import { __resetReadFailuresForTests } from './readFailures';
import { bakedGeometryPath, writeBakedGeometry } from './bakedGeometryStore';
import { __resetBakedGeometryLoaderForTests, resolveBakedGeometry } from './bakedGeometryLoader';

// The storage `pickStorage` hands out: it announces writes, which is what forgets a failure.
let currentStorage: StorageCapability = withWriteNotice(new MemoryStorage());
vi.mock('../boot', () => ({
  getStorage: async () => currentStorage,
}));

beforeEach(() => {
  currentStorage = withWriteNotice(new MemoryStorage());
  geometryRegistry.clear();
  __resetBakedGeometryLoaderForTests();
  __resetReadFailuresForTests();
  useAssetErrorStore.getState().clearAll();
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
    expect(geometryRegistry.getForRead(ref)).toBeNull();

    const loaded = await resolveSuspense(ref);
    loaded.computeBoundingBox();

    // Registry is now primed — a subsequent get is a sync hit (same instance).
    expect(geometryRegistry.getForRead(ref)).toBe(loaded);

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

  // #1308 — a missing file used to be re-thrown into render, and nothing above `BakedMeshR`
  // catches it: one missing geometry blanked the whole app.
  it('a geometry file that cannot be read resolves to an empty stand-in, never a throw', async () => {
    const ref = await writeBakedGeometry(currentStorage, new BoxGeometry(1, 1, 1));
    if (ref.descriptor.kind !== 'baked') throw new Error('expected a baked ref');
    await currentStorage.delete(bakedGeometryPath(ref.descriptor.hash, ref.descriptor.vertexCount));

    const stand = await resolveSuspense(ref);
    expect(stand.getAttribute('position')).toBeUndefined();
    expect(resolveBakedGeometry(ref), 'one stand-in per failed ref').toBe(stand);
    // Not primed: a sync reader still sees "no geometry", not a real empty mesh.
    expect(geometryRegistry.getForRead(ref)).toBeNull();
  });

  it('a failed read names the geometry file in the asset banner, once', async () => {
    const ref = await writeBakedGeometry(currentStorage, new BoxGeometry(1, 1, 1));
    if (ref.descriptor.kind !== 'baked') throw new Error('expected a baked ref');
    const path = bakedGeometryPath(ref.descriptor.hash, ref.descriptor.vertexCount);
    await currentStorage.delete(path);

    await resolveSuspense(ref);
    resolveBakedGeometry(ref);
    const errors = useAssetErrorStore.getState().errors;
    expect(Object.keys(errors)).toEqual([path]);
    expect(errors[path]).toMatch(/drawn empty: /);
  });

  // #1312 — an identical bake writes the same file back. The cached failure used to answer for it
  // until a reload, so the NEW bake drew empty too (measured).
  it('once the file is written again, the next resolve reads it and the banner row clears', async () => {
    const box = new BoxGeometry(2, 1, 1);
    const ref = await writeBakedGeometry(currentStorage, box);
    if (ref.descriptor.kind !== 'baked') throw new Error('expected a baked ref');
    const path = bakedGeometryPath(ref.descriptor.hash, ref.descriptor.vertexCount);
    await currentStorage.delete(path);
    const stand = await resolveSuspense(ref);
    expect(stand.getAttribute('position')).toBeUndefined();

    const again = await writeBakedGeometry(currentStorage, new BoxGeometry(2, 1, 1));
    expect(again.key).toBe(ref.key); // the same content lands on the same path

    const loaded = await resolveSuspense(ref);
    expect(loaded).not.toBe(stand);
    expect(loaded.getAttribute('position').count).toBe(box.getAttribute('position').count);
    expect(useAssetErrorStore.getState().errors).toEqual({});
  });
});
