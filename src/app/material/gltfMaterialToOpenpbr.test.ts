// gltfMaterialToOpenpbr — recovers the OpenPBR IR from a loaded glTF clone's
// three.js material, the exact inverse of openpbrToThree for the WebGL lobes.
// Proof: (1) core scalars are read off a MeshStandardMaterial; (2) a full
// round-trip through openpbrToThree recovers them (V29 no-drift, bidirectional);
// (3) a KHR_materials_unlit MeshBasicMaterial (no roughness/metalness/emissive)
// degrades to defaults, never an out-of-band IR.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { gltfMaterialToOpenpbr } from './gltfMaterialToOpenpbr';
import { openpbrToThree } from './openpbrToThree';

describe('gltfMaterialToOpenpbr', () => {
  it('reads the core PBR scalars off a MeshStandardMaterial', () => {
    const m = new THREE.MeshStandardMaterial({
      color: 0xff8800,
      metalness: 0.7,
      roughness: 0.25,
      emissive: 0x112233,
      emissiveIntensity: 2,
      opacity: 0.5,
      transparent: true,
    });
    m.name = 'Hull';
    const ir = gltfMaterialToOpenpbr(m);
    expect(ir.name).toBe('Hull');
    // Compare against the material's OWN hex read (colorspace-philosophy-agnostic).
    expect(ir.base.color).toBe(`#${m.color.getHexString()}`);
    expect(ir.base.metalness).toBeCloseTo(0.7);
    expect(ir.specular.roughness).toBeCloseTo(0.25);
    expect(ir.emission.color).toBe(`#${m.emissive.getHexString()}`);
    expect(ir.emission.luminance).toBeCloseTo(2);
    expect(ir.geometry.opacity).toBeCloseTo(0.5);
    // Maps are not captured in this slice — IR seeds null + identity UV.
    expect(ir.maps.albedo).toBeNull();
    expect(ir.uvTransform.tiling).toEqual([1, 1]);
  });

  it('round-trips through openpbrToThree for every supported lobe', () => {
    const m = new THREE.MeshPhysicalMaterial({
      color: 0x3366cc,
      metalness: 0.2,
      roughness: 0.6,
      ior: 1.45,
      clearcoat: 0.8,
      clearcoatRoughness: 0.1,
      transmission: 0.3,
      emissive: 0x000000,
      opacity: 1,
    });
    const back = openpbrToThree(gltfMaterialToOpenpbr(m));
    expect(back.color).toBe(`#${m.color.getHexString()}`);
    expect(back.metalness).toBeCloseTo(0.2);
    expect(back.roughness).toBeCloseTo(0.6);
    expect(back.ior).toBeCloseTo(1.45);
    expect(back.clearcoat).toBeCloseTo(0.8);
    expect(back.clearcoatRoughness).toBeCloseTo(0.1);
    expect(back.transmission).toBeCloseTo(0.3);
    // transmission > 0 → the forward adapter seeds thickness + transparent.
    expect(back.transparent).toBe(true);
  });

  it('degrades a KHR_materials_unlit MeshBasicMaterial to defaults (no crash)', () => {
    const m = new THREE.MeshBasicMaterial({ color: 0x00ff00, opacity: 0.8, transparent: true });
    const ir = gltfMaterialToOpenpbr(m);
    expect(ir.base.color).toBe(`#${m.color.getHexString()}`);
    expect(ir.base.metalness).toBe(0); // absent on Basic → default 0
    expect(ir.specular.roughness).toBe(1); // absent → default 1
    expect(ir.specular.ior).toBe(1.5); // absent → default 1.5
    expect(ir.geometry.opacity).toBeCloseTo(0.8);
  });
});
