// SphereMesh — RETIRED as a live node (#384 Stage C). A sphere is now an Object → SphereData
// split; this node type stays REGISTERED solely so the load-migration (migrateFusedSphereToSplit)
// can normalize an old fused sphere through its version ladder before splitting it. Nothing
// constructs or evaluates a SphereMesh at runtime any more — `evaluate` is a retired sentinel, and
// there is no value kind carrying it (the `SphereMeshValue` interface is deleted, so the type is
// `never`). The params schema + migrations{1,2,3} are kept because the migration ladder calls them.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
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

export const SphereMeshNode: NodeDefinition<SphereMeshParams, never> = {
  type: 'SphereMesh',
  version: 4,
  pure: true,
  cost: 'cheap',
  paramSchema: SphereMeshParams,
  inputs: {},
  outputs: { out: { type: 'SceneObject', cardinality: 'single' } },
  inspectorSections: ['mesh', 'transform', 'constraint', 'driver', 'material', 'modifier'],
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
  // Retired sentinel: every fused sphere is migrated to Object+SphereData on load, so no live
  // SphereMesh node ever reaches evaluate. It is kept only as a migration relic (the ladder above).
  evaluate(): never {
    throw new Error('SphereMesh is retired; projects migrate to Object+SphereData on load');
  },
};
