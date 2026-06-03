import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { BoxMeshValue } from './types';

export const BoxMeshParams = z.object({
  size: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  rotation: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  // v0.6 #1 (D-01): the non-destructive TRS transform band, SEPARATE from the
  // parametric geometry `size`. `size` is a capability (re-parametrize the box);
  // `scale` is the uniform transform band the gizmo drives. Default IDENTITY so a
  // migrated v1 project renders byte-identically (the renderer ignored scale until
  // Wave 3 and applies identity as a no-op).
  scale: z.tuple([z.number(), z.number(), z.number()]).default([1, 1, 1]),
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
  version: 2,
  pure: true,
  cost: 'cheap',
  paramSchema: BoxMeshParams,
  inputs: {},
  outputs: { out: { type: 'Mesh', cardinality: 'single' } },
  inspectorSections: ['mesh', 'transform', 'material'],
  // v0.6 #1 — v1 (no scale) → v2 (scale=identity). Lossless: every other param
  // is preserved untouched; scale defaults to identity so the rendered result is
  // unchanged. (V4 migration runner, THESIS §52.)
  migrations: {
    1: (old) => ({ ...(old as object), scale: [1, 1, 1] }),
  },
  evaluate(params) {
    return {
      kind: 'BoxMesh',
      size: params.size,
      position: params.position,
      rotation: params.rotation,
      // C-1 (V10/H14 two-layer guard): the hydrate seam can bypass paramSchema
      // parse (in-memory state surgery / test fixtures / agent ops), so default
      // identity HERE too, not just in the schema + migration.
      scale: params.scale ?? [1, 1, 1],
      material: params.material,
    };
  },
};
