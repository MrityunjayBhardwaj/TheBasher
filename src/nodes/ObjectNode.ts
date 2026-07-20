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
  // 'modifier' is here and NOT on the data node (#377), which is the whole answer
  // to "what does a geometry modifier attach to": the OBJECT owns the stack and it
  // evaluates over the object's data. That is why two Objects sharing one data node
  // can carry different stacks — Blender's model (a modifier lives on the Object,
  // not the mesh datablock) and Houdini's SOP chain have the same shape. It is
  // appended LAST so `sections[0]` stays 'transform' and no section's
  // default-collapsed state shifts underneath the existing specs.
  inspectorSections: ['transform', 'constraint', 'driver', 'modifier'],
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
