// materialOverrideMerge — the pure decision layer for #99 (P7.13).
//
// When a `MaterialOverride` is wired upstream of a `GltfAsset`, the renderer
// must NOT replace the imported material wholesale (that drops .map / normalMap
// / roughnessMap / metalnessMap / aoMap / emissiveMap and downgrades a
// MeshPhysicalMaterial — KHR clearcoat/transmission/sheen — to a plain
// MeshStandardMaterial). Instead it clones the source material (which preserves
// all maps + the subclass) and overlays ONLY the override fields that cannot
// corrupt richer source data.
//
// The cut (D-01 "map-aware tint"):
//   - color / emissive / emissiveIntensity / opacity  → ALWAYS applied.
//     `color` multiplies a preserved `.map` ⇒ a tint; `emissive` multiplies any
//     `emissiveMap` ⇒ still a meaningful tint; `opacity` is independent.
//   - roughness / metalness → applied ONLY when the source has no corresponding
//     map. In three.js these scalars MULTIPLY their maps (roughness×roughnessMap,
//     metalness×metalnessMap), so forcing a default (0.5 / 0) onto a mapped PBR
//     channel attenuates the map — a fidelity loss. With no map the scalar IS the
//     value (identical to a procedural BoxMesh/SphereMesh).
//
// This mirrors Blender's shader-node semantics: a connected input socket's value
// widget is ignored (the texture drives the channel); the scalar applies only
// when nothing is connected. REF: docs.blender.org Principled BSDF + T79489;
// three.js MeshStandardMaterial.copy (src/materials/MeshStandardMaterial.js:76-104).
//
// PURE — no three.js objects, no React, no state. The effect in
// `SceneFromDAG.tsx` GltfAssetR consumes this, clones `source.clone()`, and sets
// the returned fields onto the clone. It must NEVER touch a map reference: maps
// survive via clone(), not via this helper.

import type { MaterialValue } from '../nodes/types';

/** Which scalar-channel maps the SOURCE (imported) material already carries. */
export interface MaterialMapPresence {
  readonly roughnessMap: boolean;
  readonly metalnessMap: boolean;
}

/**
 * The exact fields to write onto the cloned material. A `null` scalar means
 * "leave the source value untouched" — the source owns that channel via its map.
 * Map references are intentionally absent: they survive the clone, never set here.
 */
export interface MaterialOverrideFields {
  readonly color: string;
  readonly roughness: number | null;
  readonly metalness: number | null;
  readonly opacity: number;
  readonly emissive: string;
  readonly emissiveIntensity: number;
  readonly transparent: boolean;
}

/**
 * D-01 map-aware tint. Given the override material spec and the source material's
 * map presence, return only the fields the renderer should overlay onto a clone.
 */
export function resolveMaterialOverrideFields(
  override: MaterialValue,
  maps: MaterialMapPresence,
): MaterialOverrideFields {
  return {
    color: override.color,
    // Scalar channels multiply their maps — overlay only where no map defends the channel.
    roughness: maps.roughnessMap ? null : override.roughness,
    metalness: maps.metalnessMap ? null : override.metalness,
    opacity: override.opacity,
    emissive: override.emissive,
    emissiveIntensity: override.emissiveIntensity,
    transparent: override.opacity < 1,
  };
}
