// SphereData — the DATA half of the object↔data split for the sphere primitive
// (#384, Stage C · C1).
//
// A geometry-data node: it owns a sphere's geometry (`radius` + `widthSegments`
// + `heightSegments`) + its material, and DELIBERATELY no transform. It produces
// the SAME `MeshData` value `BoxData` produces (the one `ObjectData` value), and
// carries the SAME `GeometryRef` handle the fused `SphereMesh` builds downstream
// (via the shared `sphereGeometryRef`), so an `Object → SphereData` pair renders
// byte-identically to a fused `SphereMesh`. An Object supplies the transform.
//
// This coexists with `SphereMesh`; nothing migrates in C1-Slice-1. Slice 2 adds
// the v3→v4 format migration, Slice 3 flips every producer, Slice 4 retires the
// fused `SphereMeshValue` kind (the Object/MeshData arm already renders the split).
//
// REF: docs/OBJECT-DATA-SPLIT-DESIGN.md §3.1; src/nodes/BoxData.ts (the template);
//      src/app/modifierGeometry.ts (sphereGeometryRef — the one place a sphere's
//      params become a handle).

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { MeshDataValue } from './types';
import { sphereGeometryRef } from '../app/modifierGeometry';
import { hydrateInlineMaterial, openpbrMaterialSchema } from './materialSchema';

// Match SphereMesh's default so an Object→SphereData look is byte-identical to a
// fused sphere.
const SPHERE_DEFAULT_COLOR = '#88aaff';

export const SphereDataParams = z.object({
  radius: z.number().positive().default(0.5),
  widthSegments: z.number().int().positive().default(24),
  heightSegments: z.number().int().positive().default(16),
  // The OpenPBR inline material IR — the SAME schema SphereMesh uses (byte-identical
  // defaults + the V10/H14 three-layer hydrate guard; see materialSchema.ts).
  material: openpbrMaterialSchema(SPHERE_DEFAULT_COLOR),
});
export type SphereDataParams = z.infer<typeof SphereDataParams>;

export const SphereDataNode: NodeDefinition<SphereDataParams, MeshDataValue> = {
  type: 'SphereData',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: SphereDataParams,
  inputs: {},
  outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
  // Data owns geometry + material, NEVER a pose: no 'transform'/'constraint'
  // section (a data node has no world transform to constrain). This is exactly
  // what makes "posable" the Object's type, not a property test.
  inspectorSections: ['mesh', 'material'],
  evaluate(params) {
    return {
      kind: 'MeshData',
      geometry: sphereGeometryRef(params.radius, params.widthSegments, params.heightSegments),
      // C-1 (V10/H14): hydrate at the evaluator too — the hydrate seam can bypass
      // paramSchema parse (state surgery / fixtures / agent ops).
      material: hydrateInlineMaterial(params.material, SPHERE_DEFAULT_COLOR),
    };
  },
};
