import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { DirectionalLightValue } from './types';

export const DirectionalLightParams = z.object({
  intensity: z.number().min(0).max(20),
  position: z.tuple([z.number(), z.number(), z.number()]),
  // Euler XYZ rotation. When zero, the renderer falls back to "shine
  // toward the origin from `position`" (legacy seed behavior). When
  // non-zero, direction is computed as `rotation × (0,-1,0)` — the sun
  // points along its local -Y, rotated.
  rotation: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  color: z.string().default('#ffffff'),
});
export type DirectionalLightParams = z.infer<typeof DirectionalLightParams>;

export const DirectionalLightNode: NodeDefinition<DirectionalLightParams, DirectionalLightValue> = {
  type: 'DirectionalLight',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: DirectionalLightParams,
  inputs: {},
  outputs: { out: { type: 'Light', cardinality: 'single' } },
  evaluate(params) {
    return {
      kind: 'DirectionalLight',
      intensity: params.intensity,
      position: params.position,
      rotation: params.rotation,
      color: params.color,
    };
  },
};
