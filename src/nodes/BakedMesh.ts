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
// The geometry handle and material-face schemas moved to the data half in #599 — this
// retired node borrows them back so its param shape keeps parsing until the definition
// itself goes.
import { BakedGeometryRefSchema, BakedMaterialSpecSchema } from './BakedData';

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

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
  inspectorSections: ['mesh', 'transform', 'constraint', 'driver', 'material'],
  home: {
    position: 'transform',
    rotation: 'transform',
    scale: 'transform',
    material: 'material',
  },
  // RETIRED (#388 Stage C · C5). A baked mesh is an `Object` → `BakedData` split: saved
  // projects migrate on load (v7 → v8) and Apply Transform mints the pair directly, so no
  // live `BakedMesh` node ever reaches evaluate. Kept as a hard fail-fast: if one somehow
  // does, that is a migration bug, not a silently identity-posed mesh.
  //
  // EVERYTHING ELSE IS DELIBERATELY KEPT — type, version, params, registration. The load
  // ladder normalizes a saved fused node through this definition BEFORE the format
  // migration splits it, so removing the schema would break the very projects the
  // migration exists to rescue.
  //
  // `BakedMeshValue` also survives, and not merely as a leftover: it is the RECOMPOSITION
  // TARGET. `ObjectR` rebuilds one from the pair (`bakedRecompose.ts`) and renders it
  // through `BakedMeshR`, which is how the pair and the fused node were kept on one render
  // road in the first place. The same shape the light split left behind.
  evaluate(): never {
    throw new Error('BakedMesh is retired; projects migrate to Object+BakedData on load');
  },
};
