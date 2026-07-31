// composeMaterial — the ONE composition of a `MaterialOverride` onto a source
// material, in each of the two representations a source can arrive in (#394 S3b).
//
// ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────────
//
// Before this, ONE rule had THREE spellings, and only one of them was the rule:
//
//   • `resolveMaterialOverrideFields` (materialOverrideMerge.ts) — the real rule.
//     Map-aware, consults the per-field authored set. Used by the glTF road only.
//   • `applyOverride` (SceneFromDAG.tsx:1986) — the baked road. WHOLESALE: every
//     scalar forced, map presence never consulted.
//   • seven inline ternaries in `usePrimitiveMaterial` — the native road. Also
//     wholesale, also blind to maps.
//
// The two wholesale spellings predate texture maps on a native material. They are
// no longer harmless: `MaterialEditor` attaches maps at `material.maps.<slot>`
// (NPanel.tsx:1395) for any data node, and `usePrimitiveMaterial` loads
// roughnessMap/metalnessMap from them — so a primitive under a MaterialOverride
// had its roughness map attenuated by a forced scalar, which is the exact #99
// fidelity loss that was fixed for glTF and left standing here.
//
// So this module does not invent a rule. It gives the EXISTING rule its missing
// representations, and the wholesale spellings are deleted rather than wrapped.
//
// ── THE SPLIT: DECISION vs REPRESENTATION ───────────────────────────────────────
//
//   materialOverrideMerge.resolveMaterialOverrideFields   ← the DECISION (one)
//        ↑                              ↑
//   composeMaterial(ir, o)      composeBakedMaterial(spec, o)   ← REPRESENTATIONS
//
// Every function here delegates the decision and only translates vocabulary. A new
// representation (a WebGPU IR, a future op's value) adds a sibling here; it must
// NEVER re-answer "may this scalar be written". That is the [[V101]] drift guard
// stated structurally: there is nothing to keep in sync because there is one
// answer and N translations of it.
//
// ── WHAT THIS DELIBERATELY DOES NOT HANDLE ──────────────────────────────────────
//
// `ignoreSourceMaterial` (the #131 flatten / clay path) is NOT composition — it is
// the explicit refusal to compose, and it drops the source's maps and subclass BY
// INTENT. It stays the caller's branch, exactly as it is in the glTF road (`clay`
// vs `tint`, SceneFromDAG.tsx:3040), because folding it in here would give this
// module two contradictory jobs. The native and baked roads have never honoured
// it, and this slice does not change that.

import type { BakedMaterialSpec, InlineMaterialSpec, MaterialValue } from '../../nodes/types';
import { resolveMaterialOverrideFields } from './materialOverrideMerge';

/**
 * Compose an override onto an OpenPBR IR, yielding an IR.
 *
 * THE IR-LANE FORM, and the one the material operator lane (#394 S3c) folds with:
 * `base → op₁ → … → opₙ`, each step this function. It is closed over
 * `InlineMaterialSpec` on both sides precisely so it can be folded; a function
 * that returned a flat three.js bag could be applied once and never composed.
 *
 * Only the six scalar channels a `MaterialValue` carries an opinion about are
 * touched. `ior`, the coat and transmission lobes, the maps and the UV transform
 * come from the base untouched — an override has no field for them, and inventing
 * a default would be an opinion the director never expressed.
 */
export function composeMaterial(
  base: InlineMaterialSpec,
  override: MaterialValue,
): InlineMaterialSpec {
  const fields = resolveMaterialOverrideFields(
    override,
    {
      // Map presence in the IR's own vocabulary. A slot holding a texture ref
      // defends its channel; `null` means the scalar IS the value.
      roughnessMap: base.maps.roughness !== null,
      metalnessMap: base.maps.metalness !== null,
    },
    override.overridden,
  );
  return {
    ...base,
    base: {
      ...base.base,
      color: fields.color,
      // `null` ⇒ a source map owns the channel ⇒ keep the base scalar.
      metalness: fields.metalness ?? base.base.metalness,
    },
    specular: { ...base.specular, roughness: fields.roughness ?? base.specular.roughness },
    emission: {
      ...base.emission,
      color: fields.emissive,
      // The IR is photometric; the override's `emissiveIntensity` is the same
      // unitless multiplier `openpbrToThree` maps luminance onto 1:1
      // (EMISSION_NIT_TO_INTENSITY = 1.0), so this is an identity, not a rescale.
      luminance: fields.emissiveIntensity,
    },
    geometry: { ...base.geometry, opacity: fields.opacity },
  };
  // NB: `transparent` is deliberately NOT carried. It is DERIVED, and its one
  // derivation lives in `openpbrToThree` (`transmission > 0 || opacity < 1`).
  // The wholesale spellings this replaces each re-derived it as `opacity < 1`,
  // which silently dropped transparency from an overridden transmissive material.
}

/** The scalar channels a baked source resolves to once an override is composed on. */
export interface ComposedBakedScalars {
  readonly color: string;
  readonly roughness: number;
  readonly metalness: number;
  readonly opacity: number;
  readonly emissive: string;
  readonly emissiveIntensity: number;
  readonly transparent: boolean;
}

/**
 * Compose an override onto a captured baked spec.
 *
 * A `BakedMaterialSpec` is three-shaped, not OpenPBR — it is a snapshot of what a
 * renderer already resolved — so it cannot round-trip through `composeMaterial`
 * without inventing lobes it never captured. It gets its own translation instead,
 * over the SAME decision.
 *
 * `transparent` is carried here (unlike the IR form) because a baked spec CAPTURED
 * its own transparency; there is no transmission lobe to re-derive it from.
 */
export function composeBakedMaterial(
  spec: BakedMaterialSpec,
  override: MaterialValue,
): ComposedBakedScalars {
  const fields = resolveMaterialOverrideFields(
    override,
    // Map presence in the baked spec's vocabulary.
    { roughnessMap: spec.roughnessMap !== null, metalnessMap: spec.metalnessMap !== null },
    override.overridden,
  );
  return {
    color: fields.color,
    roughness: fields.roughness ?? spec.roughness,
    metalness: fields.metalness ?? spec.metalness,
    opacity: fields.opacity,
    emissive: fields.emissive,
    emissiveIntensity: fields.emissiveIntensity,
    transparent: fields.transparent,
  };
}
