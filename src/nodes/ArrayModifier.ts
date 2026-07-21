// ArrayModifier — the FIRST geometry MODIFIER (SOP), the geometry half of [[V58]]
// (epic #201, #209). A modifier is a `Mesh → Mesh` wrapper sub-chain node (the
// §2.2 model): it consumes a source mesh, rewrites its GEOMETRY (here: replicate
// `count` copies along `offset`, merged), and INHERITS the source's transform +
// material so the result sits where the source was. Unlike a Track-To CONSTRAINT
// (which needs world position → resolves edge-less at the scene layer, [[V60]]), a
// geometry modifier needs only the mesh VALUE → it IS an edge-wired sub-chain node
// (the contrast that confirms §2.2 fits geometry but not constraints).
//
// Non-destructive (V58): geometry is a rebuildable `GeometryRef` handle
// (geometryRegistry builds the `array` descriptor on demand). The renderer reads
// the EVALUATED mesh — same band as primitives (H40), never a re-walk. `muted`
// bypasses the operator: evaluate returns the source UNCHANGED (the stack's
// mute-bypass, V58), so a muted modifier is byte-identical to no modifier.
//
// v1 scope: box/sphere sources build sync. A baked source produces a real
// ModifiedMesh that INHERITS the baked material (#358), but its array geometry is
// not sync-buildable yet (a follow-up); glTF/Group/etc. still pass THROUGH unchanged.
//
// REF: src/app/modifierGeometry.ts (the shared projection + array-wrap);
//      src/app/geometryRegistry.ts (build 'array'); src/nodes/Transform.ts (the
//      Mesh→Mesh wrapper template); docs/OPERATORS-AND-LIGHTING-DESIGN.md §5/§2.2.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { SceneChild } from './types';
import { arrayGeometryRef, modifierSource } from '../app/modifierGeometry';

export const ArrayModifierParams = z.object({
  /** Number of copies (the source counts as copy 0). ≥1; default 3 for a clear proof. */
  count: z.number().int().min(1).default(3),
  /** Per-copy translation in the source's LOCAL space (copy i sits at i*offset). */
  offset: z.tuple([z.number(), z.number(), z.number()]).default([2, 0, 0]),
  /** Stack mute-bypass (V58): true → pass the source through unchanged. */
  muted: z.boolean().default(false),
});
export type ArrayModifierParams = z.infer<typeof ArrayModifierParams>;

export const ArrayModifierNode: NodeDefinition<ArrayModifierParams, SceneChild> = {
  type: 'ArrayModifier',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: ArrayModifierParams,
  inputs: { target: { type: 'SceneObject', cardinality: 'single' } },
  outputs: { out: { type: 'SceneObject', cardinality: 'single' } },
  inspectorSections: ['modifier'],
  evaluate(params, inputs) {
    const src = inputs.target as SceneChild | undefined;
    // Unwired (transient authoring state) — nothing to modify; stay transparent.
    if (!src) return src as unknown as SceneChild;
    // Mute-bypass (V58) — identity passthrough, byte-identical to no modifier.
    if (params.muted) return src;
    const source = modifierSource(src);
    // Non-modifiable source (glTF / Group / Scatter / an Empty) — pass through.
    if (!source) return src;
    const t = source.transform;
    return {
      kind: 'ModifiedMesh',
      geometry: arrayGeometryRef(source.geometry, params.count, params.offset),
      position: t.position,
      rotation: t.rotation,
      scale: t.scale,
      material: source.material,
    };
  },
};
