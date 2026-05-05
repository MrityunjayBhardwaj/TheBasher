import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { SpotLightValue } from './types';

export const SpotLightParams = z.object({
  intensity: z.number().min(0).max(100).default(1),
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 5, 0]),
  target: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  color: z.string().default('#ffffff'),
  angle: z.number().min(0).max(Math.PI / 2).default(Math.PI / 6),
  penumbra: z.number().min(0).max(1).default(0.1),
  distance: z.number().min(0).default(0),
  decay: z.number().min(0).default(2),
});
export type SpotLightParams = z.infer<typeof SpotLightParams>;

export const SpotLightNode: NodeDefinition<SpotLightParams, SpotLightValue> = {
  type: 'SpotLight',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: SpotLightParams,
  inputs: {},
  outputs: { out: { type: 'Light', cardinality: 'single' } },
  evaluate(params) {
    return {
      kind: 'SpotLight',
      intensity: params.intensity,
      position: params.position,
      target: params.target,
      color: params.color,
      angle: params.angle,
      penumbra: params.penumbra,
      distance: params.distance,
      decay: params.decay,
    };
  },
};
