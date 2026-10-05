// openpbrToThree — the ONE adapter compiling the OpenPBR inline-material IR
// (InlineMaterialSpec, src/nodes/types.ts) → three.js MeshPhysicalMaterial
// parameters on the classic WebGLRenderer (v0.6 #2, #178, D-01/D-02).
//
// SIMPLE interface, DEEP implementation (Ousterhout): callers pass the IR and
// get a flat three.js param bag. The name-mapping, the transmission auto-set,
// the unit-lossy emission constant, and the unsupported-lobe drop all live
// INSIDE here — never inlined in a renderer (the V29 N×M drift guard). W2's leaf
// builder and W6's glTF merge are the only consumers.
//
// [[V32]] — the IR is renderer-agnostic; THIS module is the WebGL compile target.
// The WGSL/TSL backend (v0.7) is a sibling compiler over the SAME IR.
//
// REF: CONTEXT D-03 (core-10 table); PLAN W1 (1.5); vyapti V29/V32; #178.

import { MATERIAL_MAP_SLOT_TABLE } from '../../nodes/types';
import type {
  BakedMaterialMaps,
  BakedTextureRef,
  InlineMaterialMaps,
  InlineMaterialSpec,
  IrMapSlot,
  UvPlacement,
} from '../../nodes/types';
import { MAP_UV_SLOTS } from '../../nodes/materialSchema';
import type { SlotPlacements } from './uvPlacement';

/**
 * OpenPBR emission is photometric (cd/m²). The classic WebGL MeshPhysicalMaterial
 * has only a unitless `emissiveIntensity` multiplier, so we use luminance 1:1 as
 * that multiplier. This is unit-lossy BY INTENT — the real-time importer
 * convention (matches three's USD-loader OpenPBR import). The v0.7 TSL backend
 * re-derives true photometric emission. NOT a TODO; the value is 1.0.
 */
export const EMISSION_NIT_TO_INTENSITY = 1.0;

/**
 * three.js `thickness` for a transmissive material. transmission only refracts
 * when thickness > 0; OpenPBR transmission_weight carries no thickness, so we
 * seed a sensible default when transmission is active. (v0.7 exposes thickness.)
 */
export const DEFAULT_TRANSMISSION_THICKNESS = 0.5;

/** The three.js map slots openpbrToThree emits (BakedTextureRef handle or null). */
export type ThreeMaterialMaps = BakedMaterialMaps;

/** A per-slot UV placement bag in THREE's slot vocabulary (the compile output's). */
export type ThreeMapUvTransforms = SlotPlacements<keyof ThreeMaterialMaps>;

/**
 * The IR slot → three.js slot correspondence, consumed by everything on this compile target that
 * needs it (the map handles and the per-map placements). READ OFF the slot table (#1324), which is
 * the one place the two vocabularies meet; a second copy in the registry and a third in the glTF
 * overlay is exactly the shape that already cost one bug at the import end (six IR slots over five
 * glTF texture fields).
 */
export const THREE_SLOT_OF = Object.fromEntries(
  MAP_UV_SLOTS.map((slot) => [slot, MATERIAL_MAP_SLOT_TABLE[slot].three]),
) as { readonly [K in IrMapSlot]: (typeof MATERIAL_MAP_SLOT_TABLE)[K]['three'] };

