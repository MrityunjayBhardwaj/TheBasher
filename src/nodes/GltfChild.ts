// GltfChild — an addressable proxy for ONE scene child inside a GltfAsset
// (Phase 7.7, issue #91). A glTF dropped today is a single GltfAsset node;
// its scene children (meshes, empties, bones) are name-addressed proxies the
// gizmo / NPanel / keyframe path cannot reach. This node makes each scene
// child a real, selectable, gizmo-addressable DAG node.
//
// CRITICAL — it is NOT a scene producer (R-1 / D-03 / H45 / B12):
//   - `inputs: {}` and `outputs: {}` — it feeds NOTHING into the render graph.
//   - three.js owns the geometry + skeleton + deform palette (#88). This node
//     owns ONLY the child's local TRS *override*; the renderer applies it back
//     onto the named three.js object by name lookup (the existing nodeNameMap
//     override seam, generalized from animation-only to static + manual).
//   - GltfChildValue is therefore NOT in the renderable `SceneChild` union — it
//     must never be walked as a scene object (the #88 double-render guard).
//
// CRITICAL — the value-equality trap (R-4): position/rotation/scale are SEEDED
// at import with the child's captured base TRS (gltfImportChain A2). A layering
// rule that asks "does the param differ from base?" cannot tell "user dragged
// the bone back to its base pose" from "this IS the base pose". So we carry an
// explicit `overridden` boolean-triple (default all-false). The gizmo/NPanel
// write path (Wave C) flips the matching bool true alongside the value; the
// layering primitive (Wave B) branches on the FLAG, never on value-equality.
//
// REF: THESIS.md §39 (P1 node types), §12 (projection);
//      CONTEXT 7.7 D-02/D-03/D-05; PLAN.md Wave A (A1); vyapti V1/V2/V22.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { GltfChildValue } from './types';

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const GltfChildParams = z.object({
  /**
   * Local TRS override. Seeded at import with the child's captured base TRS
   * (gltfImportChain.defaultTRS). Rotation is degrees Euler XYZ — the codebase
   * convention (Transform.rotation, TransformClipValue). NO `.default` here:
   * the importer always seeds these explicitly, and a default identity TRS
   * would corrupt the captured base for a child whose base is non-identity.
   */
  position: vec3,
  rotation: vec3,
  scale: vec3,
  /**
   * The explicit dirty signal (R-4). `true` means "the director moved this
   * component" → the manual override wins over any active clip. `false` means
   * "this is the captured base" → the clip (if any) or the base wins. The
   * gizmo/NPanel write path (Wave C) sets the matching flag alongside the
   * value. Default all-false: a freshly imported child carries only its base.
   */
  overridden: z
    .object({
      position: z.boolean(),
      rotation: z.boolean(),
      scale: z.boolean(),
    })
    .default({ position: false, rotation: false, scale: false }),
  /** The owning GltfAsset's assetRef — lets the resolver find the asset. */
  assetRef: z.string().min(1),
  /** The sanitised name key — the SAME key nodeNameMap uses. */
  childName: z.string(),
});
export type GltfChildParams = z.infer<typeof GltfChildParams>;

export const GltfChildNode: NodeDefinition<GltfChildParams, GltfChildValue> = {
  type: 'GltfChild',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: GltfChildParams,
  // NONE — not a scene producer (R-1). No edge into the render graph.
  inputs: {},
  outputs: {},
  // 'material' hosts a READ-ONLY readout of this child's embedded glTF materials
  // (UX #8) — the child owns no material PARAMS, so the section renders only the
  // GltfMaterialReadout (NPanel), not editable rows. Editing is via MaterialOverride.
  inspectorSections: ['transform', 'material'],
  evaluate(params): GltfChildValue {
    return {
      kind: 'GltfChild',
      childName: params.childName,
      assetRef: params.assetRef,
      position: params.position,
      rotation: params.rotation,
      scale: params.scale,
      overridden: params.overridden,
    };
  },
};
