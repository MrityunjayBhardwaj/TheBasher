// MaterialOverride — wraps a child Mesh and replaces its material with a
// preset PBR description. V9: parameters only. No string-typed shader source,
// no JS callbacks. TSL/OSL authoring is deferred to P4 (`dharana.md` §3
// "Shader-as-node-graph").
//
// REF: THESIS.md §39, vyapti V9.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { MaterialOverrideValue, SceneChild } from './types';

// The sparse per-field "authored" set (#124, V28). Default `{}` = legacy #99
// map-aware behaviour (D-03): a field absent from the set inherits the source
// material's channel (a map defends roughness/metalness). A field present and
// `true` is a director's explicit authoring — it FORCES the scalar even over a
// source map. The bit is EXPLICIT, never derived from value≠default, because
// the param is seeded with a value (the R-4 single-tier trap).
export const MaterialOverriddenSet = z
  .object({
    color: z.boolean(),
    roughness: z.boolean(),
    metalness: z.boolean(),
    opacity: z.boolean(),
    emissive: z.boolean(),
    emissiveIntensity: z.boolean(),
  })
  .partial()
  .default({});

export const MaterialOverrideParams = z.object({
  name: z.string().default('override'),
  color: z.string().default('#ffffff'),
  roughness: z.number().min(0).max(1).default(0.5),
  metalness: z.number().min(0).max(1).default(0),
  opacity: z.number().min(0).max(1).default(1),
  emissive: z.string().default('#000000'),
  emissiveIntensity: z.number().min(0).default(0),
  overridden: MaterialOverriddenSet,
  // #131 (D-05): the coarse flatten / clay toggle. `true` ⇒ the renderer
  // ignores the source material entirely and builds a fresh one from the 7
  // scalars (source maps + subclass dropped BY INTENT). `false` (default) ⇒
  // the clone + map-aware merge path (#99 + #124). SEPARATE from `overridden`:
  // a different-scope primitive (Blender View-Layer Material Override / Houdini
  // wholesale Assign Material), not a per-field bit.
  ignoreSourceMaterial: z.boolean().default(false),
  // v0.6 #2 (#178, W6 — D-05/D-07): the per-submesh addressing dimension for a
  // MULTI-material glTF target. OPTIONAL — absent ⇒ undefined ⇒ the override
  // applies to every material slot (the #99/#124 whole-child behaviour;
  // backward-compat MUST hold). A number `i` targets ONLY the i-th material slot
  // (the i-th isMesh in the cloned glTF's traverse order). No `.default` so
  // pre-W6 projects hydrate as undefined = whole-child (V10/H14-clean; no
  // migration needed). Range-guarded at the renderer, not here.
  slotIndex: z.number().int().min(0).optional(),
});
export type MaterialOverrideParams = z.infer<typeof MaterialOverrideParams>;

export const MaterialOverrideNode: NodeDefinition<MaterialOverrideParams, MaterialOverrideValue> = {
  type: 'MaterialOverride',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: MaterialOverrideParams,
  inputs: { target: { type: 'SceneObject', cardinality: 'single' } },
  outputs: { out: { type: 'SceneObject', cardinality: 'single' } },
  inspectorSections: ['material'],
  evaluate(params, inputs) {
    return {
      kind: 'MaterialOverride',
      child: (inputs.target as SceneChild | undefined) ?? null,
      material: {
        kind: 'Material',
        name: params.name,
        color: params.color,
        roughness: params.roughness,
        metalness: params.metalness,
        opacity: params.opacity,
        emissive: params.emissive,
        emissiveIntensity: params.emissiveIntensity,
        // #124 (V28): the sparse authored set rides on the MaterialValue so it
        // flows down the `override?: MaterialValue` prop chain to GltfAssetR.
        overridden: params.overridden,
        // #131 (D-05): the coarse flatten toggle rides the same prop chain.
        ignoreSourceMaterial: params.ignoreSourceMaterial,
        // v0.6 #2 (#178, W6): the per-submesh slot index rides the same
        // `override?: MaterialValue` prop chain to GltfAssetR. undefined ⇒
        // whole-child (every slot); a number ⇒ that slot only.
        slotIndex: params.slotIndex,
      },
    };
  },
};
