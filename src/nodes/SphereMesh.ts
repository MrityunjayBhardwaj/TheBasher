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
import {
  hydrateInlineMaterial,
  migrateInlineMaterialV2toV3,
  openpbrMaterialSchema,
} from './materialSchema';

const SPHERE_DEFAULT_COLOR = '#88aaff';

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
  // v0.6 #2 (#178): the OpenPBR core-10 inline material IR (mirrors BoxMesh).
  material: openpbrMaterialSchema(SPHERE_DEFAULT_COLOR),
});
export type SphereMeshParams = z.infer<typeof SphereMeshParams>;

export const SphereMeshNode: NodeDefinition<SphereMeshParams, SphereMeshValue> = {
  type: 'SphereMesh',
  version: 4,
  pure: true,
  cost: 'cheap',
  paramSchema: SphereMeshParams,
  inputs: {},
  outputs: { out: { type: 'Mesh', cardinality: 'single' } },
  inspectorSections: ['mesh', 'transform', 'material'],
  // v0.6 #1 — v1 (no scale) → v2 (scale=identity). Lossless (V4 runner, §52).
  // v0.6 #2 (#178) — v2 ({name,color}) → v3 (OpenPBR IR), seeds current look (R1).
  // v0.6 #3 (#181) — v3 → v4 adds the material's `uvTransform` (IDENTITY via
  // hydrate) so a saved #2-era project renders byte-identically (V10/H14).
  migrations: {
    1: (old) => ({ ...(old as object), scale: [1, 1, 1] }),
    2: (old) => ({
      ...(old as object),
      material: migrateInlineMaterialV2toV3(
        (old as { material?: unknown }).material,
        SPHERE_DEFAULT_COLOR,
      ),
    }),
    3: (old) => ({
      ...(old as object),
      material: hydrateInlineMaterial(
        (old as { material?: unknown }).material,
        SPHERE_DEFAULT_COLOR,
      ),
    }),
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
      // v0.6 #2 (#178) layer 3 — hydrate the inline material with `?? default`.
      material: hydrateInlineMaterial(params.material, SPHERE_DEFAULT_COLOR),
    };
  },
};
