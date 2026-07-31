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
 * WHAT SITS BELOW THIS OVERRIDE — the one thing the decision cannot infer (#529).
 *
 * The map-aware cut described above is a rule about a SOURCE MATERIAL: "no map defends
 * this channel" is evidence that the scalar IS the value, so applying the override's
 * scalar loses nothing. That reasoning is sound when the layer below is a passive
 * source — an imported glTF material, a captured baked spec, a primitive's own IR.
 *
 * It is FALSE when the layer below is ANOTHER AUTHORED LAYER. In the material operator
 * stack a lower operator's roughness is not an undefended default; it is a value a
 * director deliberately put there. Reading "no map" as permission to overwrite it makes
 * the upper operator claim every channel it has a param for, which is exactly #529: the
 * `overridden` set — the entire mechanism that makes the diff sparse — is never
 * consulted, because `||` short-circuits before it. Measured, one operator with empty
 * params reset six of seven channels of an authored material to its own defaults.
 *
 * So the regime is an INPUT, not something to sniff. Two values, one branch:
 *
 *   'map-aware'     the layer below is a source material. The #99/#124 cut, unchanged.
 *   'authored-only' the layer below is another authored layer. A field is written IFF
 *                   the director authored it — map presence is irrelevant, because the
 *                   thing being protected is authorship, not texture fidelity.
 *
 * Deliberately REQUIRED rather than defaulted. A default would let a new caller inherit
 * the wrong regime silently, and a silently-wrong regime is the whole of #529. Every
 * call site states which road it is on.
 */
export type OverrideAuthority = 'map-aware' | 'authored-only';

/**
 * The exact fields to write. A `null` means "leave the layer below untouched" — it owns
 * that channel, whether by defending it with a map or by having authored it.
 * Map references are intentionally absent: they survive the clone, never set here.
 *
 * ALL SIX are nullable as of #529. On the 'map-aware' road the four tint fields are
 * still never null, so that road's consumers are unaffected in practice — but the type
 * no longer PROMISES it, which is what lets the data lane return nothing at all.
 */
export interface MaterialOverrideFields {
  readonly color: string | null;
  readonly roughness: number | null;
  readonly metalness: number | null;
  readonly opacity: number | null;
  readonly emissive: string | null;
  readonly emissiveIntensity: number | null;
  /** Derived from `opacity`; null exactly when opacity is not written. */
  readonly transparent: boolean | null;
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
  overriddenSet: OverriddenSet<MaterialOverrideField> | undefined,
  authority: OverrideAuthority,
): MaterialOverrideFields {
  const authored = (f: MaterialOverrideField) => isOverridden(overriddenSet, f);

  // THE ONE BRANCH (#529). Everything below reads `writes(field, mapDefends)`; the two
  // regimes differ only in what that means, and they differ in exactly one place.
  //
  //   authored-only — the layer below is another authored layer. Authorship is the whole
  //                   test. `mapDefends` is not consulted: a map below is somebody's
  //                   authored choice too, and the director either asked for this field
  //                   or did not.
  //   map-aware     — the layer below is a source material. Unchanged #99/#124/D-06:
  //                   authored ⇒ force the scalar even over a map; otherwise apply it
  //                   only where no map defends the channel.
  //
  // Written as an EXHAUSTIVE switch that throws, not as a ternary with a fall-through
  // side. `tsconfig.app.json` excludes `*.test.ts` from typecheck, so a required
  // parameter is NOT enforced at the tier most likely to omit it — a test calling this
  // with three arguments would compile silently, and a ternary would hand it the
  // map-aware road. That is #529's own shape (a regime chosen by default rather than
  // stated), so a missing authority has to be loud.
  const writes = (f: MaterialOverrideField, mapDefends: boolean) => {
    switch (authority) {
      case 'authored-only':
        return authored(f);
      case 'map-aware':
        return authored(f) || !mapDefends;
      default: {
        const exhaustive: never = authority;
        throw new Error(`resolveMaterialOverrideFields: unknown authority ${String(exhaustive)}`);
      }
    }
  };

  // The four tints pass `mapDefends: false`, which is not a shortcut — it is the D-01
  // statement that they have no map to defend against. Their default is map-identity
  // (a white tint multiplies a `.map` to itself), so on the map-aware road they resolve
  // to "always applied" exactly as before, while on the data lane they now obey the
  // authored set like every other field. One expression, both roads.
  const opacity = writes('opacity', false) ? override.opacity : null;

  return {
    color: writes('color', false) ? override.color : null,
    roughness: writes('roughness', maps.roughnessMap) ? override.roughness : null,
    metalness: writes('metalness', maps.metalnessMap) ? override.metalness : null,
    opacity,
    emissive: writes('emissive', false) ? override.emissive : null,
    emissiveIntensity: writes('emissiveIntensity', false) ? override.emissiveIntensity : null,
    // Derived, never authored — so it is present exactly when the opacity it derives
    // from is. An unwritten opacity leaves the layer below owning transparency too.
    transparent: opacity === null ? null : opacity < 1,
  };
}
