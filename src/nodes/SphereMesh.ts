// SphereMesh — primitive UV sphere. Pure node; given (params) the
// evaluator returns a deterministic POJO that the viewport renders via
// THREE's SphereGeometry.
//
// Parallels BoxMesh's shape: position + rotation are local-space
// transforms (the geometry IS the visual; no Transform wrapping is
// required to place it). Scale falls back to params.size only for box
// — sphere ships with explicit `radius` instead, so the gizmo's scale
// mode binds to `radius` directly via the gizmo's getManipulable
// generalization (radius is a scalar, so scale-mode coerces to translate
// for now; uniform scale via gizmo is a future enhancement).

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { SphereMeshValue } from './types';

export const SphereMeshParams = z.object({
  radius: z.number().positive().default(0.5),
  widthSegments: z.number().int().positive().default(24),
  heightSegments: z.number().int().positive().default(16),
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  rotation: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  // v0.6 #1 (D-01): the non-destructive TRS transform band, SEPARATE from the
  // parametric geometry `radius`/segments. Default IDENTITY → migrated v1 projects
  // render byte-identically. (Mirrors BoxMesh.)
  scale: z.tuple([z.number(), z.number(), z.number()]).default([1, 1, 1]),
  material: z
    .object({
      name: z.string().default('default'),
      color: z.string().default('#88aaff'),
    })
    .default({ name: 'default', color: '#88aaff' }),
});
export type SphereMeshParams = z.infer<typeof SphereMeshParams>;

export const SphereMeshNode: NodeDefinition<SphereMeshParams, SphereMeshValue> = {
  type: 'SphereMesh',
  version: 2,
  pure: true,
  cost: 'cheap',
  paramSchema: SphereMeshParams,
  inputs: {},
  outputs: { out: { type: 'Mesh', cardinality: 'single' } },
  inspectorSections: ['mesh', 'transform', 'material'],
  // v0.6 #1 — v1 (no scale) → v2 (scale=identity). Lossless (V4 runner, §52).
  migrations: {
    1: (old) => ({ ...(old as object), scale: [1, 1, 1] }),
  },
  evaluate(params) {
    return {
      kind: 'SphereMesh',
      radius: params.radius,
      widthSegments: params.widthSegments,
      heightSegments: params.heightSegments,
      position: params.position,
      rotation: params.rotation,
      // C-1 (V10/H14 two-layer guard) — default identity at the evaluator too.
      scale: params.scale ?? [1, 1, 1],
      material: params.material,
    };
  },
};
