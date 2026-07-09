import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { OrthographicCameraValue } from './types';

export const OrthographicCameraParams = z.object({
  zoom: z.number().positive().default(50),
  near: z.number().positive().default(0.01),
  far: z.number().positive().default(500),
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 5]),
  lookAt: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  // Camera roll (#229) — degrees about the view axis, mirrors PerspectiveCamera.
  roll: z.number().default(0),
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
  outputs: { out: { type: 'SceneObject', cardinality: 'single' } },
  // UX #12 — Camera (lens) primary, Transform secondary (mirrors PerspectiveCamera).
  inspectorSections: ['camera', 'transform'],
  evaluate(params) {
    return {
      kind: 'OrthographicCamera',
      zoom: params.zoom,
      near: params.near,
      far: params.far,
      position: params.position,
      lookAt: params.lookAt,
      roll: params.roll,
    };
  },
};
