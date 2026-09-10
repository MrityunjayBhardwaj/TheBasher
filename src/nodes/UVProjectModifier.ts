// UVProjectModifier (#994) — THE FIRST OPERATOR IN THIS PROJECT THAT AUTHORS AN ATTRIBUTE
// LAYER RATHER THAN GEOMETRY.
//
// Every other member of the modifier stack answers "what shape is this?". This one hands its
// input's shape straight through — same faces, same points, same edges, in the same order, off
// the same `BufferGeometry` instance — and produces a corner-domain UV layer instead.
//
// ── WHY THAT MAKES IT WORTH BUILDING ──────────────────────────────────────────────────
//
// The corner domain has had exactly one producer, and it is a LIFT: `readMeshUVs` gathers a
// per-vertex `uv` buffer through the polygon rims, so its value is a function of the render
// vertex and two loops meeting at one vertex agree by construction ([[V449]]). A cube
// projection chooses its side per FACE, from that face's normal — the reference's rule,
// *"each face will choose the closest and aligned projector with its surface normal"* — so its
// value is a function of (face, corner) and those two loops can disagree. Measured on an 8x6
// sphere the moment this landed: 45 render vertices read by more than one loop, **22 of them
// carrying differing projected values**, against 0 for the lift and 0 for the same code with
// the per-face choice removed, over the identical 45.
//
// ── 🔴 WHAT A DIRECTOR SEES TODAY: NOTHING. READ THIS BEFORE ASSUMING IT IS BROKEN ────
//
// Adding this modifier changes no pixel. The layer it authors has no reader in production —
// censused, and the only readers are its own gate and the producer census — so the mesh draws
// exactly as it did before. Materialising the layer to the render buffer is #786, and it is a
// tessellation change rather than an omission here: wherever two corners at one render vertex
// disagree, the buffer has to SPLIT that vertex, and that is a different operator's work.
//
// ⚠️ AND THAT MAKES THIS AN ADVERTISED ACTION THAT SILENTLY DOES NOTHING, which is the exact
// shape `ModifierStackControls` refuses elsewhere: *"an add that `buildAddModifierOps` would
// refuse is not shown at all, so the panel cannot advertise an action that silently does
// nothing."* The two honest options were to ship it offered and say so, or to withhold the
// `section` declaration — and the second is unavailable without also withholding the operator,
// because in this substrate the section IS the membership ("a member joins a stack by declaring
// the section, never by having the right sockets"). So it ships offered, the cost is written
// down here rather than discovered, and the gap is FILED rather than left in a comment.
//
// ── WHAT THIS NODE DOES NOT DO, DELIBERATELY ──────────────────────────────────────────
//
// It does not put the layer on the render buffer (#786 — see above), it does not carry the
// layer through a minting kind (#881 — measured: a downstream modifier gathers its source's
// attribute KEY, and this layer cannot be in one, because a key is content-derived while the
// values need built positions), and there is no seam marking or unwrapping here. A projection
// needs no seams, which is exactly why it is the smallest producer that qualifies.
//
// ── WHY THERE IS NO `scope` ───────────────────────────────────────────────────────────
//
// The generators carry one because a scoped generator is meaningful — it generates from the
// subset and preserves the whole input. The reference's UV Project modifier has no selection
// either: it projects the mesh. A scoped projection would have to say what the UNPROJECTED
// faces carry at a domain whose materialisation is #786's open question, so it is left out by
// decision rather than by oversight — and being left out, it cannot be answered wrongly.
//
// REF: src/app/uvProjection.ts (`projectMeshUVs` — the projection, and why it is on the read
//      road); src/app/modifierGeometry.ts (`uvProjectGeometryRef`); src/nodes/types.ts (the
//      `uvProject` descriptor, and why a projection had to be one);
//      manual/modeling/modifiers/modify/uv_project.rst + manual/modeling/meshes/editing/uv.rst
//      (the per-face projector rule and *Cube Size*); issues #994, #786, #881, #959.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { ObjectData } from './types';
import { uvProjectGeometryRef } from '../app/modifierGeometry';
import { modifierDataSource, slotTableThrough } from '../app/modifierDataSource';

export const UVProjectModifierParams = z.object({
  /**
   * The virtual cube's edge length in the mesh's local units — the reference's *Cube Size*,
   * with the cube centred on the local origin and aligned to the local axes.
   *
   * Default 2 rather than 1 because this project's primitives are geometry-centred and unit
   * sized: a size-1 cube over a size-1 box maps its corners to exactly 0 and 1, i.e. the
   * texture's outer edge, where a wrap mode decides the answer. 2 puts a unit box in the middle
   * half of the map, where nothing about the picture depends on a sampler setting.
   */
  size: z.number().default(2),
  /**
   * Stack mute-bypass (V58). The param CARRIES the state; `chain.bypass` below names it and the
   * evaluator honours it, handing the spine value back without running `evaluate`. Nothing in
   * this file reads it.
   */
  muted: z.boolean().default(false),
});
export type UVProjectModifierParams = z.infer<typeof UVProjectModifierParams>;

export const UVProjectModifierNode: NodeDefinition<UVProjectModifierParams, ObjectData> = {
  type: 'UVProjectModifier',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: UVProjectModifierParams,
  inputs: { target: { type: 'ObjectData', cardinality: 'single' } },
  outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
  chain: {
    input: 'target',
    // `'declined'`, not `'no-component-domain'` — the honest half of the escape hatch. This
    // spine carries an `ObjectData`, which HAS components; a scoped projection is a thing that
    // could exist and does not yet, for the reason in the header. Declaring the fact instead
    // would say this operator cannot be scoped, which is false and would stop anyone asking.
    scope: { kind: 'unscoped', why: 'declined' },
    bypass: { kind: 'passthrough', param: 'muted' },
    section: 'modifier',
  },
  inspectorSections: ['modifier'],
  home: {
    size: 'modifier',
    muted: 'modifier',
  },
  evaluate(params, inputs) {
    const src = inputs.target as ObjectData | undefined;
    // Unwired (transient authoring state) — nothing to project; stay transparent.
    if (!src) return src as unknown as ObjectData;
    const source = modifierDataSource(src);
    // Non-mesh data (curve / light / camera) — nothing has corners. Pass through unchanged,
    // the same answer every modifier in this stack gives.
    if (!source) return src;
    const geometry = uvProjectGeometryRef(source.geometry, params.size);
    return {
      kind: 'ModifiedData',
      geometry,
      material: source.material,
      ...slotTableThrough(source, geometry),
    };
  },
};
