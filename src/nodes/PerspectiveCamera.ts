import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { CameraValue } from './types';

export const PerspectiveCameraParams = z.object({
  fov: z.number().min(1).max(170),
  // Sensor size (mm) along the vertical FOV axis — authoring metadata for the
  // focal-length inspector (UX #12). DEFAULTED so pre-#12 projects parse to
  // full-frame (V10/H14 first layer); the renderer reads `fov`, not this.
  sensorSize: z.number().positive().default(36),
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
  // UX #12 — Camera (lens) is the primary domain for a camera node; Transform
  // (position / lookAt) is secondary. Mirrors Scene leading with Environment.
  inspectorSections: ['camera', 'transform'],
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
