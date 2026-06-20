import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import { persistTexture } from '../asset/bakedTextureStore';
import { NULL_MAPS } from '../../nodes/materialSchema';
import type { InlineMaterialMaps } from '../../nodes/types';
import type { BakedTextureRef } from '../../nodes/types';
import {
  CLEARED_MAP,
  isClearedMap,
  isImportedMap,
  hasMapEdits,
  applyEditedMaps,
} from './gltfMapOverlay';

/** A captured imported-texture descriptor (empty hash + a gltfTexture index). */
const IMPORTED: BakedTextureRef = {
  hash: '',
  colorSpace: 'srgb',
  flipY: false,
  wrapS: 10497,
  wrapT: 10497,
  gltfTexture: 0,
};

// happy-dom has no image decoder, so the load path is driven through an injected
// `decode` hook (the same seam bakedTextureStore.test.ts uses); the unit proves
// the edit-layer semantics (inherit / replace / clear) + the slot→three mapping.
// The e2e (ux-gltf-map-edit) proves the real decode on a live render.

function maps(over: Partial<InlineMaterialMaps>): InlineMaterialMaps {
  return { ...NULL_MAPS, ...over };
}

describe('gltfMapOverlay', () => {
  it('isClearedMap recognizes the empty-hash sentinel only', () => {
    expect(isClearedMap(CLEARED_MAP)).toBe(true);
    expect(isClearedMap(null)).toBe(false);
    expect(
      isClearedMap({ hash: 'abc.png', colorSpace: 'srgb', flipY: false, wrapS: 0, wrapT: 0 }),
    ).toBe(false);
  });

  it('hasMapEdits is false for all-null maps, true for any non-null slot', () => {
    expect(hasMapEdits(maps({}))).toBe(false);
    expect(hasMapEdits(maps({ albedo: CLEARED_MAP }))).toBe(true);
    expect(
      hasMapEdits(
        maps({
          normal: { hash: 'n.png', colorSpace: 'srgb-linear', flipY: false, wrapS: 0, wrapT: 0 },
        }),
      ),
    ).toBe(true);
  });

  it('disambiguates an imported descriptor from the cleared sentinel (both hash:"")', () => {
    expect(isImportedMap(IMPORTED)).toBe(true);
    expect(isImportedMap(CLEARED_MAP)).toBe(false); // no gltfTexture
    expect(isImportedMap(null)).toBe(false);
    // The cleared check must NOT match an imported descriptor (else inherit→remove).
    expect(isClearedMap(IMPORTED)).toBe(false);
    expect(isClearedMap(CLEARED_MAP)).toBe(true);
  });

  it('an imported-only material is NOT an edit (zero map work on unedited import)', () => {
    expect(hasMapEdits(maps({ albedo: IMPORTED, normal: IMPORTED }))).toBe(false);
    // …but a real edit alongside imported descriptors still counts.
    expect(hasMapEdits(maps({ albedo: IMPORTED, normal: CLEARED_MAP }))).toBe(true);
  });

  it('an imported descriptor INHERITS — leaves the clone texture untouched', async () => {
    const mat = new THREE.MeshStandardMaterial();
    const imported = new THREE.Texture();
    mat.map = imported;
    const changed = await applyEditedMaps(
      mat,
      maps({ albedo: IMPORTED }),
      new MemoryStorage(),
      () => false,
    );
    expect(changed).toBe(false);
    expect(mat.map).toBe(imported); // inherited, never removed or replaced
  });

  it('null slot INHERITS — the imported texture is left untouched', async () => {
    const mat = new THREE.MeshStandardMaterial();
    const imported = new THREE.Texture();
    mat.map = imported;
    const changed = await applyEditedMaps(mat, maps({}), new MemoryStorage(), () => false);
    expect(changed).toBe(false);
    expect(mat.map).toBe(imported); // inherited, not removed
  });

  it('cleared slot REMOVES the imported texture (→ null)', async () => {
    const mat = new THREE.MeshStandardMaterial();
    mat.map = new THREE.Texture();
    const changed = await applyEditedMaps(
      mat,
      maps({ albedo: CLEARED_MAP }),
      new MemoryStorage(),
      () => false,
    );
    expect(changed).toBe(true);
    expect(mat.map).toBeNull();
  });

  it('a real ref REPLACES the slot, mapping albedo→map (and restoring colorspace)', async () => {
    const storage = new MemoryStorage();
    // Bake a stand-in texture to OPFS so loadBakedTexture has bytes to read.
    await storage.write('user-imports/x/a.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]));
    const stand = new THREE.Texture();
    stand.colorSpace = THREE.SRGBColorSpace;
    stand.flipY = false;
    const ref = await persistTexture(storage, stand, {
      resolveSourcePath: () => 'user-imports/x/a.png',
    });

    const mat = new THREE.MeshStandardMaterial();
    const imported = new THREE.Texture();
    mat.map = imported;
    const loaded = new THREE.Texture();
    const changed = await applyEditedMaps(mat, maps({ albedo: ref }), storage, () => false, {
      decode: async () => loaded,
    });
    expect(changed).toBe(true);
    expect(mat.map).toBe(loaded);
    expect(mat.map).not.toBe(imported);
    expect(loaded.colorSpace).toBe(THREE.SRGBColorSpace); // restored from ref
  });

  it('a cancelled load does NOT land on the material', async () => {
    const storage = new MemoryStorage();
    await storage.write('user-imports/x/b.png', new Uint8Array([1, 2, 3, 4]));
    const stand = new THREE.Texture();
    const ref = await persistTexture(storage, stand, {
      resolveSourcePath: () => 'user-imports/x/b.png',
    });
    const mat = new THREE.MeshStandardMaterial();
    const imported = new THREE.Texture();
    mat.map = imported;
    const changed = await applyEditedMaps(mat, maps({ albedo: ref }), storage, () => true, {
      decode: async () => new THREE.Texture(),
    });
    expect(changed).toBe(false);
    expect(mat.map).toBe(imported); // stale load dropped
  });
});
