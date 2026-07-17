// BoxData — the DATA half of the object↔data split (#361, Phase 1).
//
// A geometry-data node: it owns a box's geometry (a `size` capability) + its
// material, and DELIBERATELY no transform. It produces a `MeshData` value that
// carries the SAME `GeometryRef` handle the fused `BoxMesh` builds downstream
// (via the shared `boxGeometryRef`), so an `Object → BoxData` pair renders
// byte-identically to a fused `BoxMesh`. An Object supplies the transform.
//
// This coexists with `BoxMesh`; nothing migrates in Phase 1. Later phases add
// `SphereData` etc. (all producing the one `ObjectData`/`MeshData` value), and
// retire the fused nodes.
//
// REF: docs/OBJECT-DATA-SPLIT-DESIGN.md §3.1; src/app/modifierGeometry.ts
//      (boxGeometryRef — the one place a box size becomes a handle).

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { MeshDataValue } from './types';
import { boxGeometryRef } from '../app/modifierGeometry';
import { hydrateInlineMaterial, openpbrMaterialSchema } from './materialSchema';

// Match BoxMesh's default so an Object→BoxData look is byte-identical to a box.
const BOX_DEFAULT_COLOR = '#5af07a';

export const BoxDataParams = z.object({
  size: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
  // The OpenPBR inline material IR — the SAME schema BoxMesh uses (byte-identical
  // defaults + the V10/H14 three-layer hydrate guard; see materialSchema.ts).
  material: openpbrMaterialSchema(BOX_DEFAULT_COLOR),
});
export type BoxDataParams = z.infer<typeof BoxDataParams>;

export const BoxDataNode: NodeDefinition<BoxDataParams, MeshDataValue> = {
  type: 'BoxData',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: BoxDataParams,
  inputs: {},
  outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
  // Data owns geometry + material, NEVER a pose: no 'transform'/'constraint'
  // section (a data node has no world transform to constrain). This is exactly
  // what makes "posable" the Object's type, not a property test.
  inspectorSections: ['mesh', 'material'],
  evaluate(params) {
    return {
      kind: 'MeshData',
      geometry: boxGeometryRef(params.size),
      // C-1 (V10/H14): hydrate at the evaluator too — the hydrate seam can bypass
      // paramSchema parse (state surgery / fixtures / agent ops).
      material: hydrateInlineMaterial(params.material, BOX_DEFAULT_COLOR),
    };
  },
};
