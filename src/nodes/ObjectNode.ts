// Object — the OBJECT half of the object↔data split (#361, Phase 1).
//
// The thing every scene object should BE (Blender/Houdini/Maya all converge):
// it OWNS the transform (position/rotation/scale) and points, through the typed
// `data` socket, at a data node that owns geometry (later: camera/light data).
// It evaluates to a `SceneObject` (`kind:'Object'`) that the renderer draws by
// composing the Object's TRS over `data.geometry` — byte-identical to the fused
// mesh it will eventually replace. `data` unset = an Empty.
//
// "Posable" is this node's TYPE, not a runtime property test — which is the whole
// point of the split (it declares 'transform'/'constraint'/'driver'; the data
// node never does). Coexists with the fused nodes in Phase 1; nothing migrates.
//
// REF: docs/OBJECT-DATA-SPLIT-DESIGN.md §3.1; src/nodes/BoxData.ts (the data half).

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { ObjectData, ObjectValue } from './types';

export const ObjectParams = z.object({
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  rotation: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  scale: z.tuple([z.number(), z.number(), z.number()]).default([1, 1, 1]),
});
export type ObjectParams = z.infer<typeof ObjectParams>;

export const ObjectNode: NodeDefinition<ObjectParams, ObjectValue> = {
  type: 'Object',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: ObjectParams,
  inputs: { data: { type: 'ObjectData', cardinality: 'single' } },
  outputs: { out: { type: 'SceneObject', cardinality: 'single' } },
  // The posable node — 'transform' implies 'constraint' (a pose can be
  // constrained) implies 'driver'. The data socket carries no pose, so those
  // sections live HERE, once, by construction.
  //
  // 'modifier' is declared here because this is what the USER SELECTS — the panel
  // resolves down to the data through `resolveStackBase`. That is a surfacing choice,
  // and deliberately NOT a claim about where the stack lives.
  //
  // ⚠️ CORRECTED (#498). This comment used to say the OBJECT owns the stack, citing
  // "Blender's model (a modifier lives on the Object, not the mesh datablock)". That was
  // true under #377 and #415 falsified it: the stack moved ONTO the data lane
  // (`BoxData → Array → Object`), which is HOUDINI's topology, not Blender's — the two
  // references agree on evaluation ORDER and disagree on wiring, and the epic chose
  // Houdini (`ref/GROUND_TRUTH_BLENDER_MODIFIER_DATA.md` §5). The placement survived the
  // flip; only its stated reason was wrong, which is the worse half to leave in place.
  //
  // ⚠️ THIS LIST IS UNCONDITIONAL, and only three of the four are unconditionally TRUE.
  // The Object owns the pose, so 'transform'/'constraint'/'driver' hold for any data —
  // including none at all. 'modifier' does NOT: a camera and a light have no geometry to
  // reshape, and before #498 they both advertised "+ Array" and the click succeeded.
  // Anything data-dependent added here must be classified in `dataSectionCapability.ts`;
  // a gate in `inspectorSectionsRegistry.test.ts` fails if it is neither that nor listed
  // as Object-owned.
  //
  // 'modifier' is appended LAST so `sections[0]` stays 'transform' and no section's
  // default-collapsed state shifts underneath the existing specs.
  inspectorSections: ['transform', 'constraint', 'driver', 'modifier'],
  home: {
    position: 'transform',
    rotation: 'transform',
    scale: 'transform',
  },
  evaluate(params, inputs) {
    return {
      kind: 'Object',
      position: params.position,
      rotation: params.rotation,
      // C-1 (V10/H14): identity default at the evaluator too (hydrate seam bypass).
      scale: params.scale ?? [1, 1, 1],
      // `data` unset → an Empty (the Group/Null/Transform collapse is a later phase).
      data: (inputs.data as ObjectData | undefined) ?? null,
    };
  },
};