/** Flat three.js MeshPhysicalMaterial parameter bag (the compile output). */
export interface ThreeMaterialParams {
  readonly color: string;
  readonly roughness: number;
  readonly metalness: number;
  readonly opacity: number;
  readonly transparent: boolean;
  /** alphaTest threshold (glTF direct-import alphaMode:'MASK' → cutout). 0 = off
   *  (three's default). Captured from `geometry.alphaCutoff` so editing it
   *  changes the render; identity for an unedited import (matches the clone). */
  readonly alphaTest: number;
  /**
   * #1435 — the alpha drawn as a hashed cutout: the IR's `geometry.renderMethod: 'dithered'`.
   * Present only as `true`, never `false`, for the reason `mapUvTransforms` gives: this object
   * flows into a generic content walk, and a materialised default re-keys every material.
   */
  readonly alphaHash?: true;
  /**
   * #1062 — the NAME of the colour layer this material reads, absent when it reads none.
   *
   * 🔴 A NAME AND NOT three's `vertexColors` BOOLEAN, although this is three's vocabulary
   * everywhere else, because the boolean cannot be answered here. "Draw per-vertex colour"
   * is only true of a material TOGETHER WITH a mesh that carries that layer, and this
   * compile sees no mesh. Each road reduces the name to the flag at its own boundary, with
   * the geometry in hand: the native road resolves it against the drawn mesh's ordered layer
   * list (`cornerLayerNames.ts`), and the file's-copy road — whose geometry has no layer
   * list — asks only whether a colour was requested at all.
   */
  readonly colorLayer?: string;
  /** Render both faces (glTF `doubleSided`). Captured from
   *  `geometry.doubleSided`; false (front-only) by default. The renderer maps
   *  this to three `side` (DoubleSide / FrontSide) — kept boolean here so this
   *  module stays THREE-free (V32). */
  readonly doubleSided: boolean;
  readonly emissive: string;
  readonly emissiveIntensity: number;
  readonly ior: number;
  readonly clearcoat: number;
  readonly clearcoatRoughness: number;
  readonly transmission: number;
  readonly thickness: number;
  readonly maps: ThreeMaterialMaps;
  /**
   * v0.6 #3 (#181) — the ONE shared UV placement applied to every loaded map
   * texture: repeat=tiling, offset, rotation (about center [.5,.5]). IDENTITY
   * (tiling [1,1] / offset [0,0] / rotation 0) = no-op. The renderer clones each
   * texture before applying (A-5: textures are shared by hash; mutating a shared
   * instance would cross-contaminate other materials).
   */
  readonly uvTransform: {
    readonly tiling: readonly [number, number];
    readonly offset: readonly [number, number];
    readonly rotation: number;
  };
  /**
   * #550 — the IR's per-map placements, translated into THREE's slot vocabulary so
   * both apply roads read one spelling. A slot listed here uses its own placement
   * INSTEAD of {@link uvTransform}; a slot not listed uses the shared one.
   * REPLACEMENT, never composition (the family is not closed under it).
   *
   * 🔴 The key is ABSENT — not `undefined` — when the IR carries no per-map entries.
   * It flows into `PrimitiveMaterialSpec`, whose content key is a GENERIC walk over
   * own enumerable keys, so a materialised empty bag would re-key every existing
   * material and re-mint the whole GPU cache on first load. Same trap as at the IR
   * tier; same answer: absent means absent.
   */
  readonly mapUvTransforms?: ThreeMapUvTransforms;
  /**
   * #1062 — the UV LAYER each map samples, re-keyed into THREE's slot vocabulary so both
   * apply roads read one spelling, exactly as {@link mapUvTransforms} is. A slot not listed
   * names no layer, which means "sample the first UV buffer" — three's own default.
   *
   * Names, not channel numbers, and for the same reason {@link colorLayer} is a name: the
   * channel is only knowable against the drawn mesh's layer list, which this compile has no
   * access to. Absent rather than empty, same trap, same answer.
   */
  readonly mapUvLayers?: ThreeMapUvLayers;
  /**
   * #1123 — the normal map's strength, the IR's `mapStrengths.normal`. A STRENGTH, not three's
   * signed `normalScale` vector: which way y points depends on the texture as uploaded, which only
   * the builder holds (`normalScaleFor`, #1325). Absent means 1, and absent rather than 1, same trap.
   */
  readonly normalScale?: number;
  /** #1123 — the occlusion map's strength (three's `aoMapIntensity`). Absent means 1. */
  readonly aoMapIntensity?: number;
  /** #1327 — the coat normal map's strength (unsigned; see `normalScale`). Absent means 1. */
  readonly clearcoatNormalScale?: number;
  /** #1123 — `'basic'`: build an unlit material. Absent means lit. */
  readonly materialClass?: 'basic';
  /** #1123 — the fuzz lobe as three's sheen (weight, sRGB hex colour, roughness). Absent: none. */
  readonly sheen?: number;
  readonly sheenColor?: string;
  readonly sheenRoughness?: number;
  /** #1321 — the specular lobe's weight and colour (sRGB hex). Absent: three's 1 and white. */
  readonly specularIntensity?: number;
  readonly specularColor?: string;
  /**
   * #1322 — Beer's-law absorption: three's `attenuationDistance` / `attenuationColor`, from the
   * transmission lobe's depth and colour. Both absent unless a depth is set (a colour alone is
   * OpenPBR's tint, which three has no way to draw).
   */
  readonly attenuationDistance?: number;
  readonly attenuationColor?: string;
}

