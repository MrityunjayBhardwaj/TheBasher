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

import type {
  BakedTextureRef,
  InlineMaterialMaps,
  InlineMaterialSpec,
  UvPlacement,
} from '../../nodes/types';
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
export interface ThreeMaterialMaps {
  readonly map: BakedTextureRef | null;
  readonly normalMap: BakedTextureRef | null;
  readonly roughnessMap: BakedTextureRef | null;
  readonly metalnessMap: BakedTextureRef | null;
  readonly emissiveMap: BakedTextureRef | null;
  readonly aoMap: BakedTextureRef | null;
}

/** A per-slot UV placement bag in THREE's slot vocabulary (the compile output's). */
export type ThreeMapUvTransforms = SlotPlacements<keyof ThreeMaterialMaps>;

/**
 * The IR slot → three.js slot correspondence, stated ONCE for this whole compile
 * target and consumed by everything that needs it (the map handles and the per-map
 * placements). Keyed by `keyof InlineMaterialMaps`, so a seventh IR slot is a TYPE
 * error here rather than a slot that silently never reaches a texture.
 *
 * Both apply roads name their slots in THREE's vocabulary, so this is the only
 * place the two vocabularies meet. A second copy in the registry and a third in the
 * glTF overlay is exactly the shape that already cost this issue one bug at the
 * import end (six IR slots over five glTF texture fields).
 */
export const THREE_SLOT_OF: {
  readonly [K in keyof InlineMaterialMaps]: keyof ThreeMaterialMaps;
} = {
  albedo: 'map',
  normal: 'normalMap',
  roughness: 'roughnessMap',
  metalness: 'metalnessMap',
  emissive: 'emissiveMap',
  ao: 'aoMap',
};

const IR_MAP_SLOTS = Object.keys(THREE_SLOT_OF) as (keyof InlineMaterialMaps)[];

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
  // three needs `transparent` for BOTH a transmissive lobe AND a <1 opacity.
  const transparent = transmission > 0 || opacity < 1;
  return {
    color: ir.base.color,
    metalness: ir.base.metalness,
    roughness: ir.specular.roughness,
    ior: ir.specular.ior,
    clearcoat: ir.coat.weight,
    clearcoatRoughness: ir.coat.roughness,
    transmission,
    thickness: transmission > 0 ? DEFAULT_TRANSMISSION_THICKNESS : 0,
    emissive: ir.emission.color,
    emissiveIntensity: ir.emission.luminance * EMISSION_NIT_TO_INTENSITY,
    opacity,
    transparent,
    alphaTest: ir.geometry.alphaCutoff ?? 0,
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
  };
  // NOTE: ir.unsupported is intentionally NOT read — those lobes have no WebGL
  // MeshPhysical representation (v0.7 TSL backend renders them).
}

/** The map handles, re-keyed into THREE's vocabulary through {@link THREE_SLOT_OF}. */
function threeMaps(maps: InlineMaterialMaps): ThreeMaterialMaps {
  const out = {} as Record<keyof ThreeMaterialMaps, BakedTextureRef | null>;
  for (const slot of IR_MAP_SLOTS) out[THREE_SLOT_OF[slot]] = maps[slot];
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
  for (const slot of IR_MAP_SLOTS) {
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
  for (const slot of IR_MAP_SLOTS) {
    const layer = perMap[slot];
    if (layer) out[THREE_SLOT_OF[slot]] = layer;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
