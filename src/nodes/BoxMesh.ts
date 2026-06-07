import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { BoxMeshValue } from './types';
import {
  hydrateInlineMaterial,
  migrateInlineMaterialV2toV3,
  openpbrMaterialSchema,
} from './materialSchema';

const BOX_DEFAULT_COLOR = '#5af07a';

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
  // v0.6 #2 (#178): the OpenPBR core-10 inline material IR (layer 1 — NEW-node
  // defaults). See materialSchema.ts for the V10/H14 three-layer guard.
  material: openpbrMaterialSchema(BOX_DEFAULT_COLOR),
});
export type BoxMeshParams = z.infer<typeof BoxMeshParams>;

export const BoxMeshNode: NodeDefinition<BoxMeshParams, BoxMeshValue> = {
  type: 'BoxMesh',
  version: 4,
  pure: true,
  cost: 'cheap',
  paramSchema: BoxMeshParams,
  inputs: {},
  outputs: { out: { type: 'Mesh', cardinality: 'single' } },
  inspectorSections: ['mesh', 'transform', 'material'],
  // v0.6 #1 — v1 (no scale) → v2 (scale=identity). Lossless: every other param
  // is preserved untouched; scale defaults to identity so the rendered result is
  // unchanged. (V4 migration runner, THESIS §52.)
  // v0.6 #2 (#178) — v2 ({name,color}) → v3 (OpenPBR IR). migrations[2] seeds the
  // CURRENT-LOOK constants (roughness 0.5, R1) so a saved project renders
  // byte-identically — DELIBERATELY different from the zod NEW-node defaults
  // (roughness 0.3). See materialSchema.ts (the V10/H14 three-layer guard).
  // v0.6 #3 (#181) — v3 → v4 adds the inline material's `uvTransform` (IDENTITY).
  // hydrateInlineMaterial fills it with identity tiling/offset/rotation, so a
  // saved #2-era project renders byte-identically (V10/H14 — see materialSchema).
  migrations: {
    1: (old) => ({ ...(old as object), scale: [1, 1, 1] }),
    2: (old) => ({
      ...(old as object),
      material: migrateInlineMaterialV2toV3(
        (old as { material?: unknown }).material,
        BOX_DEFAULT_COLOR,
      ),
    }),
    3: (old) => ({
      ...(old as object),
      material: hydrateInlineMaterial((old as { material?: unknown }).material, BOX_DEFAULT_COLOR),
    }),
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
      // v0.6 #2 (#178) layer 3 — hydrate the inline material with `?? default`
      // per field (dual-accepts a legacy top-level color mid-migration).
      material: hydrateInlineMaterial(params.material, BOX_DEFAULT_COLOR),
    };
  },
};