/** The UV layer a map slot samples, in THREE's slot vocabulary. */
export type ThreeMapUvLayers = { readonly [K in keyof ThreeMaterialMaps]?: string };

/**
 * Compile the OpenPBR IR to three.js MeshPhysicalMaterial params. Pure / sync.
 * Emits ONLY the WebGL-supported subset; the `unsupported` lobes on the IR are
 * dropped here (rendered by the v0.7 TSL backend, not now).
 */
export function openpbrToThree(ir: InlineMaterialSpec): ThreeMaterialParams {
  const perMap = threeMapUvTransforms(ir.mapUvTransforms);
  const perMapLayers = threeMapUvLayers(ir.mapUvLayers);
  const transmission = ir.transmission.weight;
  const opacity = ir.geometry.opacity;
  // #1435 — how the alpha (opacity times the base map's alpha, which three multiplies in itself)
  // is drawn. three needs `transparent` for a transmissive lobe, for a surface the IR says is
  // blended, and for a <1 opacity unless the IR says dithered, which draws it hashed instead.
  const method = ir.geometry.renderMethod;
  const transparent =
    transmission > 0 || method === 'blended' || (opacity < 1 && method !== 'dithered');
  return {
    color: ir.base.color,
    metalness: ir.base.metalness,
    roughness: ir.specular.roughness,
    ior: ir.specular.ior,
    clearcoat: ir.coat.weight,
    clearcoatRoughness: ir.coat.roughness,
    transmission,
    // #1322 — a file's volume thickness when it gives one; the default otherwise.
    thickness: transmission > 0 ? (ir.geometry.thickness ?? DEFAULT_TRANSMISSION_THICKNESS) : 0,
    emissive: ir.emission.color,
    emissiveIntensity: ir.emission.luminance * EMISSION_NIT_TO_INTENSITY,
    opacity,
    transparent,
    alphaTest: ir.geometry.alphaCutoff ?? 0,
    // #1435 — omitted unless dithered, for the omission rule below.
    ...(method === 'dithered' ? { alphaHash: true as const } : {}),
    // #1062 — WHICH layer is asked for, carried through rather than reduced to a flag here.
    // OMITTED, never `undefined`, for the reason `mapUvTransforms` gives below: this object
    // flows into a generic content walk, and a materialised absent key re-keys every material.
    ...(ir.geometry.colorLayer !== undefined ? { colorLayer: ir.geometry.colorLayer } : {}),
    // #1062 — and which UV layer each map samples. Same omission rule, same reason.
    ...(perMapLayers ? { mapUvLayers: perMapLayers } : {}),
    doubleSided: ir.geometry.doubleSided ?? false,
    maps: threeMaps(ir.maps),
    uvTransform: ir.uvTransform, // v0.6 #3 — pass through; the renderer applies it
    // #550 — the key is OMITTED, not set to undefined, when there is nothing per-map.
    ...(perMap ? { mapUvTransforms: perMap } : {}),
    // #1123 — the two map strengths, each omitted at its default for the same reason.
    ...(ir.mapStrengths?.normal !== undefined ? { normalScale: ir.mapStrengths.normal } : {}),
    ...(ir.mapStrengths?.ao !== undefined ? { aoMapIntensity: ir.mapStrengths.ao } : {}),
    ...(ir.mapStrengths?.coatNormal !== undefined
      ? { clearcoatNormalScale: ir.mapStrengths.coatNormal }
      : {}),
    // #1123 — unlit; omitted when lit, same reason.
    ...(ir.unlit ? { materialClass: 'basic' as const } : {}),
    // #1123 — fuzz → three's sheen, omitted without a lobe.
    ...(ir.fuzz ? { sheen: ir.fuzz.weight } : {}),
    ...(ir.fuzz ? { sheenColor: ir.fuzz.color } : {}),
    ...(ir.fuzz ? { sheenRoughness: ir.fuzz.roughness } : {}),
    // #1321 — omitted at OpenPBR's default, which is three's too.
    ...(ir.specular.weight !== undefined ? { specularIntensity: ir.specular.weight } : {}),
    ...(ir.specular.color !== undefined ? { specularColor: ir.specular.color } : {}),
    // #1322 — absorption only with a depth.
    ...(ir.transmission.depth !== undefined && ir.transmission.depth > 0
      ? { attenuationDistance: ir.transmission.depth }
      : {}),
    ...(ir.transmission.depth !== undefined && ir.transmission.depth > 0
      ? { attenuationColor: ir.transmission.color ?? '#ffffff' }
      : {}),
  };
  // NOTE: ir.unsupported is intentionally NOT read — those lobes have no WebGL
  // MeshPhysical representation (v0.7 TSL backend renders them).
}

