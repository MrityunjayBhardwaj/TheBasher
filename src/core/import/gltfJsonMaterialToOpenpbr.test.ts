// gltfJsonMaterialToOpenpbr — capture a glTF JSON material → OpenPBR IR at import.
// Proof: (1) core metallic-roughness factors map with glTF spec defaults
// (metallic/roughness default 1); (2) KHR scalar extensions (ior, clearcoat,
// transmission, emissive_strength) are read; (3) baseColorFactor alpha → opacity
// only for alphaMode BLEND; (4) colours convert linear→sRGB through three's Color
// (matching GLTFLoader); (5) a full round-trip through openpbrToThree recovers the
// supported lobes.

import { describe, it, expect } from 'vitest';
import { Color, LinearSRGBColorSpace, SRGBColorSpace } from 'three';
import {
  gltfJsonMaterialToOpenpbr,
  materialHasPerMapUvTransform,
} from './gltfJsonMaterialToOpenpbr';
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

  it('seeds NULL maps when no texture tables are passed (clone-read oracle path)', () => {
    const ir = gltfJsonMaterialToOpenpbr({
      pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
    });
    expect(ir.maps.albedo).toBeNull(); // no tables → no capture
  });

  it('captures texture slots → imported descriptors (hash empty, gltfTexture index)', () => {
    const ir = gltfJsonMaterialToOpenpbr(
      {
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicRoughnessTexture: { index: 1 },
        },
        normalTexture: { index: 2 },
        occlusionTexture: { index: 3 },
        emissiveTexture: { index: 4 },
      },
      {
        textures: [{ sampler: 0 }, {}, {}, {}, {}],
        samplers: [{ wrapS: 33071, wrapT: 33071 }],
      },
    );
    // albedo + emissive are sRGB; the rest linear (glTF convention).
    expect(ir.maps.albedo).toEqual({
      hash: '',
      colorSpace: 'srgb',
      flipY: false,
      wrapS: 33071, // ClampToEdge from sampler 0
      wrapT: 33071,
      gltfTexture: 0,
    });
    expect(ir.maps.emissive?.colorSpace).toBe('srgb');
    expect(ir.maps.normal?.colorSpace).toBe('srgb-linear');
    expect(ir.maps.normal?.gltfTexture).toBe(2);
    expect(ir.maps.ao?.gltfTexture).toBe(3);
    // glTF packs roughness (G) + metalness (B) in ONE texture → SAME index.
    expect(ir.maps.roughness?.gltfTexture).toBe(1);
    expect(ir.maps.metalness?.gltfTexture).toBe(1);
    // No OPFS bytes — the descriptor's hash is empty (bytes ride in the .glb).
    expect(ir.maps.albedo?.hash).toBe('');
  });

  it('defaults sampler wrap to REPEAT (10497) when a texture declares no sampler', () => {
    const ir = gltfJsonMaterialToOpenpbr(
      { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
      { textures: [{}], samplers: [] },
    );
    expect(ir.maps.albedo?.wrapS).toBe(10497);
    expect(ir.maps.albedo?.wrapT).toBe(10497);
  });

  it('captures a non-default texCoord (UV set) but omits the default 0', () => {
    const ir = gltfJsonMaterialToOpenpbr(
      {
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0, texCoord: 1 },
          metallicRoughnessTexture: { index: 0, texCoord: 0 },
        },
      },
      { textures: [{}], samplers: [] },
    );
    expect(ir.maps.albedo?.gltfTexCoord).toBe(1);
    expect(ir.maps.roughness?.gltfTexCoord).toBeUndefined(); // default UV0 omitted
  });

  it('leaves untextured slots null (inherit) on a textured material', () => {
    const ir = gltfJsonMaterialToOpenpbr(
      { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
      { textures: [{}], samplers: [] },
    );
    expect(ir.maps.albedo).not.toBeNull();
    expect(ir.maps.normal).toBeNull();
    expect(ir.maps.emissive).toBeNull();
  });

  it('captures alphaMode:MASK → geometry.alphaCutoff (default 0.5, or the given cutoff)', () => {
    const def = gltfJsonMaterialToOpenpbr({ alphaMode: 'MASK' });
    expect(def.geometry.alphaCutoff).toBe(0.5); // glTF spec default
    const explicit = gltfJsonMaterialToOpenpbr({ alphaMode: 'MASK', alphaCutoff: 0.3 });
    expect(explicit.geometry.alphaCutoff).toBe(0.3);
    // OPAQUE/BLEND are NOT cutout — no alphaCutoff (stays a plain {opacity} lobe).
    expect(gltfJsonMaterialToOpenpbr({ alphaMode: 'OPAQUE' }).geometry.alphaCutoff).toBeUndefined();
    expect(
      gltfJsonMaterialToOpenpbr({ alphaMode: 'BLEND' }).geometry.alphaCutoff,
    ).toBeUndefined();
    // alphaCutoff round-trips to three.js alphaTest.
    expect(openpbrToThree(def).alphaTest).toBe(0.5);
    expect(openpbrToThree(gltfJsonMaterialToOpenpbr({})).alphaTest).toBe(0); // off by default
  });

  it('captures a primitive COLOR_0 flag → geometry.vertexColors', () => {
    const vc = gltfJsonMaterialToOpenpbr({}, undefined, { vertexColors: true });
    expect(vc.geometry.vertexColors).toBe(true);
    expect(openpbrToThree(vc).vertexColors).toBe(true);
    // absent COLOR_0 → no flag (native primitives never set it).
    expect(gltfJsonMaterialToOpenpbr({}).geometry.vertexColors).toBeUndefined();
    expect(openpbrToThree(gltfJsonMaterialToOpenpbr({})).vertexColors).toBe(false);
  });

  it('captures doubleSided → geometry.doubleSided (front-only by default)', () => {
    const ds = gltfJsonMaterialToOpenpbr({ doubleSided: true });
    expect(ds.geometry.doubleSided).toBe(true);
    expect(openpbrToThree(ds).doubleSided).toBe(true);
    expect(gltfJsonMaterialToOpenpbr({}).geometry.doubleSided).toBeUndefined();
    expect(openpbrToThree(gltfJsonMaterialToOpenpbr({})).doubleSided).toBe(false);
  });

  it('captures a uniform KHR_texture_transform into the shared uvTransform', () => {
    const xform = { offset: [0.1, 0.2], scale: [2, 3], rotation: 0.5 };
    const mat = {
      pbrMetallicRoughness: {
        baseColorTexture: { index: 0, extensions: { KHR_texture_transform: xform } },
        metallicRoughnessTexture: { index: 1, extensions: { KHR_texture_transform: xform } },
      },
    };
    const ir = gltfJsonMaterialToOpenpbr(mat);
    expect(ir.uvTransform).toEqual({ tiling: [2, 3], offset: [0.1, 0.2], rotation: 0.5 });
    expect(materialHasPerMapUvTransform(mat)).toBe(false); // shared → not per-map
  });

  it('leaves uvTransform IDENTITY when maps carry DIFFERING transforms (per-map case)', () => {
    const mat = {
      pbrMetallicRoughness: {
        baseColorTexture: { index: 0, extensions: { KHR_texture_transform: { scale: [2, 2] } } },
      },
      normalTexture: { index: 1, extensions: { KHR_texture_transform: { scale: [4, 4] } } },
    };
    const ir = gltfJsonMaterialToOpenpbr(mat);
    expect(ir.uvTransform).toEqual({ tiling: [1, 1], offset: [0, 0], rotation: 0 }); // identity
    expect(materialHasPerMapUvTransform(mat)).toBe(true);
  });

  it('a single transformed texture is uniform (not flagged per-map)', () => {
    const mat = {
      pbrMetallicRoughness: {
        baseColorTexture: { index: 0, extensions: { KHR_texture_transform: { scale: [2, 2] } } },
      },
    };
    expect(materialHasPerMapUvTransform(mat)).toBe(false);
    expect(gltfJsonMaterialToOpenpbr(mat).uvTransform.tiling).toEqual([2, 2]);
  });

  it('an untextured / untransformed material captures IDENTITY uvTransform', () => {
    expect(gltfJsonMaterialToOpenpbr({}).uvTransform).toEqual({
      tiling: [1, 1],
      offset: [0, 0],
      rotation: 0,
    });
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
