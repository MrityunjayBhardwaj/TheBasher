import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { BoxMeshValue } from './types';

export const BoxMeshParams = z.object({
  size: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  rotation: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  material: z
    .object({
      name: z.string().default('default'),
      color: z.string().default('#5af07a'),
    })
    .default({ name: 'default', color: '#5af07a' }),
});
export type BoxMeshParams = z.infer<typeof BoxMeshParams>;

export const BoxMeshNode: NodeDefinition<BoxMeshParams, BoxMeshValue> = {
  type: 'BoxMesh',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: BoxMeshParams,
  inputs: {},
  outputs: { out: { type: 'Mesh', cardinality: 'single' } },
  evaluate(params) {
    return {
      kind: 'BoxMesh',
      size: params.size,
      position: params.position,
      rotation: params.rotation,
      material: params.material,
    };
  },
};