/** The map handles, re-keyed into THREE's vocabulary through {@link THREE_SLOT_OF}. */
function threeMaps(maps: InlineMaterialMaps): ThreeMaterialMaps {
  const out = {} as Record<keyof ThreeMaterialMaps, BakedTextureRef | null>;
  for (const slot of MAP_UV_SLOTS) {
    // An unseeded slot the IR does not hold stays absent here too (#1324).
    const ref = maps[slot];
    if (ref !== undefined) out[THREE_SLOT_OF[slot]] = ref;
  }
  return out;
}

/**
 * The per-map placements, re-keyed the same way. Returns `undefined` — so the caller
 * can OMIT the field — both when the IR has no bag and when the bag is empty: an
 * empty bag is the same absence one representation later, and materialising it would
 * re-key every existing material (see {@link ThreeMaterialParams.mapUvTransforms}).
 */
export function threeMapUvTransforms(
  perMap: InlineMaterialSpec['mapUvTransforms'],
): ThreeMapUvTransforms | undefined {
  if (!perMap) return undefined;
  // `-readonly` because a mapped type over ThreeMaterialMaps inherits its readonly
  // modifiers; this is the local builder, and the RETURNED type is readonly again.
  const out: { -readonly [K in keyof ThreeMaterialMaps]?: UvPlacement } = {};
  for (const slot of MAP_UV_SLOTS) {
    const placement = perMap[slot];
    if (placement) out[THREE_SLOT_OF[slot]] = placement;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * #1062 — the per-map UV LAYER NAMES, re-keyed the same way and absent on the same terms
 * as {@link threeMapUvTransforms}. Split from that function rather than folded into it
 * because the two bags are independent on the IR: a slot may name a layer and carry no
 * placement, or the reverse, and merging them here would invent an entry for whichever
 * half was missing.
 */
export function threeMapUvLayers(
  perMap: InlineMaterialSpec['mapUvLayers'],
): ThreeMapUvLayers | undefined {
  if (!perMap) return undefined;
  const out: { -readonly [K in keyof ThreeMaterialMaps]?: string } = {};
  for (const slot of MAP_UV_SLOTS) {
    const layer = perMap[slot];
    if (layer) out[THREE_SLOT_OF[slot]] = layer;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
