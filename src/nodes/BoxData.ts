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
import { openpbrMaterialSchema } from './materialSchema';
import { resolveNodeMaterial } from './materialSocket';
import { materialKeyOf } from './materialKey';

// Match BoxMesh's default so an Object→BoxData look is byte-identical to a box.

export const BoxDataParams = z.object({
  size: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
  // The OpenPBR inline material IR — the SAME schema BoxMesh uses (byte-identical
  // defaults + the V10/H14 three-layer hydrate guard; see materialSchema.ts).
  material: openpbrMaterialSchema(),
});
export type BoxDataParams = z.infer<typeof BoxDataParams>;

export const BoxDataNode: NodeDefinition<BoxDataParams, MeshDataValue> = {
  type: 'BoxData',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: BoxDataParams,
  inputs: {
    // #394 — the material can come from a Material node instead of this node's own
    // param. `list` cardinality is deliberate and the reason is in materialSocket.ts:
    // the binding shape is PERSISTED, so widening it later is a format migration.
    // Exactly one entry is read, which is also the whole correct answer for a
    // primitive (one slot in the reference too) until per-element material.
    material: { type: 'Material', cardinality: 'list' },
  },
  outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
  // Data owns geometry + material, NEVER a pose: no 'transform'/'constraint'
  // section (a data node has no world transform to constrain). This is exactly
  // what makes "posable" the Object's type, not a property test.
  inspectorSections: ['mesh', 'material'],
  home: {
    size: 'mesh',
    material: 'material',
  },
  evaluate(params, inputs) {
    const material = resolveNodeMaterial(inputs.material, params.material);
    return {
      kind: 'MeshData',
      geometry: boxGeometryRef(params.size),
      // A connected Material node SUPERSEDES the param, wholesale (#394 D3); with
      // nothing connected this is the param, hydrated exactly as before. The socket is
      // a FOURTH source of a material value, so it goes through the SAME hydrate seam
      // (C-1 / V10/H14) rather than around it.
      material,
      // #536 S1 — minted AFTER the fold, because the fold is what decides identity;
      // keying the authored param instead would miss two objects that resolve to the
      // same material by different routes (one linked, one authored identically).
      materialKey: materialKeyOf(material),
    };
  },
};
