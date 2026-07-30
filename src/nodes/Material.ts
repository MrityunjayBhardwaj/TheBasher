// Material — the material's own producer node (#394).
//
// Until now a material had no node of its own: it was a param hand-carried on each
// data node, so "these three cubes share a material" was invisible in the graph and
// true only by coincidence. This node gives the material a producer, so assignment
// becomes a drawn edge and sharing becomes a fact the graph states.
//
// It emits the FINISHED material as a tagged value (`OpenPBRMaterialValue`). That is
// the one structural commitment here, and both references draw exactly this boundary:
// Blender's Material Output takes a `NodeSocketShader`, MaterialX's
// `mtlxsurfacematerial` outputs the named type `material`. Because the output is the
// finished material, HOW it got finished stays private — textures-as-nodes (#513) can
// add input sockets, or a nested shader graph can arrive later, with this contract
// unchanged.
//
// It holds NO transform, NO geometry and is NOT a scene child: a material is not a
// thing in the scene, it is a thing scene objects point at. Its only inspector section
// is 'material', which is the same section the data nodes already render.
//
// REF: docs/OBJECT-DATA-SPLIT-DESIGN.md (the socket precedent); materialSchema.ts
//      (the one place the IR is defined/migrated/hydrated); issue #394 D1/D8.

import type { NodeDefinition } from '../core/dag/types';
import type { OpenPBRMaterialValue } from './types';
import { hydrateInlineMaterial, openpbrMaterialSchema } from './materialSchema';
import { z } from 'zod';

export const MaterialParams = z.object({
  // THE standard material — the same schema every data node uses, so a Material node
  // and an inline material are the same IR and no adapter exists between them (#394 D7:
  // the schema takes no colour argument, so this node cannot mint a special material).
  material: openpbrMaterialSchema(),
});
export type MaterialParams = z.infer<typeof MaterialParams>;

export const MaterialNode: NodeDefinition<MaterialParams, OpenPBRMaterialValue> = {
  type: 'Material',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: MaterialParams,
  inputs: {},
  // `cardinality` on an OUTPUT is not consulted by `connect` (ops.ts reads the INPUT
  // socket's cardinality to decide the persisted binding shape), and there is no arity
  // restriction on outputs — so fan-out to N consumers is already legal, which is the
  // whole point of this node. 'single' states what it emits: one material.
  outputs: { out: { type: 'Material', cardinality: 'single' } },
  inspectorSections: ['material'],
  evaluate(params) {
    return {
      kind: 'OpenPBRMaterial',
      // Hydrated at the evaluator like every other material producer: the hydrate seam
      // bypasses paramSchema parse (state surgery / fixtures / agent ops), so the value
      // handed across the socket is ALWAYS a complete IR — a consumer never has to ask
      // whether a lobe is present.
      spec: hydrateInlineMaterial(params.material),
    };
  },
};
