import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { CameraValue } from './types';

export const PerspectiveCameraParams = z.object({
  fov: z.number().min(1).max(170),
  // Sensor size (mm) along the vertical FOV axis — authoring metadata for the
  // focal-length inspector (UX #12). DEFAULTED so pre-#12 projects parse to
  // full-frame (V10/H14 first layer); the renderer reads `fov`, not this.
  sensorSize: z.number().positive().default(36),
  near: z.number().positive().default(0.01),
  far: z.number().positive().default(1000),
  // Depth of field (UX #12 slice 2). All DEFAULTED so pre-DoF projects parse
  // (dofEnabled=false → no behavior change). focusDistance is in world units;
  // fStop is the aperture f-number (lower = shallower DoF / more bokeh). The
  // CoC is derived from these + the lens (cameraDof.ts) and feeds the live
  // viewport AND the offscreen render identically.
  dofEnabled: z.boolean().default(false),
  focusDistance: z.number().positive().default(5),
  fStop: z.number().positive().default(2.8),
  position: z.tuple([z.number(), z.number(), z.number()]),
  lookAt: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  // Camera roll (#229) — rotation in DEGREES about the view axis (local -Z, the
  // direction from position → lookAt), the Blender "R-Z roll". lookAt alone
  // leaves the up-vector implicit (world +Y); roll banks it. DEFAULTED to 0 so
  // pre-#229 projects parse to no-roll, byte-identical (no migration). Authored
  // as a scalar → keyframeable on the camera-scalar channel path (V56).
  roll: z.number().default(0),
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
      roll: params.roll,
    };
  },
};
