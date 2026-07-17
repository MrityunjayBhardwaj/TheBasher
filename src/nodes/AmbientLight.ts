// AmbientLight — closes the V8 leak from P0 (the placeholder ambient light
// is gone; projects that want fill add this node).
//
// REF: THESIS.md §39, vyapti V8.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { AmbientLightValue } from './types';

export const AmbientLightParams = z.object({
  intensity: z.number().min(0).max(20).default(0.4),
  color: z.string().default('#ffffff'),
});
export type AmbientLightParams = z.infer<typeof AmbientLightParams>;

export const AmbientLightNode: NodeDefinition<AmbientLightParams, AmbientLightValue> = {
  type: 'AmbientLight',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: AmbientLightParams,
  inputs: {},
  outputs: { out: { type: 'SceneObject', cardinality: 'single' } },
  // The pose contract (#362, §9): ambient light is positionless — it evaluates to
  // a value with NO `position`, so it must NOT advertise a Constraints panel that
  // moves nothing (#356). It stays drivable (intensity over time); intensity/color
  // render via the raw-fallback bucket, exactly as the posable lights' params do.
  inspectorSections: ['driver'],
  evaluate(params) {
    return { kind: 'AmbientLight', intensity: params.intensity, color: params.color };
  },
};
