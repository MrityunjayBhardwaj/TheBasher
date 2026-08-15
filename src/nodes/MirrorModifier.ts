// MirrorModifier — the SECOND geometry MODIFIER (SOP), epic #201 / #209, the
// geometry half of [[V58]]. Like the ArrayModifier it is a `data → data` sub-chain
// node (the §2.2 model): it consumes source mesh DATA, rewrites its GEOMETRY (here:
// reflect across a local-origin plane and merge the reflection back with the
// original → a symmetric whole, Blender's Mirror), and inherits the source's MATERIAL.
//
// It exists to PROVE the modifier substrate generalizes: a new modifier is just a
// node + a `geometryRegistry.build` branch + the shared projection key + four
// one-line registrations (MODIFIER_NODE_TYPES, the ADDABLE list, the agent
// ModifierType enum, registerAll). The read road and `ModifiedMeshR` are GENERIC over
// any modifier — no per-modifier render branch. #415 confirmed the claim the cheap
// way: moving the stack onto the data lane changed both modifiers identically, and
// nothing downstream of them at all.
//
// #415 — see the ArrayModifier header for the topology and why the TRS left: the
// modifier now sits BETWEEN the data node and the Object (`BoxData → Mirror → Object`)
// instead of downstream of the Object, so the Object stays the scene object and owns
// the pose, applied once above the whole stack.
//
// Non-destructive (V58): the geometry is a rebuildable `GeometryRef` handle
// (geometryRegistry builds the `mirror` descriptor on demand). `muted` bypasses
// the operator, byte-identical to no modifier — DECLARED in `chain.bypass` below and
// honoured by the evaluator, which hands the spine value back without calling
// `evaluate`. v1 scope: box/sphere data (sync registry build); baked data passes its
// material through but is not sync-buildable (async geometry — a clean follow-up),
// and non-mesh data (curve/light/camera) passes THROUGH unchanged.
//
// REF: src/nodes/ArrayModifier.ts (the sibling modifier template);
//      src/app/modifierGeometry.ts (the shared projection + mirror-wrap);
//      src/app/geometryRegistry.ts (build 'mirror'); docs/OPERATORS-AND-LIGHTING-DESIGN.md §5/§2.2.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { ObjectData } from './types';
import { mirrorGeometryRef } from '../app/modifierGeometry';
import { modifierDataSource } from '../app/modifierDataSource';

export const MirrorModifierParams = z.object({
  /** The axis to reflect across (the negated component). Default 'x' (the most common). */
  axis: z.enum(['x', 'y', 'z']).default('x'),
  /** Distance of the mirror plane from the local origin along `axis`. 0 = origin
   *  mirror (Blender's default); a non-zero value separates the halves (useful for
   *  v1's geometry-centered primitives, which an origin mirror would overlap). */
  offset: z.number().default(0),
  /**
   * Stack mute-bypass (V58). The param CARRIES the state; `chain.bypass` below names it
   * and the evaluator honours it, handing the spine value back without running
   * `evaluate`. Nothing in this file reads it.
   */
  muted: z.boolean().default(false),
});
export type MirrorModifierParams = z.infer<typeof MirrorModifierParams>;

export const MirrorModifierNode: NodeDefinition<MirrorModifierParams, ObjectData> = {
  type: 'MirrorModifier',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: MirrorModifierParams,
  inputs: { target: { type: 'ObjectData', cardinality: 'single' } },
  outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
  // #396 — the spine the modifier stack walks down (see ArrayModifier).
  chain: {
    input: 'target',
    // As ArrayModifier: reflect the selected faces, keep the whole original.
    scope: { kind: 'source' },
    bypass: { kind: 'passthrough', param: 'muted' },
    section: 'modifier',
  },
  inspectorSections: ['modifier'],
  home: {
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
      geometry: mirrorGeometryRef(source.geometry, params.axis, params.offset),
      material: source.material,
    };
  },
};
