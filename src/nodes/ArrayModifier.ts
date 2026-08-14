// ArrayModifier — the FIRST geometry MODIFIER (SOP), the geometry half of [[V58]]
// (epic #201, #209). A modifier is a `data → data` sub-chain node (the §2.2 model):
// it consumes source mesh DATA, rewrites its GEOMETRY (here: replicate `count`
// copies along `offset`, merged), and inherits the source's MATERIAL. Unlike a
// Track-To CONSTRAINT (which needs world position → resolves edge-less at the scene
// layer, [[V60]]), a geometry modifier needs only the mesh VALUE → it IS an
// edge-wired sub-chain node (the contrast that confirms §2.2 fits geometry but not
// constraints).
//
// #415 MOVED IT ONTO THE DATA LANE: `BoxData → ArrayModifier → Object`, where it used
// to sit DOWNSTREAM of the object (`Object → ArrayModifier → Scene`). Two things follow,
// and both are the point rather than side effects:
//   1. THE OBJECT IS THE SCENE OBJECT AGAIN. Selection, the gizmo, the outliner and
//      every id-keyed reference land on the Object, not on the operator standing in
//      front of it. A modifier is a property OF an object, never a thing that replaces
//      it — which is what both references do (Blender: the stack lives on the object,
//      between mesh datablock and object transform; Houdini: a SOP chain inside the OBJ).
//   2. IT NO LONGER CARRIES A TRANSFORM. `ModifiedData` is `ModifiedMesh` minus the TRS
//      because a data node has no pose to carry — the Object above the stack owns it,
//      applied ONCE above the whole chain rather than inherited hop by hop
//      (`ref/houdini/SOP.md:128` S8; Blender 5.1.1 measured, GT §3).
//
// Non-destructive (V58): geometry is a rebuildable `GeometryRef` handle
// (geometryRegistry builds the `array` descriptor on demand). The renderer reads
// the EVALUATED mesh — same band as primitives (H40), never a re-walk. `muted`
// bypasses the operator (the stack's mute-bypass, V58), so a muted modifier is
// byte-identical to no modifier. That bypass is DECLARED in `chain.bypass` below and
// honoured by the evaluator, which hands the spine value straight back — `evaluate`
// does not run and does not read the field. Being bypassable belongs to the operator
// CATEGORY, not to this node.
//
// v1 scope: box/sphere data builds sync. Baked data produces real `ModifiedData` that
// INHERITS the baked material (#358), but its array geometry is not sync-buildable yet
// (a follow-up). Non-mesh data (curve/light/camera) passes THROUGH unchanged; a Group
// or a glTF import can no longer be wired here at all, because they emit `SceneObject`
// and this socket takes `ObjectData` — the type system now says what a banner used to.
//
// REF: src/app/modifierGeometry.ts (`modifierDataSource` — the shared classifier +
//      array-wrap); src/app/geometryRegistry.ts (build 'array'); src/nodes/types.ts
//      (`ModifiedDataValue`); docs/OBJECT-DATA-SPLIT-DESIGN.md §3.1;
//      docs/OPERATORS-AND-LIGHTING-DESIGN.md §5/§2.2; issue #415.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { ObjectData } from './types';
import { arrayGeometryRef, modifierDataSource } from '../app/modifierGeometry';

export const ArrayModifierParams = z.object({
  /** Number of copies (the source counts as copy 0). ≥1; default 3 for a clear proof. */
  count: z.number().int().min(1).default(3),
  /** Per-copy translation in the source's LOCAL space (copy i sits at i*offset). */
  offset: z.tuple([z.number(), z.number(), z.number()]).default([2, 0, 0]),
  /**
   * Stack mute-bypass (V58). The param CARRIES the state; `chain.bypass` below names it
   * and the evaluator honours it, handing the spine value back without running
   * `evaluate`. Nothing in this file reads it.
   */
  muted: z.boolean().default(false),
});
export type ArrayModifierParams = z.infer<typeof ArrayModifierParams>;

export const ArrayModifierNode: NodeDefinition<ArrayModifierParams, ObjectData> = {
  type: 'ArrayModifier',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: ArrayModifierParams,
  inputs: { target: { type: 'ObjectData', cardinality: 'single' } },
  outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
  // #396 — the spine the modifier stack walks down. Unary today, so this names the
  // only input; it is declared anyway because the walkers now READ it rather than
  // assuming the name `target`.
  chain: {
    input: 'target',
    // A generator: the selection names which faces it GENERATES FROM. It preserves its
    // whole input and replicates the subset.
    scope: { kind: 'source' },
    bypass: { kind: 'passthrough', param: 'muted' },
    section: 'modifier',
  },
  inspectorSections: ['modifier'],
  home: {
    count: 'modifier',
    offset: 'modifier',
    muted: 'modifier',
  },
  evaluate(params, inputs) {
    const src = inputs.target as ObjectData | undefined;
    // Unwired (transient authoring state) — nothing to modify; stay transparent.
    if (!src) return src as unknown as ObjectData;
    const source = modifierDataSource(src);
    // Non-mesh data (curve / light / camera) — pass through unchanged.
    if (!source) return src;
    return {
      kind: 'ModifiedData',
      geometry: arrayGeometryRef(source.geometry, params.count, params.offset),
      material: source.material,
    };
  },
};
