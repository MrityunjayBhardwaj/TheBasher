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
  outputs: { out: { type: 'Light', cardinality: 'single' } },
  inspectorSections: ['transform'],
  evaluate(params) {
    return { kind: 'AmbientLight', intensity: params.intensity, color: params.color };
  },
};
