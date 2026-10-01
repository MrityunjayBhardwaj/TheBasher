// #1136 — a baked material keeps each map's UV placement.
//
// The SCHEMA's half: a placement written into a `BakedMaterialSpec` parses back per slot, and a spec
// saved before the field has no key. What the primitive road writes is asserted with its bake in
// `dispatchApplyTransform.test.ts` (#1139). The clone road's capture of a live texture's placement
// (`bakedMapPlacements`) had its rows here; it retired with the clone renderer (#1053).

import { describe, expect, it } from 'vitest';
import { BakedMaterialSpecSchema } from '../../nodes/BakedData';

describe('#1136 the baked material schema keeps the placement', () => {
  const base = {
    materialClass: 'standard' as const,
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

  it('parses a placement back unchanged, per slot', () => {
    const mapPlacements = {
      map: {
        tiling: [2, 3] as [number, number],
        offset: [0.6, 1.2] as [number, number],
        rotation: 0,
      },
      aoMap: {
        tiling: [1, 1] as [number, number],
        offset: [0, 0] as [number, number],
        rotation: 0.5,
      },
    };
    expect(BakedMaterialSpecSchema.parse({ ...base, mapPlacements }).mapPlacements).toEqual(
      mapPlacements,
    );
  });

  it('a spec saved before the field parses with no key at all', () => {
    expect('mapPlacements' in BakedMaterialSpecSchema.parse(base)).toBe(false);
  });
});
