import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { PointLightValue } from './types';

export const PointLightParams = z.object({
  intensity: z.number().min(0).max(100).default(1),
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 2, 0]),
  color: z.string().default('#ffffff'),
  distance: z.number().min(0).default(0),
  decay: z.number().min(0).default(2),
});
export type PointLightParams = z.infer<typeof PointLightParams>;

export const PointLightNode: NodeDefinition<PointLightParams, PointLightValue> = {
  type: 'PointLight',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: PointLightParams,
  inputs: {},
  outputs: { out: { type: 'Light', cardinality: 'single' } },
  evaluate(params) {
    return {
      kind: 'PointLight',
      intensity: params.intensity,
      position: params.position,
      color: params.color,
      distance: params.distance,
      decay: params.decay,
    };
  },
};
