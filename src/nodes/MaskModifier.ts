// MaskModifier — the THIRD geometry MODIFIER (SOP), #668 over #671's substrate.
//
// It keeps the faces its scope names and drops the rest (or the reverse). Like the Array and
// Mirror modifiers it is a `data → data` sub-chain node (the §2.2 model): it consumes source
// mesh DATA, rewrites its GEOMETRY, and inherits the source's MATERIAL.
//
// ── WHY ONE NODE CLOSES TWO ISSUES, STATED RATHER THAN ASSUMED ─────────────────────────
//
// #668 asked for a mask-class modifier — "a fourth consumer declaring `scope: 'target'` and
// reading the resolved selection like the others" — and said the work was "a node
// declaration plus a fold; there is no substrate question left in it". #671 asked for a
// composable subset operator (Houdini's Blast), rejected as a way to EXPRESS scoping but
// real on its own merits.
//
// Measured against the code, those are one operator seen from two reference lineages, and
// #668's premise was the one that had decayed: a mask must REMOVE faces, and removing faces
// needs a descriptor kind that emits fewer than it receives. The `array` descriptor's own
// comment names that kind and calls it "a different operator (Houdini's Blast)" — which is
// #671. So the substrate question #668 said was settled was in fact #671, and it lands
// first.
//
// The split follows the rule #607 already draws: THE SUBSTRATE IS HOUDINI'S, THE INTERACTION
// MODEL IS BLENDER'S. So the descriptor kind is `subset` (Blast) and the node a director
// adds to a stack is a Mask modifier, because that is the UI this product presents. Blender's
// Mask keeps its group; Houdini's Blast deletes its selection; the `keep` param is the one
// field that makes both spellings the same operator.
//
// ── WHY IT DECLARES `'target'` AND NOT `'source'` ─────────────────────────────────────
//
// The generators declare `'source'`: they PRESERVE their whole input and generate from the
// subset, which is why a mirror scoped to 6 of 12 faces yields 54 and not 36. This does the
// thing that reading is defined against — the selection names the faces the operator ACTS
// ON, and nothing is merged back. That is `'target'`: "the selection names which components
// RECEIVE the write", where the write here is survival.
//
// 🔴 AN UNCONFIGURED MASK IS TRANSPARENT, AND THAT IS A DECISION, NOT A FALLBACK. With no
// scope authored the resolver hands back a total selection whose `canonicalQuery` is `null`.
// Read naively that means "every face is selected", so `keep: false` would DELETE THE WHOLE
// MESH the moment the node was dropped into a stack — a destructive default that fires
// before the author has said anything. Both polarities therefore pass through unchanged
// until a selection exists. `subsetGeometryRef` refuses a blank scope for the same reason
// one frame later, so the state has no constructor on either road rather than being caught
// on one of them.
//
// REF: src/nodes/types.ts (the `subset` descriptor and why its scope is required);
//      src/app/geometryRegistry.ts (`buildSubset` / `faceSubset`); src/app/faceCount.ts
//      (the count and the face order that keeps per-face materials alive); issues #668,
//      #671, #607, #660.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { ScopeDomain } from './attributes';
import type { ObjectData } from './types';
import { subsetGeometryRef } from '../app/modifierGeometry';
import { modifierDataSource, slotTableThrough } from '../app/modifierDataSource';
import { requireResolvedScope, SCOPE_PARAM, scopeParam } from './componentSelection';

