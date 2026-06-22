// MirrorModifier — the SECOND geometry MODIFIER (SOP), epic #201 / #209, the
// geometry half of [[V58]]. Like the ArrayModifier it is a `Mesh → Mesh` wrapper
// sub-chain node (the §2.2 model): it consumes a source mesh, rewrites its
// GEOMETRY (here: reflect across a local-origin plane and merge the reflection
// back with the original → a symmetric whole, Blender's Mirror), and INHERITS the
// source's transform + material so the result sits where the source was.
//
// It exists to PROVE the modifier substrate generalizes: a new modifier is just a
// node + a `geometryRegistry.build` branch + the shared projection key + the
// read-side parity twin + four one-line registrations (MODIFIER_NODE_TYPES, the
// ADDABLE list, the agent ModifierType enum, registerAll). resolveEvaluatedMesh's
// recursive walk + ModifiedMeshR are GENERIC over any ModifiedMeshValue — no
// per-modifier render branch.
//
// Non-destructive (V58): the geometry is a rebuildable `GeometryRef` handle
// (geometryRegistry builds the `mirror` descriptor on demand). `muted` bypasses
// the operator: evaluate returns the source UNCHANGED, byte-identical to no
// modifier. v1 scope: box/sphere sources (sync registry build); a glTF/baked
// source passes THROUGH unchanged (async geometry — a clean follow-up).
//
// REF: src/nodes/ArrayModifier.ts (the sibling modifier template);
//      src/app/modifierGeometry.ts (the shared projection + mirror-wrap);
//      src/app/geometryRegistry.ts (build 'mirror'); docs/OPERATORS-AND-LIGHTING-DESIGN.md §5/§2.2.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { SceneChild } from './types';
import {
  mirrorGeometryRef,
  sourceGeometryRef,
  sourceMaterial,
  sourceTransform,
} from '../app/modifierGeometry';

export const MirrorModifierParams = z.object({
  /** The axis to reflect across (the negated component). Default 'x' (the most common). */
  axis: z.enum(['x', 'y', 'z']).default('x'),
  /** Distance of the mirror plane from the local origin along `axis`. 0 = origin
   *  mirror (Blender's default); a non-zero value separates the halves (useful for
   *  v1's geometry-centered primitives, which an origin mirror would overlap). */
  offset: z.number().default(0),
  /** Stack mute-bypass (V58): true → pass the source through unchanged. */
  muted: z.boolean().default(false),
});
export type MirrorModifierParams = z.infer<typeof MirrorModifierParams>;

export const MirrorModifierNode: NodeDefinition<MirrorModifierParams, SceneChild> = {
  type: 'MirrorModifier',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: MirrorModifierParams,
  inputs: { target: { type: 'SceneObject', cardinality: 'single' } },
  outputs: { out: { type: 'SceneObject', cardinality: 'single' } },
  inspectorSections: ['modifier'],
  evaluate(params, inputs) {
    const src = inputs.target as SceneChild | undefined;
    // Unwired (transient authoring state) — nothing to modify; stay transparent.
    if (!src) return src as unknown as SceneChild;
    // Mute-bypass (V58) — identity passthrough, byte-identical to no modifier.
    if (params.muted) return src;
    const ref = sourceGeometryRef(src);
    // Non-leaf-mesh source (glTF / Group / Scatter) — out of v1 scope: pass through.
    if (!ref) return src;
    const t = sourceTransform(src);
    return {
      kind: 'ModifiedMesh',
      geometry: mirrorGeometryRef(ref, params.axis, params.offset),
      position: t.position,
      rotation: t.rotation,
      scale: t.scale,
      material: sourceMaterial(src),
    };
  },
};
