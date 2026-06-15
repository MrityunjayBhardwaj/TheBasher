// gltfJsonMaterialToOpenpbr — capture a glTF JSON material → OpenPBR IR at import.
// Proof: (1) core metallic-roughness factors map with glTF spec defaults
// (metallic/roughness default 1); (2) KHR scalar extensions (ior, clearcoat,
// transmission, emissive_strength) are read; (3) baseColorFactor alpha → opacity
// only for alphaMode BLEND; (4) colours convert linear→sRGB through three's Color
// (matching GLTFLoader); (5) a full round-trip through openpbrToThree recovers the
// supported lobes.

import { describe, it, expect } from 'vitest';
import { Color, LinearSRGBColorSpace, SRGBColorSpace } from 'three';
import { gltfJsonMaterialToOpenpbr } from './gltfJsonMaterialToOpenpbr';
import { openpbrToThree } from '../../app/material/openpbrToThree';

/** Expected sRGB hex for a glTF linear factor, via the SAME path the converter uses. */
function linHex(r: number, g: number, b: number): string {
  const c = new Color();
  c.setRGB(r, g, b, LinearSRGBColorSpace);
  return `#${c.getHexString(SRGBColorSpace)}`;
}

describe('gltfJsonMaterialToOpenpbr', () => {
  it('maps core metallic-roughness with glTF spec defaults', () => {
    const ir = gltfJsonMaterialToOpenpbr({
      name: 'Hull',
      pbrMetallicRoughness: {
        baseColorFactor: [0.5, 0.25, 0.1, 1],
        metallicFactor: 0.8,
        roughnessFactor: 0.3,
      },
    });
    expect(ir.name).toBe('Hull');
    expect(ir.base.color).toBe(linHex(0.5, 0.25, 0.1));
    expect(ir.base.metalness).toBeCloseTo(0.8);
    expect(ir.specular.roughness).toBeCloseTo(0.3);
    expect(ir.geometry.opacity).toBe(1); // OPAQUE ignores baseColorFactor alpha
  });

  it('defaults metallic + roughness to 1 (glTF spec) when absent', () => {
    const ir = gltfJsonMaterialToOpenpbr({
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] },
    });
    expect(ir.base.metalness).toBe(1);
    expect(ir.specular.roughness).toBe(1);
    expect(ir.specular.ior).toBe(1.5);
  });

  it('reads KHR scalar extensions (ior, clearcoat, transmission, emissive_strength)', () => {
    const ir = gltfJsonMaterialToOpenpbr({
      emissiveFactor: [1, 0, 0],
      extensions: {
        KHR_materials_ior: { ior: 1.45 },
        KHR_materials_clearcoat: { clearcoatFactor: 0.7, clearcoatRoughnessFactor: 0.15 },
        KHR_materials_transmission: { transmissionFactor: 0.4 },
        KHR_materials_emissive_strength: { emissiveStrength: 3 },
      },
    });
    expect(ir.specular.ior).toBeCloseTo(1.45);
    expect(ir.coat.weight).toBeCloseTo(0.7);
    expect(ir.coat.roughness).toBeCloseTo(0.15);
    expect(ir.transmission.weight).toBeCloseTo(0.4);
    expect(ir.emission.color).toBe(linHex(1, 0, 0));
    expect(ir.emission.luminance).toBeCloseTo(3);
  });

  it('maps baseColorFactor alpha → opacity ONLY for alphaMode BLEND', () => {
    const blend = gltfJsonMaterialToOpenpbr({
      alphaMode: 'BLEND',
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.4] },
    });
    expect(blend.geometry.opacity).toBeCloseTo(0.4);
    const opaque = gltfJsonMaterialToOpenpbr({
      alphaMode: 'OPAQUE',
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.4] },
    });
    expect(opaque.geometry.opacity).toBe(1);
  });

  it('round-trips through openpbrToThree for the supported lobes', () => {
    const ir = gltfJsonMaterialToOpenpbr({
      pbrMetallicRoughness: {
        baseColorFactor: [0.2, 0.4, 0.8, 1],
        metallicFactor: 0.1,
        roughnessFactor: 0.6,
      },
      extensions: { KHR_materials_transmission: { transmissionFactor: 0.3 } },
    });
    const back = openpbrToThree(ir);
    expect(back.color).toBe(linHex(0.2, 0.4, 0.8));
    expect(back.metalness).toBeCloseTo(0.1);
    expect(back.roughness).toBeCloseTo(0.6);
    expect(back.transmission).toBeCloseTo(0.3);
    expect(back.transparent).toBe(true); // transmission > 0
  });
});
