// #1140 — a baked material keeps the cutout it drew with, which faces it drew, and what its glass
// refracts through; #1322, #1321, #1123 — its volume, specular colour and sheen.
//
// These rows are the SCHEMA's half: a field the spec never declared dies at parse, which is what a
// save and an `addNode` go through. What the primitive road WRITES is asserted with the rest of its
// bake in `dispatchApplyTransform.test.ts`. The clone road's capture (`captureBakedMaterial`,
// reading a live three material) had its own rows here; it retired with the clone renderer (#1053).
//
// Each field is absent at its default, so the "saved before" row is the one that keeps an earlier
// save reading exactly as it did.

import { describe, expect, it } from 'vitest';
import { BakedMaterialSpecSchema } from '../../nodes/BakedData';
import type { BakedMaterialSpec } from '../../nodes/types';

describe('#1140 — the schema carries them, which is what makes them survive a save', () => {
  const base: BakedMaterialSpec = {
    materialClass: 'standard',
    color: '#ffffff',
    roughness: 0.5,
    metalness: 0,
    opacity: 1,
    transparent: false,
    emissive: '#000000',
    emissiveIntensity: 0,
    map: null,
    normalMap: null,
    roughnessMap: null,
    metalnessMap: null,
    aoMap: null,
    emissiveMap: null,
  };

  it('round-trips the cutout, the side and the thickness', () => {
    const parsed = BakedMaterialSpecSchema.parse({
      ...base,
      alphaTest: 0.4,
      alphaHash: true,
      doubleSided: true,
      materialClass: 'physical',
      physical: { transmission: 0.5, thickness: 0.5 },
    });
    // #1435 — the hashed alpha too.
    expect(parsed).toMatchObject({ alphaTest: 0.4, alphaHash: true, doubleSided: true });
    expect(parsed.physical).toMatchObject({ transmission: 0.5, thickness: 0.5 });
  });

  it('a spec saved before these fields parses with no key at all', () => {
    const parsed = BakedMaterialSpecSchema.parse(base);
    expect('alphaTest' in parsed).toBe(false);
    expect('alphaHash' in parsed).toBe(false);
    expect('doubleSided' in parsed).toBe(false);
  });

  it('#1322 #1321 #1123 — the volume, specular colour and sheen fields survive too', () => {
    const parsed = BakedMaterialSpecSchema.parse({
      materialClass: 'physical',
      color: '#ffffff',
      roughness: 0.5,
      metalness: 0,
      opacity: 1,
      transparent: false,
      emissive: '#000000',
      emissiveIntensity: 0,
      map: null,
      normalMap: null,
      roughnessMap: null,
      metalnessMap: null,
      aoMap: null,
      emissiveMap: null,
      physical: {
        sheen: 1,
        sheenColor: '#ff8800',
        sheenRoughness: 0.3,
        specularColor: '#ffbc89',
        attenuationDistance: 0.5,
        attenuationColor: '#7ccbff',
      },
    });
    expect(parsed.physical).toMatchObject({
      attenuationDistance: 0.5,
      attenuationColor: '#7ccbff',
    });
    expect(parsed.physical).toMatchObject({
      sheenColor: '#ff8800',
      sheenRoughness: 0.3,
      specularColor: '#ffbc89',
    });
  });
});
