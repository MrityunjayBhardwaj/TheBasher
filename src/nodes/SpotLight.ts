import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';

export const SpotLightParams = z.object({
  intensity: z.number().min(0).max(100).default(1),
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 5, 0]),
  target: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  // Euler XYZ. Coexists with `target` — when rotation is non-zero the
  // helper orients by it; the renderer keeps using `target` for shading
  // unless we wire that up later. v1 keeps target authoritative for
  // shading; rotation drives the gizmo + helper visualization.
  rotation: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  // Transform scale. Drives intensity at render time via the volume
  // product (sx*sy*sz). Cone shape itself is still driven by `angle`
  // and `distance` — scale only affects power + helper visualization.
  scale: z.tuple([z.number(), z.number(), z.number()]).default([1, 1, 1]),
  color: z.string().default('#ffffff'),
  angle: z
    .number()
    .min(0)
    .max(Math.PI / 2)
    .default(Math.PI / 6),
  penumbra: z.number().min(0).max(1).default(0.1),
  distance: z.number().min(0).default(0),
  decay: z.number().min(0).default(2),
});
export type SpotLightParams = z.infer<typeof SpotLightParams>;

export const SpotLightNode: NodeDefinition<SpotLightParams, never> = {
  type: 'SpotLight',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: SpotLightParams,
  inputs: {},
  outputs: { out: { type: 'SceneObject', cardinality: 'single' } },
  inspectorSections: ['transform', 'constraint', 'driver'],
  // Retired (#386 S4): a SpotLight is now an Object → LightData. Registered SOLELY for the
  // load-migration's version-ladder normalization; never evaluates. The SpotLightValue
  // interface stays in types.ts as the recomposition target.
  evaluate(): never {
    throw new Error('SpotLight is retired; projects migrate to Object+LightData on load (#386)');
  },
};
