// #1327 — the coat lobe's textures: the first slots the table holds that are NOT seeded, so these
// rows are also the first live inputs to the branches an unseeded slot takes (the compile leaves
// an absent slot out; the baked schema lets an older snapshot omit it).
import { describe, expect, it } from 'vitest';
import { hydrateInlineMaterial } from './materialSchema';
import { BakedMaterialSpecSchema } from './BakedData';
import { openpbrToThree } from '../app/material/openpbrToThree';
import type { BakedTextureRef } from './types';

const ref = (hash: string): BakedTextureRef => ({
  hash,
  colorSpace: 'srgb-linear',
  flipY: false,
  wrapS: 'repeat',
  wrapT: 'repeat',
});

describe('#1327 — the coat maps compile to three`s coat maps', () => {
  it('each IR coat slot lands on its three slot, with the coat normal`s strength', () => {
    const ir = hydrateInlineMaterial({
      coat: { weight: 1, roughness: 0.3 },
      maps: { coat: ref('c'), coatRoughness: ref('cr'), coatNormal: ref('cn') },
      mapStrengths: { coatNormal: 0.5 },
    });
    const drawn = openpbrToThree(ir);
    expect(drawn.maps).toMatchObject({
      clearcoatMap: ref('c'),
      clearcoatRoughnessMap: ref('cr'),
      clearcoatNormalMap: ref('cn'),
    });
    expect(drawn.clearcoatNormalScale).toBe(0.5);
  });

  it('a material without them compiles no coat map key at all', () => {
    const drawn = openpbrToThree(hydrateInlineMaterial({}));
    for (const k of ['clearcoatMap', 'clearcoatRoughnessMap', 'clearcoatNormalMap'])
      expect(k in drawn.maps, k).toBe(false);
    expect('clearcoatNormalScale' in drawn).toBe(false);
  });
});

describe('#1327 — a baked snapshot', () => {
  const older = {
    materialClass: 'physical',
    color: '#ffffff',
    roughness: 0.5,
    metalness: 0,
    opacity: 1,
    transparent: false,
    emissive: '#000000',
    emissiveIntensity: 1,
    map: null,
    normalMap: null,
    roughnessMap: null,
    metalnessMap: null,
    aoMap: null,
    emissiveMap: null,
  };

  it('saved before the coat maps still parses, and gains no coat field', () => {
    const parsed = BakedMaterialSpecSchema.parse(older);
    expect('clearcoatMap' in parsed).toBe(false);
  });

  it('keeps a coat map and the coat normal`s strength through the parse', () => {
    const parsed = BakedMaterialSpecSchema.parse({
      ...older,
      clearcoatNormalMap: ref('cn'),
      physical: { clearcoat: 1, clearcoatNormalScale: 0.5 },
    });
    expect(parsed.clearcoatNormalMap).toEqual(ref('cn'));
    expect(parsed.physical?.clearcoatNormalScale).toBe(0.5);
  });
});

describe('#1327 — the coat normal`s strength hydrates like the other strengths', () => {
  it('a number is kept; anything else reads as the default', () => {
    expect(hydrateInlineMaterial({ mapStrengths: { coatNormal: 0.5 } }).mapStrengths).toEqual({
      coatNormal: 0.5,
    });
    expect('mapStrengths' in hydrateInlineMaterial({ mapStrengths: { coatNormal: 'x' } })).toBe(
      false,
    );
  });
});
