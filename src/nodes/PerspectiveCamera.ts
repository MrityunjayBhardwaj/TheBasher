import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { CameraValue } from './types';

export const PerspectiveCameraParams = z.object({
  fov: z.number().min(1).max(170),
  near: z.number().positive().default(0.1),
  far: z.number().positive().default(1000),
  position: z.tuple([z.number(), z.number(), z.number()]),
  lookAt: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
});
export type PerspectiveCameraParams = z.infer<typeof PerspectiveCameraParams>;

export const PerspectiveCameraNode: NodeDefinition<PerspectiveCameraParams, CameraValue> = {
  type: 'PerspectiveCamera',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: PerspectiveCameraParams,
  inputs: {},
  outputs: { out: { type: 'Camera', cardinality: 'single' } },
  evaluate(params) {
    return {
      kind: 'PerspectiveCamera',
      fov: params.fov,
      near: params.near,
      far: params.far,
      position: params.position,
      lookAt: params.lookAt,
    };
  },
};