export const MaskModifierParams = z.object({
  /**
   * Which side of the selection survives.
   *
   * `true` (the default) keeps the selected faces and drops the rest — Blender's Mask, whose
   * group names what REMAINS. `false` drops the selection and keeps the rest — Houdini's
   * Blast, plus Blender's own Invert toggle. The default follows the interaction model,
   * because that is the surface a director reads.
   *
   * Named `keep` and not `invert` because the descriptor field it feeds is named `keep`, and
   * `geometryHandleReach.gate.test.ts` checks that correspondence by name: a descriptor field
   * an animated channel can write must be spelled exactly like the param that feeds it.
   */
  keep: z.boolean().default(true),
  /**
   * Stack mute-bypass (V58). The param CARRIES the state; `chain.bypass` below names it and
   * the evaluator honours it, handing the spine value back without running `evaluate`.
   * Nothing in this file reads it.
   */
  muted: z.boolean().default(false),
  /**
   * THE COMPONENT SCOPE — which faces this operator acts on.
   *
   * The FOURTH `scope` param in the repo and the SECOND on the `'target'` lane. Nothing in
   * this file reads it: the param carries the authored text, and the evaluator resolves it
   * through the ONE resolver and hands `evaluate` the answer. An operator reading this field
   * itself would be a second producer of the scope beside the resolver.
   *
   * 🔴 `.refine()` IS LOAD-BEARING, for the reason its siblings state: every refusal in the
   * language is a THROW, `evaluate` runs on the render walk with no `try` above it, and this
   * project has no node-error surfacing. Refining here means an unparseable query never
   * enters params. Blank is the same authoring state as absent.
   */
  [SCOPE_PARAM]: scopeParam(),
});
export type MaskModifierParams = z.infer<typeof MaskModifierParams>;

/**
 * THE ATOM CLASS THIS OPERATOR'S SCOPE NAMES — declared once, read twice (#714).
 *
 * The declaration below hands it to the evaluator, which resolves the selection at it; the
 * builder call in `evaluate` hands the same value to the descriptor, which folds it into the
 * cache key. One `const` for both because they must not be able to disagree: a selection
 * resolved at one class and a geometry keyed at another is a mesh built from the wrong set,
 * and both would draw.
 *
 * ⚠️ NOT `selection.domain`, DELIBERATELY, though at runtime it is the same value. A
 * `ComponentSelection` is a general value and its `domain` is the wide `KnownDomain` — the
 * memoisation rows construct selections at classes no operator can declare. Reading it here
 * would need a cast back down to {@link ScopeDomain}, and a cast is exactly the thing that
 * keeps compiling when the two sets stop coinciding.
 */
const SCOPE_DOMAIN: ScopeDomain = 'face';

export const MaskModifierNode: NodeDefinition<MaskModifierParams, ObjectData> = {
  type: 'MaskModifier',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: MaskModifierParams,
  inputs: { target: { type: 'ObjectData', cardinality: 'single' } },
  outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
  chain: {
    input: 'target',
    // A writer, not a generator: the selection names the faces that are acted on, and
    // nothing is merged back. See the header on why this is not `'source'`.
    scope: { kind: 'target', domain: SCOPE_DOMAIN },
    bypass: { kind: 'passthrough', param: 'muted' },
    section: 'modifier',
  },
  inspectorSections: ['modifier'],
  home: {
    keep: 'modifier',
    muted: 'modifier',
    [SCOPE_PARAM]: 'modifier',
  },
  evaluate(params, inputs, _ctx, scope) {
    const selection = requireResolvedScope(scope, 'MaskModifier');
    const src = inputs.target as ObjectData | undefined;
    // Unwired (transient authoring state) — nothing to modify; stay transparent.
    if (!src) return src as unknown as ObjectData;
    const source = modifierDataSource(src);
    // Non-mesh data (curve / light / camera) — pass through unchanged.
    if (!source) return src;
    // No selection authored yet. `null` is the resolver's declared "unscoped", which is a
    // different value from a query that happens to name every face — see the header on why
    // this passes through rather than acting on the total selection.
    const query = selection?.canonicalQuery;
    if (query === null || query === undefined) return src;
    const geometry = subsetGeometryRef(source.geometry, query, params.keep, SCOPE_DOMAIN);
    return {
      kind: 'ModifiedData',
      geometry,
      material: source.material,
      ...slotTableThrough(source, geometry),
    };
  },
};
