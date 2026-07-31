// materialOverrideMerge — THE pure decision layer for compositing a
// `MaterialOverride` onto a source material (#99, P7.13).
//
// This module answers ONE question — "which of the override's scalars may be
// written over this source, and which does the source own?" — and it is the only
// place that answers it. Representations differ (an OpenPBR IR, a captured baked
// spec, a cloned three.js material); the DECISION does not. `composeMaterial.ts`
// is the IR-shaped adapter over this rule; see its header for the split.
//
// MOVED here from `src/viewport/` at #394 S3b. It was never viewport-specific —
// it is pure — but the renderer was its only consumer. The material operator lane
// (`src/nodes`) is now a second consumer, and `src/nodes → src/app` is the legal
// direction (`BoxData.ts:19`, `ArrayModifier.ts:43`), `src/nodes → src/viewport`
// is not.
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
//
// The `maps` argument is MAP PRESENCE, not the maps themselves — deliberately, so
// each representation can answer it in its own vocabulary (a three.js material asks
// `.roughnessMap !== null`, an IR asks `maps.roughness !== null`, a baked spec asks
// `roughnessMap !== null`) while the rule stays one function. That is what makes
// this rule shareable across representations at all.

import type { MaterialOverrideField, MaterialValue } from '../../nodes/types';
import { isOverridden, type OverriddenSet } from '../../core/override/overrideSet';

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
 * D-01 map-aware tint + #124 per-field force (V28). Given the override material
 * spec, the source's map presence, and the explicit per-field authored set,
 * return only the fields the renderer should overlay onto a clone.
 *
 * The roughness/metalness rule is "explicit set ∪ map-aware fallback" (D-06):
 *   - field IN the authored set → FORCE the scalar, even over a source map
 *     (the director deliberately wants the channel — e.g. flatten a textured
 *     metal asset with `metalness=0`). This is the #124 capability.
 *   - field NOT in the set → the #99 map-aware default: apply the scalar only
 *     where no map defends the channel (a map ⇒ keep source, `null`).
 *
 * `overriddenSet` defaults to `undefined`, which makes every field fall to the
 * map-aware branch — byte-identical to the pre-#124 #99 behaviour (D-03
 * backward-compat; the unchanged legacy unit cases prove it). color / emissive /
 * emissiveIntensity / opacity ignore the set: they are always applied because
 * their default value is map-identity (white tint multiplies a `.map` to itself).
 */
export function resolveMaterialOverrideFields(
  override: MaterialValue,
  maps: MaterialMapPresence,
  overriddenSet?: OverriddenSet<MaterialOverrideField>,
): MaterialOverrideFields {
  // A scalar channel is applied when the director explicitly authored it OR no
  // source map defends it. Forced ⇒ the scalar; otherwise map present ⇒ null.
  const roughnessForced = isOverridden(overriddenSet, 'roughness') || !maps.roughnessMap;
  const metalnessForced = isOverridden(overriddenSet, 'metalness') || !maps.metalnessMap;
  return {
    color: override.color,
    roughness: roughnessForced ? override.roughness : null,
    metalness: metalnessForced ? override.metalness : null,
    opacity: override.opacity,
    emissive: override.emissive,
    emissiveIntensity: override.emissiveIntensity,
    transparent: override.opacity < 1,
  };
}
