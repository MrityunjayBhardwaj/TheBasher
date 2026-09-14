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
// ── 🔴 WHAT A DIRECTOR SEES TODAY: THE PROJECTION. THIS BLOCK USED TO SAY THE OPPOSITE (#1038) ──
//
// What stood here read *"Adding this modifier changes no pixel … the layer it authors has no
// reader in production"*, and told the reader in the imperative not to trust their own eyes. It
// was true when written and #786 made it false: `buildUVProject` is wired into the registry's
// build dispatch (`geometryRegistry.ts`, whose own line says *"The delegation is gone; a
// projection builds"*), so the layer reaches the render buffer.
//
// MEASURED on a unit box, the drawn `uv` buffer with the modifier against without it:
//
//     box  uv (48 slots) : [0, 1, 1, 1, 0, 0, 1, 0, ...]
//     proj uv (48 slots) : [0.25, 0.75, 0.75, 0.75, 0.25, 0.25, 0.75, 0.25, ...]
//     slots DIFFERING    : 48 of 48
//
// Every slot changes. The old block is recorded rather than deleted because it is the reason a
// later session argued this operator could not be verified at all — a stale premise that keeps
// producing plausible conclusions does not correct itself, and the correction is the useful part.
//
// ⚠️ WHAT REMAINS TRUE FROM IT, AND IT IS THE INTERESTING HALF. Materialising a corner layer IS a
// tessellation change: wherever two corners at one render vertex carry different values, one slot
// cannot hold both and the vertex has to SPLIT. That is why this operator is worth having — a
// cube projection chooses its side per FACE, so the disagreement is the product, not an edge case
// — and the split is `cornerMaterialisation.ts`, reached through the build arm rather than
// deferred out of this file. So this is no longer an advertised action that does nothing; the
// paragraph that weighed shipping it offered against withholding the `section` declaration is
// spent, and is gone with the condition that made it a question.
//
// ── WHAT THIS NODE DOES NOT DO, DELIBERATELY ──────────────────────────────────────────
//
// It does not carry the
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
// faces carry — a question the materialisation does not answer, since it says how a corner value
// reaches the buffer and not what an UNPROJECTED corner's value is — so it is left out by
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
