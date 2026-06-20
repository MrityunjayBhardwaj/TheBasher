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
// clearcoat, transmission, emissive_strength) + TEXTURE MAPS (the direct-import
// milestone, V53). Maps are captured as "imported descriptors" (the LIGHTER
// persistence path: gltfTexture index + colorspace + flipY + texCoord + wrap, but
// hash empty — the bytes ride in the embedded `.glb`, V41). The renderer LEAVES
// the clone's textures in place for these (inherit), so the captured descriptor
// only makes the slot inspector-visible + DAG-addressable; render is byte-
// identical. KHR_materials_unlit is captured as core (flat-shading nuance deferred).
//
// REF: #178 (glTF materials → OpenPBR DAG); openpbrToThree.ts (forward adapter);
//      gltfMaterialToOpenpbr.ts (the clone-read SIBLING + round-trip oracle);
//      V53 (the IR invariant + the DIRECT-IMPORTABILITY GAP block).

import { Color, LinearSRGBColorSpace, SRGBColorSpace } from 'three';
import type { BakedTextureRef, InlineMaterialMaps, InlineMaterialSpec } from '../../nodes/types';
import { NULL_MAPS, IDENTITY_UV_TRANSFORM } from '../../nodes/materialSchema';

/** glTF default sampler wrap = REPEAT (10497) when a texture declares no sampler. */
const GLTF_WRAP_REPEAT = 10497;

/** A glTF textureInfo reference (`{ index, texCoord }`) on a material slot. */
interface GltfTextureInfo {
  index?: number;
  texCoord?: number;
}

/** A glTF 2.0 material object as it appears in `json.materials[]` (partial, the
 *  fields we read). Everything optional — defaults match the glTF spec. */
export interface GltfJsonMaterial {
  name?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    metallicFactor?: number;
    roughnessFactor?: number;
    baseColorTexture?: GltfTextureInfo;
    metallicRoughnessTexture?: GltfTextureInfo;
  };
  emissiveFactor?: number[];
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  alphaCutoff?: number;
  normalTexture?: GltfTextureInfo;
  occlusionTexture?: GltfTextureInfo;
  emissiveTexture?: GltfTextureInfo;
  extensions?: Record<string, { [k: string]: unknown } | undefined>;
}

/** The glTF JSON texture/sampler tables a material's texture slots index into.
 *  Passed at capture time (gltfImportChain) so the converter can resolve a
 *  material's `*Texture.index` → a captured-import descriptor. Absent → the
 *  converter seeds NULL_MAPS (the pre-milestone behaviour, e.g. a clone-read
 *  round-trip oracle that has no JSON tables). */
export interface GltfTextureTables {
  textures?: { sampler?: number }[];
  samplers?: { wrapS?: number; wrapT?: number }[];
}

/**
 * Capture ONE glTF material texture slot → an imported-texture descriptor
 * (BakedTextureRef with empty hash + the glTF texture index). Returns null when
 * the slot is absent — null = "inherit the clone's texture" (the slot stays
 * empty for an untextured material). The descriptor's `hash` is EMPTY: the bytes
 * ride in the embedded `.glb` (V41, the lighter path), so this never references
 * an OPFS file; `collectAssetRefs` skips it and the renderer leaves the clone's
 * texture in place.
 */
function captureMap(
  info: GltfTextureInfo | undefined,
  colorSpace: BakedTextureRef['colorSpace'],
  tables: GltfTextureTables,
): BakedTextureRef | null {
  if (!info || typeof info.index !== 'number') return null;
  const tex = tables.textures?.[info.index];
  const sampler = typeof tex?.sampler === 'number' ? tables.samplers?.[tex.sampler] : undefined;
  const ref: BakedTextureRef = {
    hash: '', // lighter path — bytes ride in the embedded .glb (V41), not OPFS
    colorSpace,
    flipY: false, // glTF textures are always flipY=false
    wrapS: sampler?.wrapS ?? GLTF_WRAP_REPEAT,
    wrapT: sampler?.wrapT ?? GLTF_WRAP_REPEAT,
    gltfTexture: info.index,
  };
  // texCoord captured (no silent drop of the UV set) only when non-default; the
  // UV1+ APPLY is a later slice — the clone already binds the right set.
  return typeof info.texCoord === 'number' && info.texCoord !== 0
    ? { ...ref, gltfTexCoord: info.texCoord }
    : ref;
}

/** Build the 6 IR map slots from a material's texture references. glTF packs
 *  roughness (G) + metalness (B) in ONE metallicRoughnessTexture, so the
 *  roughness + metalness slots reference the SAME imported texture. Colorspaces
 *  follow the glTF convention: baseColor/emissive = srgb, the rest = linear. */
function captureMaps(mat: GltfJsonMaterial, tables: GltfTextureTables): InlineMaterialMaps {
  const pbr = mat.pbrMetallicRoughness ?? {};
  return {
    albedo: captureMap(pbr.baseColorTexture, 'srgb', tables),
    normal: captureMap(mat.normalTexture, 'srgb-linear', tables),
    roughness: captureMap(pbr.metallicRoughnessTexture, 'srgb-linear', tables),
    metalness: captureMap(pbr.metallicRoughnessTexture, 'srgb-linear', tables),
    emissive: captureMap(mat.emissiveTexture, 'srgb', tables),
    ao: captureMap(mat.occlusionTexture, 'srgb-linear', tables),
  };
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
/** Per-PRIMITIVE capture context (vs the asset-level texture tables). glTF vertex
 *  colours live on a primitive's `COLOR_0` attribute, not on the material JSON, so
 *  `captureChildMaterials` detects them and passes the flag here. */
export interface GltfPrimitiveContext {
  vertexColors?: boolean;
}

export function gltfJsonMaterialToOpenpbr(
  mat: GltfJsonMaterial,
  tables?: GltfTextureTables,
  prim?: GltfPrimitiveContext,
): InlineMaterialSpec {
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
    geometry: {
      opacity,
      // alphaMode:'MASK' → the alphaTest cutoff (glTF default 0.5). The clone
      // already renders cutout; capturing makes it DAG-addressable + editable.
      ...(mat.alphaMode === 'MASK' ? { alphaCutoff: num(mat.alphaCutoff, 0.5) } : {}),
      // COLOR_0 → vertex colours captured for representation (clone renders it).
      ...(prim?.vertexColors ? { vertexColors: true } : {}),
    },
    // Capture imported-texture descriptors when the JSON texture tables are
    // available (import path); fall back to NULL_MAPS for the clone-read oracle.
    maps: tables ? captureMaps(mat, tables) : { ...NULL_MAPS },
    uvTransform: {
      tiling: [...IDENTITY_UV_TRANSFORM.tiling],
      offset: [...IDENTITY_UV_TRANSFORM.offset],
      rotation: IDENTITY_UV_TRANSFORM.rotation,
    },
  };
}
