// #1136 — a bake keeps each map's UV placement as it drew.
//
// The capture reads offset, repeat, rotation AND centre off the live texture, because the clone road
// places about the UV origin and a baked mesh places about the centre. Rows compare the UV matrix
// three builds for the live texture with the one it builds for the captured placement about the
// centre: equal matrices are the same draw, whatever the numbers look like.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { bakedMapPlacements } from './captureBakedMaterial';
import { CENTRE_PIVOT } from '../material/uvPlacement';
import type { UvPlacement } from '../../nodes/types';
import { BakedMaterialSpecSchema } from '../../nodes/BakedData';

function texture(
  t: Partial<{
    repeat: [number, number];
    offset: [number, number];
    rotation: number;
    center: [number, number];
  }>,
) {
  const tex = new THREE.Texture();
  if (t.repeat) tex.repeat.set(...t.repeat);
  if (t.offset) tex.offset.set(...t.offset);
  if (t.rotation !== undefined) tex.rotation = t.rotation;
  if (t.center) tex.center.set(...t.center);
  return tex;
}

function drawnMatrix(tex: THREE.Texture): number[] {
  tex.updateMatrix();
  return tex.matrix.toArray();
}

function placedMatrix(p: UvPlacement): number[] {
  return new THREE.Matrix3()
    .setUvTransform(
      p.offset[0],
      p.offset[1],
      p.tiling[0],
      p.tiling[1],
      p.rotation,
      CENTRE_PIVOT[0],
      CENTRE_PIVOT[1],
    )
    .toArray();
}

describe('#1136 bakedMapPlacements', () => {
  it('captures a clone-road map (origin pivot) as the centre-pivot placement that draws the same', () => {
    const map = texture({ repeat: [2, 3], offset: [0.1, 0.2], center: [0, 0] });
    const placements = bakedMapPlacements(new THREE.MeshStandardMaterial({ map }));
    expect(Object.keys(placements ?? {})).toEqual(['map']);
    const want = drawnMatrix(map);
    const got = placedMatrix(placements!.map!);
    for (let i = 0; i < 9; i++) expect(got[i]).toBeCloseTo(want[i], 12);
  });

  it('keeps each slot’s own placement, rotation and a centre pivot included', () => {
    const normalMap = texture({
      repeat: [4, 0.5],
      rotation: 0.7,
      center: [0.5, 0.5],
      offset: [0.25, -1],
    });
    const emissiveMap = texture({ repeat: [1, 1], rotation: -1.2, center: [0, 0] });
    const placements = bakedMapPlacements(
      new THREE.MeshStandardMaterial({ normalMap, emissiveMap }),
    )!;
    expect(Object.keys(placements).sort()).toEqual(['emissiveMap', 'normalMap']);
    for (const [slot, tex] of [
      ['normalMap', normalMap],
      ['emissiveMap', emissiveMap],
    ] as const) {
      const want = drawnMatrix(tex);
      const got = placedMatrix(placements[slot]!);
      for (let i = 0; i < 9; i++) expect(got[i]).toBeCloseTo(want[i], 12);
    }
  });

  it('lists nothing for untransformed maps, so an ordinary bake writes no field', () => {
    const material = new THREE.MeshStandardMaterial({
      map: texture({}),
      aoMap: texture({ center: [0.5, 0.5] }),
    });
    expect(bakedMapPlacements(material)).toBeUndefined();
    expect(bakedMapPlacements(new THREE.MeshStandardMaterial())).toBeUndefined();
  });

  it('reads the basic material’s one map too', () => {
    const map = texture({ repeat: [3, 3] });
    expect(Object.keys(bakedMapPlacements(new THREE.MeshBasicMaterial({ map })) ?? {})).toEqual([
      'map',
    ]);
  });
});

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
