import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { RenderOutputValue, SceneValue } from './types';

export const RenderOutputParams = z.object({
  postFx: z.object({
    tonemap: z.enum(['ACES', 'Linear']).default('ACES'),
    smaa: z.boolean().default(true),
  }),
});
export type RenderOutputParams = z.infer<typeof RenderOutputParams>;

export const RenderOutputNode: NodeDefinition<RenderOutputParams, RenderOutputValue> = {
  type: 'RenderOutput',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: RenderOutputParams,
  inputs: { scene: { type: 'Scene', cardinality: 'single' } },
  outputs: { out: { type: 'RenderOutput', cardinality: 'single' } },
  inspectorSections: ['render'],
  evaluate(params, inputs) {
    return {
      kind: 'RenderOutput',
      scene: inputs.scene as SceneValue,
      postFx: params.postFx,
    };
  },
};
