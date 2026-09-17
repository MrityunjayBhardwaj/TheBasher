// #1140 — a bake keeps the cutout it drew with, which faces it drew, and what its glass refracts
// through.
//
// The rows here are the CLONE road's half (`captureBakedMaterial`, reading a live three material);
// the primitive road's half lives with the rest of the inline bake in
// `dispatchApplyTransform.test.ts`. Both ends matter, because the two roads reach the same spec by
// different paths and only the spec is shared.
//
// Each field is absent at three's own default, so the last two rows are the ones that keep an
// earlier save reading exactly as it did.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { captureBakedMaterial } from './captureBakedMaterial';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import { BakedMaterialSpecSchema } from '../../nodes/BakedData';
import type { BakedMaterialSpec } from '../../nodes/types';

const storage = () => new MemoryStorage();

describe('#1140 — the capture reads the surface the material draws', () => {
  it('keeps a cutout threshold', async () => {
    const live = new THREE.MeshStandardMaterial();
    live.alphaTest = 0.4;
    expect((await captureBakedMaterial(storage(), live)).alphaTest).toBe(0.4);
  });

  it('keeps double-sidedness, as the boolean the one side mapping takes', async () => {
    const live = new THREE.MeshStandardMaterial();
    live.side = THREE.DoubleSide;
    expect((await captureBakedMaterial(storage(), live)).doubleSided).toBe(true);
  });

  it('keeps the thickness transmission refracts through', async () => {
    const live = new THREE.MeshPhysicalMaterial({ transmission: 0.5 });
    live.thickness = 0.5;
    const spec = await captureBakedMaterial(storage(), live);
    expect(spec.physical).toMatchObject({ transmission: 0.5, thickness: 0.5 });
  });

  it('an unlit material keeps them too — a cutout is not a lit-shading feature', async () => {
    const live = new THREE.MeshBasicMaterial();
    live.alphaTest = 0.25;
    live.side = THREE.DoubleSide;
    const spec = await captureBakedMaterial(storage(), live);
    expect(spec.materialClass).toBe('basic');
    expect(spec).toMatchObject({ alphaTest: 0.25, doubleSided: true });
  });

  it('a plain material writes neither field', async () => {
    const spec = await captureBakedMaterial(storage(), new THREE.MeshStandardMaterial());
    expect('alphaTest' in spec).toBe(false);
    expect('doubleSided' in spec).toBe(false);
  });

  it('a front-facing material says nothing rather than saying false', async () => {
    const live = new THREE.MeshStandardMaterial();
    live.side = THREE.FrontSide;
    expect('doubleSided' in (await captureBakedMaterial(storage(), live))).toBe(false);
  });
});

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
      doubleSided: true,
      materialClass: 'physical',
      physical: { transmission: 0.5, thickness: 0.5 },
    });
    expect(parsed).toMatchObject({ alphaTest: 0.4, doubleSided: true });
    expect(parsed.physical).toMatchObject({ transmission: 0.5, thickness: 0.5 });
  });

  it('a spec saved before these fields parses with no key at all', () => {
    const parsed = BakedMaterialSpecSchema.parse(base);
    expect('alphaTest' in parsed).toBe(false);
    expect('doubleSided' in parsed).toBe(false);
  });
});
