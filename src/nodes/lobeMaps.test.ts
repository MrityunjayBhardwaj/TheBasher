// The material lobes' textures, one describe per lobe. #1327 (the coat) added the first slots the
// table holds that are NOT seeded, so its rows are also the first live inputs to the branches an
// unseeded slot takes (the compile leaves an absent slot out; the baked schema lets an older
// snapshot omit it). #1328 (transmission) is the second lobe down the same path.
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

describe('#1328 — the transmission map compiles to three`s', () => {
  it('lands on `transmissionMap`, and a material without one compiles no such key', () => {
    const withMap = openpbrToThree(
      hydrateInlineMaterial({
        transmission: { weight: 1 },
        maps: { transmission: ref('t') },
      }),
    );
    expect(withMap.maps.transmissionMap).toEqual(ref('t'));
    expect(withMap.transmission).toBe(1);
    expect('transmissionMap' in openpbrToThree(hydrateInlineMaterial({})).maps).toBe(false);
  });
});

describe('#1331 — the thickness map compiles to three`s', () => {
  it('lands on `thicknessMap` beside the thickness it scales', () => {
    const drawn = openpbrToThree(
      hydrateInlineMaterial({
        transmission: { weight: 1 },
        geometry: { opacity: 1, thickness: 0.5 },
        maps: { thickness: ref('th') },
      }),
    );
    expect(drawn.maps.thicknessMap).toEqual(ref('th'));
    expect(drawn.thickness).toBe(0.5);
    expect('thicknessMap' in openpbrToThree(hydrateInlineMaterial({})).maps).toBe(false);
  });
});

describe('#1329 — the sheen maps compile to three`s', () => {
  it('land on `sheenColorMap` and `sheenRoughnessMap` beside the sheen they scale', () => {
    const drawn = openpbrToThree(
      hydrateInlineMaterial({
        fuzz: { weight: 1, color: '#ffffff', roughness: 0.5 },
        maps: { fuzzColor: ref('sc'), fuzzRoughness: ref('sr') },
      }),
    );
    expect(drawn.maps.sheenColorMap).toEqual(ref('sc'));
    expect(drawn.maps.sheenRoughnessMap).toEqual(ref('sr'));
    expect(drawn.sheen).toBe(1);
    const bare = openpbrToThree(hydrateInlineMaterial({})).maps;
    expect('sheenColorMap' in bare || 'sheenRoughnessMap' in bare).toBe(false);
  });
});

describe('#1330 — the specular maps compile to three`s', () => {
  it('land on `specularIntensityMap` and `specularColorMap`, with no weight written', () => {
    const drawn = openpbrToThree(
      hydrateInlineMaterial({
        maps: { specularWeight: ref('sw'), specularColor: ref('sc') },
      }),
    );
    expect(drawn.maps.specularIntensityMap).toEqual(ref('sw'));
    expect(drawn.maps.specularColorMap).toEqual(ref('sc'));
    // Absent weight: three keeps its own 1 (`MeshPhysicalMaterial.js:64`), so the maps draw.
    expect('specularIntensity' in drawn).toBe(false);
    const bare = openpbrToThree(hydrateInlineMaterial({})).maps;
    expect('specularIntensityMap' in bare || 'specularColorMap' in bare).toBe(false);
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
