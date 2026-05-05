import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { OrthographicCameraValue } from './types';

export const OrthographicCameraParams = z.object({
  zoom: z.number().positive().default(50),
  near: z.number().positive().default(0.1),
  far: z.number().positive().default(1000),
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 5]),
  lookAt: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
});
export type OrthographicCameraParams = z.infer<typeof OrthographicCameraParams>;

export const OrthographicCameraNode: NodeDefinition<
  OrthographicCameraParams,
  OrthographicCameraValue
> = {
  type: 'OrthographicCamera',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: OrthographicCameraParams,
  inputs: {},
  outputs: { out: { type: 'Camera', cardinality: 'single' } },
  evaluate(params) {
    return {
      kind: 'OrthographicCamera',
      zoom: params.zoom,
      near: params.near,
      far: params.far,
      position: params.position,
      lookAt: params.lookAt,
    };
  },
};
