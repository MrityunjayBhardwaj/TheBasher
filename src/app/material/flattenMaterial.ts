// flattenMaterial — the material a flatten override draws, in the IR's own vocabulary (#1076).
//
// ── WHAT FLATTEN IS ─────────────────────────────────────────────────────────────────────
//
// `MaterialOverride.ignoreSourceMaterial` (#131) is the director saying "ignore what this
// thing was made of and draw my material instead" — the clay pass. It is NOT composition,
// which is why it does not live in `composeMaterial`: composition keeps the source and lets
// the override write over it, one map-aware field at a time. Flatten keeps nothing of the
// source — no maps, no coat or transmission, no cutout or double-siding, no UV placement —
// and takes every one of the override's six scalars, whatever its authored set says. There
// is no layer below left for an unauthored field to defer to.
//
// ── WHY AN IR, AND NOT A THREE.js MATERIAL ──────────────────────────────────────────────
//
// The glTF clone road builds its clay as a `THREE.MeshStandardMaterial` inside
// `SceneFromDAG.tsx`, because it works on a live cloned material. The native road has an IR
// and a compile. Expressing flatten as an IR means it goes through the ONE compile
// (`openpbrToThree`), the ONE spec assembly and the ONE registry every native mesh already
// uses — so the registry key, the texture loads (none) and the wireframe mode all follow
// without a second spelling of any of them. It also keeps flatten renderer-agnostic, like
// the rest of this directory's IR half (`materialComposition.gate.test.ts`).
//
// Everything the override has no field for comes from a NEW material
// (`hydrateInlineMaterial`), never from the source. That is the whole of "ignore the source".
//
// REF: src/nodes/MaterialOverride.ts (`ignoreSourceMaterial` rides the MaterialValue);
//      src/app/material/primitiveMaterialInputs.ts (`compilePrimitiveMaterial`, the caller);
//      src/viewport/SceneFromDAG.tsx (the clone road's `clay`); issues #131, #1076.

import { hydrateInlineMaterial } from '../../nodes/materialSchema';
import type { InlineMaterialSpec, MaterialValue } from '../../nodes/types';

/** Whether an override asks the renderer to ignore the source material entirely. */
export function flattens(override: MaterialValue | undefined): override is MaterialValue {
  return override?.ignoreSourceMaterial === true;
}

/**
 * The IR a flatten override draws: the override's six scalars on a new material.
 *
 * `emissiveIntensity` lands on `emission.luminance` 1:1 — the same identity
 * `composeMaterial` uses, because `openpbrToThree` maps luminance onto intensity with
 * `EMISSION_NIT_TO_INTENSITY = 1`. `transparent` is not set here: the compile derives it
 * from opacity, and that derivation has one home.
 */
export function flattenedMaterial(override: MaterialValue): InlineMaterialSpec {
  return hydrateInlineMaterial({
    name: override.name,
    base: { color: override.color, metalness: override.metalness },
    specular: { roughness: override.roughness },
    emission: { color: override.emissive, luminance: override.emissiveIntensity },
    geometry: { opacity: override.opacity },
  });
}
