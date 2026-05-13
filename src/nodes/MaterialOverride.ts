// MaterialOverride — wraps a child Mesh and replaces its material with a
// preset PBR description. V9: parameters only. No string-typed shader source,
// no JS callbacks. TSL/OSL authoring is deferred to P4 (`dharana.md` §3
// "Shader-as-node-graph").
//
// REF: THESIS.md §39, vyapti V9.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { MaterialOverrideValue, SceneChild } from './types';

export const MaterialOverrideParams = z.object({
  name: z.string().default('override'),
  color: z.string().default('#ffffff'),
  roughness: z.number().min(0).max(1).default(0.5),
  metalness: z.number().min(0).max(1).default(0),
  opacity: z.number().min(0).max(1).default(1),
  emissive: z.string().default('#000000'),
  emissiveIntensity: z.number().min(0).default(0),
});
export type MaterialOverrideParams = z.infer<typeof MaterialOverrideParams>;

export const MaterialOverrideNode: NodeDefinition<MaterialOverrideParams, MaterialOverrideValue> = {
  type: 'MaterialOverride',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: MaterialOverrideParams,
  inputs: { target: { type: 'Mesh', cardinality: 'single' } },
  outputs: { out: { type: 'Mesh', cardinality: 'single' } },
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
      },
    };
  },
};
