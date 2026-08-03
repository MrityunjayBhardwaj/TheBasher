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
// KHR_texture_transform is captured into the shared `uvTransform` when a material's
// maps agree, and PER SLOT into `mapUvTransforms` when they don't (#550) — absolute
// per-slot placements, never deltas over the shared one.
//
// REF: #178 (glTF materials → OpenPBR DAG); openpbrToThree.ts (forward adapter);
//      gltfMaterialToOpenpbr.ts (the clone-read SIBLING + round-trip oracle);
//      V53 (the IR invariant + the DIRECT-IMPORTABILITY GAP block).

import { Color, LinearSRGBColorSpace, SRGBColorSpace } from 'three';
import type {
  BakedTextureRef,
  InlineMaterialMaps,
  InlineMaterialSpec,
  UvPlacement,
} from '../../nodes/types';
import { NULL_MAPS, IDENTITY_UV_TRANSFORM, MAP_UV_SLOTS } from '../../nodes/materialSchema';

/** glTF default sampler wrap = REPEAT (10497) when a texture declares no sampler. */
const GLTF_WRAP_REPEAT = 10497;

/** A glTF KHR_texture_transform payload (offset/scale/rotation about the UV
 *  ORIGIN — three's GLTFLoader applies it with texture.center=[0,0]). */
interface GltfTextureTransform {
  offset?: number[];
  scale?: number[];
  rotation?: number;
  texCoord?: number;
}

/** A glTF textureInfo reference (`{ index, texCoord }`) on a material slot, with
 *  the optional KHR_texture_transform extension. */
interface GltfTextureInfo {
  index?: number;
  texCoord?: number;
  extensions?: { KHR_texture_transform?: GltfTextureTransform };
}

/** A normalized per-slot UV transform (identity = no KHR_texture_transform). */
interface UvSlotTransform {
  offset: [number, number];
  scale: [number, number];
  rotation: number;
}

const IDENTITY_SLOT_TRANSFORM: UvSlotTransform = { offset: [0, 0], scale: [1, 1], rotation: 0 };

/**
 * The glTF texture slot each IR map slot is captured from — the ONE place that
 * correspondence is stated. Both the map capture and the per-map UV placement
 * capture walk this table, so they cannot drift about which glTF field feeds
 * which IR slot; and because it is keyed by `keyof InlineMaterialMaps`, a seventh
 * IR map slot is a TYPE error here rather than a silently unread one.
 *
 * The mapping is not one-to-one in either direction: glTF packs roughness (G) and
 * metalness (B) into a single `metallicRoughnessTexture`, so two IR slots read one
 * glTF field, and `ao` reads `occlusionTexture`, whose name matches nothing.
 * Colorspaces follow the glTF convention — baseColor/emissive sRGB, the rest linear.
 */
const IR_SLOT_SOURCES: {
  readonly [K in keyof InlineMaterialMaps]: {
    readonly info: (mat: GltfJsonMaterial) => GltfTextureInfo | undefined;
    readonly colorSpace: BakedTextureRef['colorSpace'];
  };
} = {
  albedo: { info: (m) => m.pbrMetallicRoughness?.baseColorTexture, colorSpace: 'srgb' },
  normal: { info: (m) => m.normalTexture, colorSpace: 'srgb-linear' },
  roughness: {
    info: (m) => m.pbrMetallicRoughness?.metallicRoughnessTexture,
    colorSpace: 'srgb-linear',
  },
  metalness: {
    info: (m) => m.pbrMetallicRoughness?.metallicRoughnessTexture,
    colorSpace: 'srgb-linear',
  },
  emissive: { info: (m) => m.emissiveTexture, colorSpace: 'srgb' },
  ao: { info: (m) => m.occlusionTexture, colorSpace: 'srgb-linear' },
};

/** The normalized KHR_texture_transform for a present texture slot (identity when
 *  the slot has no transform); undefined when the slot is absent. */
function slotTransform(info: GltfTextureInfo | undefined): UvSlotTransform | undefined {
  if (!info || typeof info.index !== 'number') return undefined;
  const t = info.extensions?.KHR_texture_transform;
  if (!t) return IDENTITY_SLOT_TRANSFORM;
  return {
    offset: [num(t.offset?.[0], 0), num(t.offset?.[1], 0)],
    scale: [num(t.scale?.[0], 1), num(t.scale?.[1], 1)],
    rotation: num(t.rotation, 0),
  };
}

function slotTransformEq(a: UvSlotTransform, b: UvSlotTransform): boolean {
  return (
    a.offset[0] === b.offset[0] &&
    a.offset[1] === b.offset[1] &&
    a.scale[0] === b.scale[0] &&
    a.scale[1] === b.scale[1] &&
    a.rotation === b.rotation
  );
}

/** Every present texture slot's normalized transform, in IR slot order. */
function materialSlotTransforms(mat: GltfJsonMaterial): UvSlotTransform[] {
  return MAP_UV_SLOTS.map((slot) => slotTransform(IR_SLOT_SOURCES[slot].info(mat))).filter(
    (t): t is UvSlotTransform => t !== undefined,
  );
}

