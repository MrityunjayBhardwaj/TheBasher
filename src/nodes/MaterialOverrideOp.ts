// MaterialOverrideOp — the SPARSE material diff of the data lane (#394 S3c).
//
// Its wholesale sibling `SetMaterialOp` answers "wear THIS material instead"; this one
// answers "wear the material below, but with these channels different". It is Houdini's
// `material_override`, which Basher already spells as the scene-band `MaterialOverride`
// wrapper — so this node MINTS NO NEW RULE. It reuses that node's `MaterialOverriddenSet`
// verbatim and composes through `composeMaterial`, the one composition function (S3b).
//
// ── WHY IT COMPOSES AND `SetMaterialOp` DOES NOT ────────────────────────────────────
//
// `composeMaterial` is closed over `InlineMaterialSpec` on both sides precisely so a
// chain folds: `base → op₁ → … → opₙ`, each step this function, in stack order. A
// wholesale set is the degenerate case of that fold (it ignores its accumulator), which
// is why the two operators are siblings rather than one node with a mode flag: the
// per-field OWNERSHIP question has different answers for them, and a flag would hide
// that behind a param read (see `resolveMaterialFieldOwner`).
//
// ── THE THREE SOURCE REPRESENTATIONS, AND WHY NONE OF THEM IS A NEW DECISION ────────
//
// A source material arrives as an IR, as a captured baked spec, or as nothing:
//   • `InlineMaterialSpec` → `composeMaterial`      (the IR-lane form)
//   • `BakedMaterialSpec`  → `composeBakedMaterial` (the snapshot form; the composed
//     scalars are merged back over the spec so its MAPS and `materialClass` survive —
//     dropping them is the #99 fidelity loss this whole family exists to prevent)
//   • `null` → compose onto the HYDRATED STANDARD IR, not passthrough. A materialless
//     source with an override on it must show the override; passing through would be
//     the silent-nothing this slice is guarded against, wearing a different hat.
// All three delegate the SAME decision (`resolveMaterialOverrideFields`). This module
// translates vocabulary; it never re-answers "may this scalar be written".
//
// REF: src/app/material/composeMaterial.ts (the one composition rule + the split);
//      src/nodes/MaterialOverride.ts (the scene-band wrapper it shares the schema with);
//      src/app/resolveMaterialFieldOwner.ts (what this node MASKS); issue #394 S3c.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { MaterialValue, ObjectData } from './types';
import { MaterialOverriddenSet } from './MaterialOverride';
import { modifierDataSource } from '../app/modifierGeometry';
import { composeBakedMaterial, composeMaterial } from '../app/material/composeMaterial';
import { hydrateInlineMaterial } from './materialSchema';

export const MaterialOverrideOpParams = z.object({
  name: z.string().default('override'),
  color: z.string().default('#ffffff'),
  roughness: z.number().min(0).max(1).default(0.5),
  metalness: z.number().min(0).max(1).default(0),
  opacity: z.number().min(0).max(1).default(1),
  emissive: z.string().default('#000000'),
  emissiveIntensity: z.number().min(0).default(0),
  // THE SAME sparse authored set the wrapper carries (#124, V28) — imported, not
  // re-declared, so the two hosts of this rule cannot drift in their vocabulary any
  // more than they can in their composition.
  overridden: MaterialOverriddenSet,
  /** Stack mute-bypass (V58): true → pass the source through unchanged. */
  muted: z.boolean().default(false),
});
export type MaterialOverrideOpParams = z.infer<typeof MaterialOverrideOpParams>;

/** The op's params as the `MaterialValue` the shared decision layer speaks. Exported
 *  because the per-field ownership walk must ask the SAME question with the SAME input
 *  the fold asks — a second projection here is a second answer. */
export function overrideValueOf(params: MaterialOverrideOpParams): MaterialValue {
  return {
    kind: 'Material',
    name: params.name,
    color: params.color,
    roughness: params.roughness,
    metalness: params.metalness,
    opacity: params.opacity,
    emissive: params.emissive,
    emissiveIntensity: params.emissiveIntensity,
    overridden: params.overridden,
    // `ignoreSourceMaterial` is deliberately absent: it is the explicit REFUSAL to
    // compose (composeMaterial.ts's header states it stays the caller's branch), and
    // the lane has no flatten road yet. Adding the param without the branch would be a
    // control that silently does nothing.
  };
}

export const MaterialOverrideOpNode: NodeDefinition<MaterialOverrideOpParams, ObjectData> = {
  type: 'MaterialOverrideOp',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: MaterialOverrideOpParams,
  inputs: { target: { type: 'ObjectData', cardinality: 'single' } },
  outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
  // #396 — the spine the material stack walks down (see SetMaterialOp).
  chainInput: 'target',
  inspectorSections: ['material'],
  home: {
    color: 'material',
    roughness: 'material',
    metalness: 'material',
    opacity: 'material',
    emissive: 'material',
    emissiveIntensity: 'material',
  },
  evaluate(params, inputs) {
    const src = inputs.target as ObjectData | undefined;
    // Unwired target (transient authoring state) — nothing to compose onto.
    if (!src) return src as unknown as ObjectData;
    // Mute-bypass (V58) — identity passthrough, byte-identical to no operator.
    if (params.muted) return src;
    const source = modifierDataSource(src);
    // Non-mesh data (curve / light / camera) — nothing wears a material.
    if (!source) return src;
    const override = overrideValueOf(params);
    const base = source.material;
    return {
      kind: 'ModifiedData',
      geometry: source.geometry,
      material:
        base === null
          ? composeMaterial(hydrateInlineMaterial(undefined), override, 'authored-only')
          : 'materialClass' in base
            ? { ...base, ...composeBakedMaterial(base, override, 'authored-only') }
            : composeMaterial(base, override, 'authored-only'),
    };
  },
};
