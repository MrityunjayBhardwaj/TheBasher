// attachMapFromFile unit (v0.6 #2, #178, W5/5.1). Proves the per-slot colorspace
// is stamped onto the persisted ref (M5 — a data map persisted as sRGB washes
// out) and that a decode failure rejects (the caller surfaces it via
// assetErrorStore). happy-dom has no image decoder, so the decode + canvas-readback
// are INJECTED; the real decode is exercised by the e2e (p06-2-texture-maps).

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import { loadBakedTexture } from '../asset/bakedTextureStore';
import {
  attachMapFromFile,
  MATERIAL_MAP_SLOTS,
  shownMapSlots,
  type MaterialMapSlot,
} from './attachMapFromFile';
import { hydrateInlineMaterial, NULL_MAPS } from '../../nodes/materialSchema';
import { LOBE_WEIGHT_WHEN_ABSENT, MATERIAL_MAP_SLOT_TABLE } from '../../nodes/types';
import type { MaterialMapSlotRow } from '../../nodes/types';

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
  // #1327 — the coat's maps are data: weight, roughness and a normal.
  coat: 'srgb-linear',
  coatRoughness: 'srgb-linear',
  coatNormal: 'srgb-linear',
  // #1328 — the transmission weight is data too.
  transmission: 'srgb-linear',
  thickness: 'srgb-linear', // #1331
  // #1329 — the sheen colour is a colour, sRGB as three's loader reads it (`GLTFLoader.js:1017`);
  // its roughness is data (`:1023`, no colour space passed).
  fuzzColor: 'srgb',
  fuzzRoughness: 'srgb-linear',
  // #1330 — the specular weight is data (`GLTFLoader.js:1241`); its colour is sRGB (`:1250`).
  specularWeight: 'srgb-linear',
  specularColor: 'srgb',
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

// #1333 — a lobe's map rows show only while the lobe is on (the user's call), or while the slot
// already holds a texture, which must never be hidden.
describe('#1333 — the inspector offers a lobe`s map rows only while that lobe is on', () => {
  const ref = {
    hash: 'h',
    colorSpace: 'srgb-linear',
    flipY: false,
    wrapS: 'repeat',
    wrapT: 'repeat',
  };
  // #1330 — every material's specular lobe draws at weight 1 while its weight is absent, so the
  // specular rows follow the others unless a row turns specular off.
  const SPECULAR = ['specularWeight', 'specularColor'];
  const shown = (raw: Record<string, unknown>) =>
    shownMapSlots(hydrateInlineMaterial(raw) as unknown as Record<string, unknown>);

  it('a material with every lobe off shows the six original slots and nothing else', () => {
    expect(shown({ specular: { roughness: 0.5, ior: 1.5, weight: 0 } })).toEqual(
      Object.keys(NULL_MAPS),
    );
  });

  it('#1330 — specular with no weight draws at 1, so a plain material offers its specular rows', () => {
    const slots = shown({});
    expect(slots).toEqual([...Object.keys(NULL_MAPS), ...SPECULAR]);
    // …and a lobe that is absent altogether still draws at 0: no fuzz rows.
    expect(slots).not.toContain('fuzzColor');
  });

  it('#1330 — the weight each lobe draws with while absent is OpenPBR`s default', () => {
    // `open_pbr_surface.mtlx`: specular_weight 1.0, transmission/fuzz/coat _weight 0.0.
    expect(LOBE_WEIGHT_WHEN_ABSENT).toEqual({ coat: 0, transmission: 0, fuzz: 0, specular: 1 });
  });

  it('a coat above 0 adds its three rows; transmission above 0 adds transmission and thickness', () => {
    expect(shown({ coat: { weight: 0.5, roughness: 0 } })).toEqual([
      ...Object.keys(NULL_MAPS),
      'coat',
      'coatRoughness',
      'coatNormal',
      ...SPECULAR,
    ]);
    expect(shown({ transmission: { weight: 1 } })).toEqual([
      ...Object.keys(NULL_MAPS),
      'transmission',
      'thickness',
      ...SPECULAR,
    ]);
  });

  it('#1329 — a fuzz lobe above 0 adds the sheen colour and roughness rows; no fuzz lobe, none', () => {
    expect(shown({ fuzz: { weight: 1, color: '#ffffff', roughness: 0.5 } })).toEqual([
      ...Object.keys(NULL_MAPS),
      'fuzzColor',
      'fuzzRoughness',
      ...SPECULAR,
    ]);
    expect(shown({ fuzz: { weight: 0, color: '#ffffff', roughness: 0.5 } })).toEqual([
      ...Object.keys(NULL_MAPS),
      ...SPECULAR,
    ]);
  });

  it('a slot that holds a texture stays visible when its lobe is turned off', () => {
    const slots = shown({ coat: { weight: 0, roughness: 0 }, maps: { coat: ref } });
    expect(slots).toContain('coat');
    expect(slots).not.toContain('coatRoughness');
  });

  it('every slot not seeded names the lobe that governs it, so a new lobe row cannot forget', () => {
    const rows = Object.entries(MATERIAL_MAP_SLOT_TABLE) as [string, MaterialMapSlotRow][];
    const unseeded = rows.filter(([, r]) => !r.seeded);
    expect(unseeded.length).toBeGreaterThan(0);
    for (const [slot, row] of unseeded) expect(row.weightOf, slot).toBeDefined();
    // …and each names a lobe the IR really gives a weight.
    const ir = hydrateInlineMaterial({
      fuzz: { weight: 1, color: '#ffffff', roughness: 0 },
      // #1330 — specular's weight is optional; set it so the schema must keep it.
      specular: { roughness: 0.5, ior: 1.5, weight: 1 },
    }) as unknown as Record<string, { weight?: unknown } | undefined>;
    for (const [slot, row] of unseeded)
      expect(typeof ir[row.weightOf!]?.weight, `${slot} → ${row.weightOf}`).toBe('number');
  });
});
