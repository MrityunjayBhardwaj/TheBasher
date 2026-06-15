// gltfJsonMaterialToOpenpbr — capture a glTF 2.0 JSON material → the OpenPBR
// inline IR (InlineMaterialSpec), at IMPORT time (issue #178, S2). This is the
// PRODUCER-side path (V34): the importer builds the DAG, so materials enter the
// graph here from `json.materials[]`, not from the rendered three.js clone. The
// renderer then reads the DAG material (S3) instead of the clone's embedded one,
// and the inspector edits it like a native Box/Sphere material (S4).
//
// COLOURSPACE: glTF baseColorFactor / emissiveFactor are LINEAR; OpenPBR base/
// emission colours are sRGB hex (what openpbrToThree feeds three as sRGB). We
// convert through three's own `Color` (linear working space → sRGB hex) so the
// captured colour matches exactly what GLTFLoader would display — the parity the
// Option-A choice rests on.
//
// SCOPE: core metallic-roughness + the common KHR scalar extensions (ior,
// clearcoat, transmission, emissive_strength). Texture MAPS are deferred (later
// slice; IR map slots seed null and the renderer keeps the clone's textures).
// KHR_materials_unlit is captured as core for now (flat-shading nuance deferred).
//
// REF: #178 (glTF materials → OpenPBR DAG); openpbrToThree.ts (forward adapter);
//      gltfMaterialToOpenpbr.ts (the clone-read SIBLING + round-trip oracle).

import { Color, LinearSRGBColorSpace, SRGBColorSpace } from 'three';
import type { InlineMaterialSpec } from '../../nodes/types';
import { NULL_MAPS, IDENTITY_UV_TRANSFORM } from '../../nodes/materialSchema';

/** A glTF 2.0 material object as it appears in `json.materials[]` (partial, the
 *  fields we read). Everything optional — defaults match the glTF spec. */
export interface GltfJsonMaterial {
  name?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    metallicFactor?: number;
    roughnessFactor?: number;
  };
  emissiveFactor?: number[];
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  extensions?: Record<string, { [k: string]: unknown } | undefined>;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** glTF linear RGB → sRGB hex, through three's Color (matches GLTFLoader). */
function linearRgbToSrgbHex(rgb: number[] | undefined, fallback: [number, number, number]): string {
  const [r, g, b] = Array.isArray(rgb) && rgb.length >= 3 ? rgb : fallback;
  const c = new Color();
  c.setRGB(num(r, fallback[0]), num(g, fallback[1]), num(b, fallback[2]), LinearSRGBColorSpace);
  return `#${c.getHexString(SRGBColorSpace)}`;
}

/**
 * Compile one glTF JSON material → the OpenPBR inline IR. The inverse of the
 * glTF-spec defaults openpbrToThree expects: baseColorFactor→base.color (+ alpha→
 * opacity for BLEND), metallicFactor→base.metalness (default 1), roughnessFactor→
 * specular.roughness (default 1), KHR ior/clearcoat/transmission→the matching
 * lobes, emissiveFactor→emission.color, emissive_strength→emission.luminance.
 */
export function gltfJsonMaterialToOpenpbr(mat: GltfJsonMaterial): InlineMaterialSpec {
  const pbr = mat.pbrMetallicRoughness ?? {};
  const ext = mat.extensions ?? {};
  const ior = ext.KHR_materials_ior as { ior?: number } | undefined;
  const coat = ext.KHR_materials_clearcoat as
    | { clearcoatFactor?: number; clearcoatRoughnessFactor?: number }
    | undefined;
  const transmission = ext.KHR_materials_transmission as
    | { transmissionFactor?: number }
    | undefined;
  const emissiveStrength = ext.KHR_materials_emissive_strength as
    | { emissiveStrength?: number }
    | undefined;
  // baseColorFactor alpha drives opacity ONLY for alphaMode BLEND (OPAQUE/MASK
  // render fully opaque in three's metallic-roughness path).
  const bcf = pbr.baseColorFactor;
  const opacity = mat.alphaMode === 'BLEND' ? num(bcf?.[3], 1) : 1;
  return {
    name: mat.name || 'default',
    base: {
      color: linearRgbToSrgbHex(bcf, [1, 1, 1]),
      metalness: num(pbr.metallicFactor, 1),
    },
    specular: { roughness: num(pbr.roughnessFactor, 1), ior: num(ior?.ior, 1.5) },
    coat: {
      weight: num(coat?.clearcoatFactor, 0),
      roughness: num(coat?.clearcoatRoughnessFactor, 0),
    },
    transmission: { weight: num(transmission?.transmissionFactor, 0) },
    emission: {
      color: linearRgbToSrgbHex(mat.emissiveFactor, [0, 0, 0]),
      luminance: num(emissiveStrength?.emissiveStrength, 1),
    },
    geometry: { opacity },
    maps: { ...NULL_MAPS },
    uvTransform: {
      tiling: [...IDENTITY_UV_TRANSFORM.tiling],
      offset: [...IDENTITY_UV_TRANSFORM.offset],
      rotation: IDENTITY_UV_TRANSFORM.rotation,
    },
  };
}