/** A normalized glTF slot transform → the IR's UV placement (`scale` is `tiling`).
 *  Arrays are COPIED: an untransformed slot normalizes to the shared
 *  IDENTITY_SLOT_TRANSFORM constant, whose arrays must never end up aliased into
 *  a material's IR. */
function toPlacement(t: UvSlotTransform): UvPlacement {
  return { tiling: [...t.scale], offset: [...t.offset], rotation: t.rotation };
}

/**
 * True iff a material's textures DON'T share one UV transform — the case the single
 * shared `uvTransform` can't represent. Each such slot carries its own placement in
 * `mapUvTransforms` instead (#550); the detector still names the material, because
 * capturing the values is not yet the same as applying or editing them.
 */
export function materialHasPerMapUvTransform(mat: GltfJsonMaterial): boolean {
  const slots = materialSlotTransforms(mat);
  return slots.length > 1 && !slots.every((s) => slotTransformEq(s, slots[0]));
}

/** Capture a material's KHR_texture_transform into the single shared IR uvTransform
 *  WHEN uniform across its textures (the common case); a per-map-differing material
 *  captures IDENTITY here and places every slot individually in `mapUvTransforms`,
 *  so nothing falls back to the shared value and this stays a no-op for the
 *  renderer (`applyGltfUvTransform` skips identity, leaving the clone's own
 *  per-map transforms exactly as they render today). */
function captureUvTransform(mat: GltfJsonMaterial): InlineMaterialSpec['uvTransform'] {
  const slots = materialSlotTransforms(mat);
  const t = slots[0];
  if (!t || !slots.every((s) => slotTransformEq(s, t))) {
    return {
      tiling: [...IDENTITY_UV_TRANSFORM.tiling],
      offset: [...IDENTITY_UV_TRANSFORM.offset],
      rotation: IDENTITY_UV_TRANSFORM.rotation,
    };
  }
  return toPlacement(t);
}

/**
 * Capture each present texture slot's OWN KHR_texture_transform (#550) — the data
 * `materialHasPerMapUvTransform` already computes and this converter used to throw
 * away. REPLACEMENT semantics: a listed slot uses its own absolute placement and
 * ignores the shared one, which is how both references model it (glTF stores the
 * transform per slot with no shared layer; Blender reuses one mapping node rather
 * than layering deltas). Every PRESENT slot is listed, including an untransformed
 * one at identity — a slot that fell back to the shared value would silently move
 * if the shared value were later edited.
 *
 * Returns `undefined` — not an empty object — for a uniform material, and the
 * caller must then omit the key entirely. `materialKeyOf` walks own enumerable
 * keys, so a materialised empty bag keys differently from an absent one and would
 * re-mint every already-imported material's identity (#550/H265).
 */
function capturePerMapUvTransforms(mat: GltfJsonMaterial): InlineMaterialSpec['mapUvTransforms'] {
  if (!materialHasPerMapUvTransform(mat)) return undefined;
  const out: { -readonly [K in keyof InlineMaterialMaps]?: UvPlacement } = {};
  for (const slot of MAP_UV_SLOTS) {
    const t = slotTransform(IR_SLOT_SOURCES[slot].info(mat));
    if (t) out[slot] = toPlacement(t);
  }
  return out;
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
  doubleSided?: boolean;
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

/** Build the 6 IR map slots from a material's texture references, through the ONE
 *  slot→glTF-field table above (so the roughness + metalness slots reference the
 *  SAME imported texture, and a slot cannot be captured from one field here and a
 *  different one when its UV placement is read). */
function captureMaps(mat: GltfJsonMaterial, tables: GltfTextureTables): InlineMaterialMaps {
  const out = {} as { -readonly [K in keyof InlineMaterialMaps]: BakedTextureRef | null };
  for (const slot of MAP_UV_SLOTS) {
    const src = IR_SLOT_SOURCES[slot];
    out[slot] = captureMap(src.info(mat), src.colorSpace, tables);
  }
  return out;
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
  // #550 — per-map placements, spread CONDITIONALLY. A uniform material must not
  // gain the key at all: `materialKeyOf` walks own enumerable keys, so spreading
  // `undefined` in unconditionally would re-key every material (H265).
  const perMap = capturePerMapUvTransforms(mat);
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
      // doubleSided → render both faces; captured so the DAG can override `side`.
      ...(mat.doubleSided ? { doubleSided: true } : {}),
    },
    // Capture imported-texture descriptors when the JSON texture tables are
    // available (import path); fall back to NULL_MAPS for the clone-read oracle.
    maps: tables ? captureMaps(mat, tables) : { ...NULL_MAPS },
    // KHR_texture_transform → the single shared uvTransform (uniform case); a
    // per-map-differing material captures identity here and places each slot
    // individually below, since one shared placement cannot express them.
    uvTransform: captureUvTransform(mat),
    ...(perMap ? { mapUvTransforms: perMap } : {}),
  };
}
