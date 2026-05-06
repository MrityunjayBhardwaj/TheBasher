// AreaLight — rectangular light. Maps to THREE.RectAreaLight in the viewport.
// Pre-baked envMap support is out of scope for v0.5; the light samples
// directly via the standard RectAreaLightUniformsLib path.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { AreaLightValue } from './types';

export const AreaLightParams = z.object({
  intensity: z.number().min(0).max(100).default(5),
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 5, 0]),
  color: z.string().default('#ffffff'),
  width: z.number().positive().default(2),
  height: z.number().positive().default(2),
  lookAt: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  // Euler XYZ. v1: helper visualization only — `lookAt` stays
  // authoritative for the rendered RectAreaLight orientation.
  rotation: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
});
export type AreaLightParams = z.infer<typeof AreaLightParams>;

export const AreaLightNode: NodeDefinition<AreaLightParams, AreaLightValue> = {
  type: 'AreaLight',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: AreaLightParams,
  inputs: {},
  outputs: { out: { type: 'Light', cardinality: 'single' } },
  evaluate(params) {
    return {
      kind: 'AreaLight',
      intensity: params.intensity,
      position: params.position,
      rotation: params.rotation,
      color: params.color,
      width: params.width,
      height: params.height,
      lookAt: params.lookAt,
    };
  },
};
