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
// ── THE SCOPING RULE, AND THE HALF OF IT THAT IS OURS (ns-2 step 13a, plan §2.2) ───────
//
//     A SCOPED GENERATOR PRESERVES ITS WHOLE INPUT AND GENERATES FROM THE SUBSET.
//
// So an array of `count` copies over a source scoped to a subset yields
// `source + subset x (count - 1)` faces: copy 0 sits at the identity offset and IS the
// preserved input, and copies 1..count-1 are built from the subset alone. A box arrayed x3
// and scoped to half is `12 + 6 + 6` = 24 faces, not 36 and not 18.
//
// 🔴 FOR MIRROR THIS IS GROUNDED; FOR ARRAY IT IS **OURS**, and the difference is stated
// here rather than left for a reader to assume the whole rule was inherited. Houdini's
// Mirror SOP documents *Keep Original* — "Preserves the input geometry" — against a *Group*
// that is "Primitives to mirror", so the preserved thing is the whole input and the
// generated thing is the subset. Copy and Transform's page does NOT decide the array case:
// "a subset of input primitives to copy from" reads `subset x count` just as well, which
// would make a scoped x3 yield 18. We extend Mirror's rule to Array by consistency, and
// that is a local decision, not a reading.
//
// THE ROW THAT MAKES THE CHOICE VISIBLE RATHER THAN ASSUMED is `count = 1`: under our rule
// a scoped array of one copy is the whole source (12 faces for a box), under the rival it
// is the subset (6). ⚠️ And that row is GREEN on an implementation that ignores the scope
// entirely, so it separates the two SEMANTICS and proves nothing about honouring — never
// cite it without the 24-faces-not-36 row beside it.
//
// v1 scope: box/sphere data builds sync. Baked data produces real `ModifiedData` that
// INHERITS the baked material (#358), but its array geometry is not sync-buildable yet
// (a follow-up). Non-mesh data (curve/light/camera) passes THROUGH unchanged; a Group
// or a glTF import can no longer be wired here at all, because they emit `SceneObject`
// and this socket takes `ObjectData` — the type system now says what a banner used to.
//
// REF: src/app/modifierDataSource.ts (`modifierDataSource` — the shared classifier +
//      array-wrap); src/app/geometryRegistry.ts (build 'array'); src/nodes/types.ts
//      (`ModifiedDataValue`); docs/OBJECT-DATA-SPLIT-DESIGN.md §3.1;
//      docs/OPERATORS-AND-LIGHTING-DESIGN.md §5/§2.2; issue #415.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { ScopeDomain } from './attributes';
import type { ObjectData } from './types';
import { arrayGeometryRef } from '../app/modifierGeometry';
import { modifierDataSource, slotTableThrough } from '../app/modifierDataSource';
import { requireResolvedScope, SCOPE_PARAM, scopeParam } from './componentSelection';

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
  /**
   * THE COMPONENT SCOPE — which faces this generator REPLICATES FROM (ns-2 step 13a).
   *
   * The second `scope` param in the repo and the FIRST on the `'source'` lane, so the two
   * lanes are now both represented: `SetMaterialOp`'s selection names which faces receive a
   * write, and this one names which faces are generated from. Same param name, same
   * refinement, opposite jobs — which is exactly why the meaning lives in
   * {@link NodeDefinition.chain}`.scope.kind` and not in the param.
   *
   * ⚠️ NOTHING IN THIS FILE READS IT, and that is the same shape as `muted` one field up.
   * The param CARRIES the authored text; the evaluator resolves it through the ONE resolver
   * and hands `evaluate` the answer. A generator that read this field itself would be a
   * second producer of the descriptor's scope beside the resolver — the per-member spelling
   * this phase exists to delete — and it would also make this step's own detector
   * impossible, since discarding the resolved selection would then change nothing.
   *
   * 🔴 `.refine()` IS LOAD-BEARING, for the reason `SetMaterialOp` states at length: every
   * refusal in the language is a THROW, `evaluate` runs on the render walk with no `try`
   * above it, and this project has no node-error surfacing at all. Refining here means an
   * unparseable query never enters params — the bad state has no constructor rather than a
   * handler. Blank is the same authoring state as absent: the author cleared the field.
   */
  [SCOPE_PARAM]: scopeParam(),
});
export type ArrayModifierParams = z.infer<typeof ArrayModifierParams>;

/**
 * The atom class this operator's scope names — declared here, read twice (#714).
 *
 * WHY it is a per-operator `const` rather than a shared one, and why it is not read off the
 * resolved selection, is one fact about the TYPE and lives with the type: see
 * {@link ScopeDomain} in `attributes.ts`. This line is the decision; that is the reasoning.
 */
const SCOPE_DOMAIN: ScopeDomain = 'face';

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
    scope: { kind: 'source', domain: SCOPE_DOMAIN },
    bypass: { kind: 'passthrough', param: 'muted' },
    section: 'modifier',
  },
  inspectorSections: ['modifier'],
  home: {
    count: 'modifier',
    offset: 'modifier',
    muted: 'modifier',
    [SCOPE_PARAM]: 'modifier',
  },
  // ns-2 step 9b — `scope` is the resolved component selection the evaluator hands every
  // node whose chain declares one. REQUIRED here (not `scope?`), because the population of
  // this signature is exactly the operators declaring a `source` or `target` scope — three
  // today, derived by `operatorChainDeclaration.gate.test.ts` rather than restated here —
  // and forgetting it is the road the phase exists to close; refused at RUNTIME as well, because a required parameter closes
  // the omission only in production ([[H327]]).
  //
  // 🔴 STEP 13a — THE FIRST `'source'` CONSUMER. Read, not merely received.
  //
  // What a generator does with a selection is not what a writer does with one. A writer
  // walks the accessor and decides per element. A generator hands its scope to a
  // `GeometryRef`, whose descriptor is a rebuild recipe the registry re-reads later, off
  // this road, with no selection anywhere in reach — so the thing that must travel is the
  // selection's IDENTITY, and that is `canonicalQuery`. `faceCountOf` and the registry's
  // builder then agree about what it means (step 12.5), which is why those two had to land
  // before this line could exist.
  //
  // ⚠️ `null` HERE COVERS TWO DIFFERENT SITUATIONS AND BOTH WANT AN UNSCOPED KEY: the
  // resolver's declared "this value has no component domain" (a curve, a `gltf`/`baked`
  // handle, an unwired spine), and an unscoped total selection. An AUTHORED scope over a
  // value that cannot carry one never arrives — it is a named throw from the resolver, one
  // frame earlier, on purpose.
  evaluate(params, inputs, _ctx, scope) {
    const selection = requireResolvedScope(scope, 'ArrayModifier');
    const src = inputs.target as ObjectData | undefined;
    // Unwired (transient authoring state) — nothing to modify; stay transparent.
    if (!src) return src as unknown as ObjectData;
    const source = modifierDataSource(src);
    // Non-mesh data (curve / light / camera) — pass through unchanged.
    if (!source) return src;
    const geometry = arrayGeometryRef(
      source.geometry,
      params.count,
      params.offset,
      selection?.canonicalQuery,
      SCOPE_DOMAIN,
    );
    return {
      kind: 'ModifiedData',
      geometry,
      material: source.material,
      ...slotTableThrough(source, geometry),
    };
  },
};
