import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { PointLightValue } from './types';

export const PointLightParams = z.object({
  intensity: z.number().min(0).max(100).default(1),
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 2, 0]),
  // Euler XYZ. PointLight is radial — rotation has no shading effect, but
  // the gizmo's rotate handle still writes here so the helper can rotate
  // visually for grouping cues.
  rotation: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
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
    // Defensive default for rotation — see DirectionalLight for the why.
    const rotation = params.rotation ?? ([0, 0, 0] as [number, number, number]);
    return {
      kind: 'PointLight',
      intensity: params.intensity,
      position: params.position,
      rotation,
      color: params.color,
      distance: params.distance,
      decay: params.decay,
    };
  },
};
