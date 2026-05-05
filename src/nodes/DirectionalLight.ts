import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { DirectionalLightValue } from './types';

export const DirectionalLightParams = z.object({
  intensity: z.number().min(0).max(20),
  position: z.tuple([z.number(), z.number(), z.number()]),
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
      color: params.color,
    };
  },
};
