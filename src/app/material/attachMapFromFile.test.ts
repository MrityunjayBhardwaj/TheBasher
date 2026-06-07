// attachMapFromFile unit (v0.6 #2, #178, W5/5.1). Proves the per-slot colorspace
// is stamped onto the persisted ref (M5 — a data map persisted as sRGB washes
// out) and that a decode failure rejects (the caller surfaces it via
// assetErrorStore). happy-dom has no image decoder, so the decode + canvas-readback
// are INJECTED; the real decode is exercised by the e2e (p06-2-texture-maps).

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import { loadBakedTexture } from '../asset/bakedTextureStore';
import { attachMapFromFile, MATERIAL_MAP_SLOTS, type MaterialMapSlot } from './attachMapFromFile';

function pngFile(): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])], 'tex.png', {
    type: 'image/png',
  });
}

const EXPECTED: Record<MaterialMapSlot, 'srgb' | 'srgb-linear'> = {
  albedo: 'srgb',
  emissive: 'srgb',
  normal: 'srgb-linear',
  roughness: 'srgb-linear',
  metalness: 'srgb-linear',
  ao: 'srgb-linear',
};

describe('attachMapFromFile (W5 — File → OPFS map, colorspace-correct)', () => {
  it.each(MATERIAL_MAP_SLOTS)('stamps the correct colorspace for the %s slot', async (slot) => {
    const storage = new MemoryStorage();
    const ref = await attachMapFromFile(storage, pngFile(), slot, {
      decode: async () => new THREE.Texture(), // bare texture; attach sets colorSpace
      persist: { encodeImage: async () => ({ bytes: new Uint8Array([1, 2, 3]), ext: 'png' }) },
    });
    expect(ref.colorSpace).toBe(EXPECTED[slot]);
    // The bytes landed in OPFS (the ref is a real handle).
    expect(ref.hash.endsWith('.png')).toBe(true);
  });

  it('round-trips: a persisted albedo map reloads with sRGB restored (M5)', async () => {
    const storage = new MemoryStorage();
    const ref = await attachMapFromFile(storage, pngFile(), 'albedo', {
      decode: async () => new THREE.Texture(),
      persist: { encodeImage: async () => ({ bytes: new Uint8Array([9, 9, 9]), ext: 'png' }) },
    });
    const reloaded = await loadBakedTexture(storage, ref, {
      decode: async () => {
        const t = new THREE.Texture();
        t.colorSpace = THREE.NoColorSpace; // wrong on purpose (TextureLoader default)
        return t;
      },
    });
    expect(reloaded.colorSpace).toBe(THREE.SRGBColorSpace); // restored from the ref
  });

  it('rejects when the decode fails (the caller surfaces it via assetErrorStore)', async () => {
    const storage = new MemoryStorage();
    await expect(
      attachMapFromFile(storage, pngFile(), 'albedo', {
        decode: async () => {
          throw new Error('corrupt image');
        },
      }),
    ).rejects.toThrow('corrupt image');
  });
});
