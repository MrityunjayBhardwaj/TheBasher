// BakedData — the DATA half of the object↔data split for the baked mesh
// (#388, Stage C · C5).
//
// A baked mesh's substance is the OPFS-persisted vertex buffer and the material
// captured with it; where it sits is a pose the Object owns. This node owns that
// substance and DELIBERATELY no transform. An `Object → BakedData` pair renders
// what the fused `BakedMesh` rendered, with the pose supplied by the Object.
//
// ⚠️ IT DOES NOT PRODUCE A `MeshData`, and that is the whole design decision here.
// The field lists match (`{geometry, material}`), it typechecks, and it is broken:
// emitting a baked payload as `MeshData` renders the material as the grey #808080
// fallback and the geometry as NOTHING, both silently (measured before this node
// was written — see the issue). `MeshData`'s consumers assume the RECIPE road:
// rebuildable from params, resolved synchronously through `geometryRegistry`, with
// an inline OpenPBR material. A baked buffer is the BUFFER road: authoritative,
// content-hashed, reached asynchronously through OPFS + Suspense, with a flat
// `BakedMaterialSpec` carrying six texture slots. Same shape, different contract —
// so it takes its own member of the closed `ObjectData` union, which turns "a
// consumer has not learned the async road" from an empty viewport into a compile
// error. Blender agrees from its own side: its Mesh datablock always holds real
// vertices, and the procedural cases live in modifiers.
//
// This is now the ONLY shape a baked mesh takes. The format migration (v7 → v8) splits
// every saved fused baked mesh into the pair, `dispatchApplyTransform` mints the pair at
// both of its sites, all three `!== 'MeshData'` guards discriminate instead of absorbing,
// and the fused `BakedMesh` is a throwing relic kept only so the load ladder can still
// normalize a saved fused node on its way through the migration. `ObjectR` renders the
// pair by recomposing it onto `BakedMeshR` — the SAME async-geometry + baked-material
// road the fused node drew through (`bakedRecompose.ts`).
//
// H14 hydrate seam: `evaluate` re-guards nothing here because BOTH params are
// REQUIRED with no meaningful default — a baked mesh without its buffer handle or
// its captured material is not a baked mesh, and inventing one would render a
// plausible wrong thing instead of failing. This is the deliberate exception to the
// two-layer `?? default` guard, matching the fused `BakedMesh`, whose `geometry`
// and `material` are likewise undefaulted.
//
// REF: src/nodes/BakedMesh.ts (the fused node + the shared handle/material schemas);
//      src/app/geometryRegistry.ts (why a baked ref resolves to null synchronously);
//      docs/OBJECT-DATA-SPLIT-DESIGN.md §3.1; issue #388.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { BakedDataValue } from './types';
import { BakedGeometryRefSchema, BakedMaterialSpecSchema } from './BakedMesh';

export const BakedDataParams = z.object({
  /** The OPFS handle. Required — see the hydrate-seam note above. */
  geometry: BakedGeometryRefSchema,
  /** The ONE rich material face captured at bake time (M6). Required. */
  material: BakedMaterialSpecSchema,
});
export type BakedDataParams = z.infer<typeof BakedDataParams>;

export const BakedDataNode: NodeDefinition<BakedDataParams, BakedDataValue> = {
  type: 'BakedData',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: BakedDataParams,
  inputs: {},
  outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
  // Data owns geometry + material, NEVER a pose: no 'transform'/'constraint'
  // section. The fused `BakedMesh` declared both plus 'driver'; the pose bands go
  // to the Object, and so does 'driver' — a driver stack manages a value's lifetime
  // rather than editing it, so it aggregates under the Object.
  //
  // NO 'mesh' SECTION EITHER, and that is a correction the section gate made rather
  // than a preference. `BoxData` earns its 'mesh' tab by having an editable `size`
  // row; a baked mesh's geometry is an opaque content-hashed handle with nothing to
  // edit, so declaring 'mesh' here yields an EMPTY tab — the exact defect C2 shipped
  // for the curve. The fused `BakedMesh` declares 'mesh' and has the same emptiness;
  // it is simply not an ObjectData producer, so the gate never asked it. If a
  // read-only baked-geometry readout (vertex count, hash) is wanted, it needs a
  // control before the section can be declared, not after.
  inspectorSections: ['material'],
  home: {
    material: 'material',
  },
  evaluate(params) {
    return {
      kind: 'BakedData',
      geometry: params.geometry,
      material: params.material,
    };
  },
};
