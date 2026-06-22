// BakedMesh — the product of Apply-Transform (Phase 151, issue #151).
//
// A standalone scene mesh whose TRS has been composed into its geometry. Unlike
// BoxMesh/SphereMesh (re-parametrizable primitives), a BakedMesh carries:
//   - `geometry`: a `GeometryRef{kind:'baked'}` HANDLE into OPFS-persisted bytes
//     (authoritative content-hashed buffer, bakedGeometryStore.ts — NOT
//     rebuildable from params, §48/V29).
//   - identity TRS (position [0,0,0] / rotation [0,0,0] / scale [1,1,1]) — the
//     transform is baked INTO the verts, so the renderer applies identity (H40
//     band-drift guard). The TRS band stays present so the gizmo/NPanel can
//     re-transform the baked mesh afterwards (a baked mesh is first-class).
//   - `material`: the ONE rich `BakedMaterialSpec` (scalars + nullable maps, M6).
//     Primitive bakes leave all map refs null; glTF bakes capture the resolved
//     post-override material incl. textures (Wave 3/4).
//
// Pure node: evaluate(params) → BakedMeshValue. `resolveEvaluatedMesh` adds the
// 4th producer branch (no consumer branches on this kind — V29).
//
// C-1 (V10/H14 two-layer guard): scale defaults identity at the schema AND the
// evaluator, so a hydrate-seam bypass (in-memory surgery / agent ops) that omits
// scale still resolves green.
//
// REF: PLAN.md Wave 2 Task 3; RESEARCH §"BakedMesh node shape" / §M3;
//      types.ts (BakedMeshValue, BakedMaterialSpec, BakedTextureRef);
//      BoxMesh.ts (the node-def template).

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { BakedMeshValue } from './types';

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

/** Zod for a `BakedTextureRef` (Wave 3 populates these; null for primitives). */
const BakedTextureRefSchema = z.object({
  hash: z.string(),
  colorSpace: z.enum(['srgb', 'srgb-linear', 'no-colorspace']),
  flipY: z.boolean(),
  wrapS: z.number(),
  wrapT: z.number(),
});

/** Zod for the rich `BakedMaterialSpec` (the ONE material face, M6). */
export const BakedMaterialSpecSchema = z.object({
  materialClass: z.enum(['standard', 'physical', 'basic']),
  color: z.string(),
  roughness: z.number(),
  metalness: z.number(),
  opacity: z.number(),
  transparent: z.boolean(),
  emissive: z.string(),
  emissiveIntensity: z.number(),
  map: BakedTextureRefSchema.nullable(),
  normalMap: BakedTextureRefSchema.nullable(),
  roughnessMap: BakedTextureRefSchema.nullable(),
  metalnessMap: BakedTextureRefSchema.nullable(),
  aoMap: BakedTextureRefSchema.nullable(),
  emissiveMap: BakedTextureRefSchema.nullable(),
  physical: z
    .object({
      clearcoat: z.number().optional(),
      clearcoatRoughness: z.number().optional(),
      transmission: z.number().optional(),
      ior: z.number().optional(),
      sheen: z.number().optional(),
      specularIntensity: z.number().optional(),
    })
    .optional(),
});

/** Zod for the baked `GeometryRef` handle carried as a param. */
const BakedGeometryRefSchema = z.object({
  key: z.string(),
  kind: z.literal('baked'),
  descriptor: z.object({
    kind: z.literal('baked'),
    hash: z.string(),
    vertexCount: z.number(),
  }),
});

export const BakedMeshParams = z.object({
  geometry: BakedGeometryRefSchema,
  position: Vec3Schema.default([0, 0, 0]),
  rotation: Vec3Schema.default([0, 0, 0]),
  // Identity post-Apply; full TRS band kept so the baked mesh can be re-transformed.
  scale: Vec3Schema.default([1, 1, 1]),
  material: BakedMaterialSpecSchema,
});
export type BakedMeshParams = z.infer<typeof BakedMeshParams>;

export const BakedMeshNode: NodeDefinition<BakedMeshParams, BakedMeshValue> = {
  type: 'BakedMesh',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: BakedMeshParams,
  inputs: {},
  outputs: { out: { type: 'SceneObject', cardinality: 'single' } },
  inspectorSections: ['mesh', 'transform', 'material'],
  evaluate(params) {
    return {
      kind: 'BakedMesh',
      geometry: params.geometry,
      position: params.position,
      rotation: params.rotation,
      // C-1 (V10/H14 two-layer guard): default identity HERE too, not just schema.
      scale: params.scale ?? [1, 1, 1],
      material: params.material,
    };
  },
};
