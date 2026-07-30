// SetMaterialOp — the WHOLESALE material writer of the data lane (#394 S3c).
//
// This is Houdini's Material SOP and Blender Geometry Nodes' `Set Material`, in the
// position both references put it: an operator standing between the data and the
// object that wears it, replacing the material flowing through while the PROPERTY
// underneath remains the storage. It is a procedural WRITER of the material, never a
// substitute for owning one — which is why the `material` param/socket on `BoxData`
// (S2) is untouched by this node existing.
//
// SHAPE: `ObjectData → ObjectData`, exactly `ArrayModifier` (`ArrayModifier.ts:61-62`).
// That is not a symmetry argument — it is what makes this a member of the lane the
// modifier stack already lives on, so `isDataLaneOperator` walks past it for free and
// no reach, no ownership walk and no offer predicate needs a new type list.
//
// ── WHY THE MATERIAL ARRIVES BY EDGE, NOT BY A `refParams` POINTER ──────────────────
//
// PLAN-2 §3 proposed a `refParams` pointer, on the grounds that it inherits the generic
// picker and the dangling-ref guard. Measured at head, neither holds:
//   • `applyRemoveNode` (core/dag/ops.ts:169-184) REFUSES to delete a node that is still
//     consumed as an input, so an edge cannot dangle by construction. The dangling-ref
//     sweep exists for id-STRING refs, which is the shape a `refParams` pointer has.
//   • The data node's own material is already an EDGE (S2, materialSocket.ts), so the
//     section picker must drive `connect`/`disconnect` regardless. A pointer here would
//     mint a SECOND way to say "point at a Material" — the drift the one-composer gate
//     exists to stop, in the assignment vocabulary instead of the composition one.
// And the thesis reason: `Material.ts:4-6` mints this node so assignment becomes a drawn
// edge and sharing becomes a fact the graph states. A param string is invisible there.
//
// So the socket is the SAME `'Material'` socket `BoxData` declares, read through the
// SAME `materialSocket` rule — one spelling of "a material can arrive over an edge".
//
// UNWIRED IS TRANSPARENT, not empty: with nothing connected this operator passes its
// source through unchanged, so an op added before its material is picked never blanks a
// mesh. That mirrors the mute-bypass immediately above it (V58) and the unwired-target
// guard `ArrayModifier` already has.
//
// REF: src/nodes/materialSocket.ts (the socket rule); src/app/modifierGeometry.ts
//      (`modifierDataSource` — the shared classifier); src/nodes/MaterialOverrideOp.ts
//      (the sparse sibling); docs/OPERATORS-AND-LIGHTING-DESIGN.md §5/§2.2; issue #394.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { ObjectData } from './types';
import { modifierDataSource } from '../app/modifierGeometry';
import { isMaterialLinked, resolveNodeMaterial } from './materialSocket';

export const SetMaterialOpParams = z.object({
  /** Stack mute-bypass (V58): true → pass the source through unchanged. */
  muted: z.boolean().default(false),
});
export type SetMaterialOpParams = z.infer<typeof SetMaterialOpParams>;

export const SetMaterialOpNode: NodeDefinition<SetMaterialOpParams, ObjectData> = {
  type: 'SetMaterialOp',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: SetMaterialOpParams,
  inputs: {
    target: { type: 'ObjectData', cardinality: 'single' },
    // `list`, byte-identically to `BoxData.inputs.material` — the binding shape is
    // PERSISTED, so the cardinality is a format decision and it is made once, here and
    // there, the same way. Exactly one entry is read (materialSocket.ts).
    material: { type: 'Material', cardinality: 'list' },
  },
  outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
  // NO inspector section, and that is the reference's own answer rather than a gap.
  // Blender's Material Properties panel is Slot List → Data-Block row → Link selector
  // (`render/materials/assignment.rst:19-101`); its `Set Material` is a GEOMETRY NODES
  // node, authored in the node editor, and never appears in that panel. This node has
  // nothing a panel could author either: its material arrives over an edge (drawn in the
  // graph) and `muted` is a stack control. Declaring 'material' here would ship a titled,
  // permanently empty card — the exact shape the #458 reachability gate exists to catch.
  evaluate(params, inputs) {
    const src = inputs.target as ObjectData | undefined;
    // Unwired target (transient authoring state) — nothing to write onto.
    if (!src) return src as unknown as ObjectData;
    // Mute-bypass (V58) — identity passthrough, byte-identical to no operator.
    if (params.muted) return src;
    // No material picked yet — transparent, never a blanked mesh.
    if (!isMaterialLinked(inputs.material)) return src;
    const source = modifierDataSource(src);
    // Non-mesh data (curve / light / camera) — nothing wears a material. Measured on
    // the same reference ground as the modifier's passthrough (GT_BLENDER_MODIFIER_DATA §9).
    if (!source) return src;
    return {
      kind: 'ModifiedData',
      // The geometry rides through UNTOUCHED — this operator has an opinion about the
      // material only. It is `ModifiedData` rather than the source's own kind because
      // that is the one member of the union produced BY an operator, and it is the one
      // whose `material` carries the wide Inline|Baked union a chained source needs.
      geometry: source.geometry,
      // Hydrated by the socket rule, so what leaves here is always a complete IR.
      material: resolveNodeMaterial(inputs.material, undefined),
    };
  },
};
