import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';

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

export const OrthographicCameraNode: NodeDefinition<OrthographicCameraParams, never> = {
  type: 'OrthographicCamera',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: OrthographicCameraParams,
  inputs: {},
  outputs: { out: { type: 'SceneObject', cardinality: 'single' } },
  // UX #12 — Camera (lens) primary, Transform secondary (mirrors PerspectiveCamera).
  inspectorSections: ['camera', 'transform', 'constraint', 'driver'],
  home: {
    zoom: 'camera',
    near: 'camera',
    far: 'camera',
    position: 'transform',
    lookAt: 'transform',
    roll: 'transform',
  },
  // Retired (#387 S8) — see PerspectiveCamera.ts for the full note. Registered SOLELY so the
  // load-migration can normalize an old fused camera through its own version ladder before
  // splitting it; `OrthographicCameraValue` survives as the recomposition target.
  //
  // `zoom` migrates across intact (`CameraData.zoom`), which is worth saying only because it
  // would be easy to assume otherwise: no renderer has ever read it, fused or split (#478).
  // The value is preserved; the gap it names is pre-existing and not touched here.
  evaluate(): never {
    throw new Error(
      'OrthographicCamera is retired; projects migrate to Object+CameraData on load (#387)',
    );
  },
};
