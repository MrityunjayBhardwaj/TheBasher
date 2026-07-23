import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';

export const PointLightParams = z.object({
  intensity: z.number().min(0).max(100).default(1),
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 2, 0]),
  // Euler XYZ. PointLight is radial — rotation has no shading effect, but
  // the gizmo's rotate handle still writes here so the helper can rotate
  // visually for grouping cues.
  rotation: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  // Transform scale. Drives intensity at render time via the volume
  // product (sx*sy*sz) — uniform 2× scale = 8× brighter. Helper group
  // also scales by this so the wireframe sphere visibly grows. Distance
  // (range) is independent and stays its own knob.
  scale: z.tuple([z.number(), z.number(), z.number()]).default([1, 1, 1]),
  color: z.string().default('#ffffff'),
  distance: z.number().min(0).default(0),
  decay: z.number().min(0).default(2),
});
export type PointLightParams = z.infer<typeof PointLightParams>;

export const PointLightNode: NodeDefinition<PointLightParams, never> = {
  type: 'PointLight',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: PointLightParams,
  inputs: {},
  outputs: { out: { type: 'SceneObject', cardinality: 'single' } },
  inspectorSections: ['transform', 'constraint', 'driver'],
  // Retired (#386 S4): a PointLight is now an Object → LightData. Registered SOLELY for the
  // load-migration's version-ladder normalization; never evaluates. The PointLightValue
  // interface stays in types.ts as the recomposition target.
  evaluate(): never {
    throw new Error('PointLight is retired; projects migrate to Object+LightData on load (#386)');
  },
};
