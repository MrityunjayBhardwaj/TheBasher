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
// ── THE SCOPING RULE, AND THE HALF OF IT THAT IS GROUNDED (ns-2 step 13b, plan §2.2) ───
//
//     A SCOPED GENERATOR PRESERVES ITS WHOLE INPUT AND GENERATES FROM THE SUBSET.
//
// So a mirror over a source scoped to a subset yields `source + subset` faces: the whole
// input rides through, and only the selected faces are reflected. A box mirrored and scoped
// to half is `12 + 6` = 18 faces, not 24 and not 12.
//
// 🔴 HERE THAT RULE IS THE REFERENCE'S, NOT OURS — the opposite of the sibling. Houdini's
// Mirror SOP pairs a *Group* of "Primitives to mirror" with *Keep Original*: "Preserves the
// input geometry. **When off, only the selected geometry will remain.**" The second sentence
// is the decisive one, and it decides the case Basher is in: this node hard-codes Keep
// Original ON (`mirrorGeometryRef` always merges the reflection back with the source), so the
// preserved thing is the WHOLE input and the generated thing is the subset. Keep Original OFF
// would be `subset + subset`, which this node cannot express and does not claim to.
// `ArrayModifier` extends the same rule to the array case by consistency and says so — that
// half is OURS. The asymmetry is written down at both ends rather than left to a reader who
// would otherwise assume one provenance for both.
//
// REF: src/nodes/ArrayModifier.ts (the sibling modifier template);
//      src/app/modifierGeometry.ts (the shared projection + mirror-wrap);
//      src/app/geometryRegistry.ts (build 'mirror'); docs/OPERATORS-AND-LIGHTING-DESIGN.md §5/§2.2;
//      sidefx.com/docs/houdini/nodes/sop/mirror.html (Group + Keep Original, quoted above).

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { ScopeDomain } from './attributes';
import type { ObjectData } from './types';
import { mirrorGeometryRef } from '../app/modifierGeometry';
import { modifierDataSource, slotTableThrough } from '../app/modifierDataSource';
import { requireResolvedScope, SCOPE_PARAM, scopeParam } from './componentSelection';

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
  /**
   * THE COMPONENT SCOPE — which faces this generator REFLECTS (ns-2 step 13b).
   *
   * The third `scope` param in the repo and the SECOND on the `'source'` lane, which is the
   * only reason this step exists as its own commit: `ArrayModifier` and this node share the
   * subset helper and the key builder, so a defect in either is invisible to a test that
   * reaches both sides through them ([[V189]]). The arithmetic in `MirrorModifier.test.ts` is
   * therefore asserted as LITERALS it cannot reach through the shared code.
   *
   * ⚠️ NOTHING IN THIS FILE READS IT — the same shape as `muted` one field up, and stated for
   * the same reason. The param CARRIES the authored text; the evaluator resolves it through
   * the ONE resolver and hands `evaluate` the answer. A generator reading this field itself
   * would be a second producer of the descriptor's scope beside the resolver.
   *
   * 🔴 `.refine()` IS LOAD-BEARING, and the sibling states the argument in full: every refusal
   * in the language is a THROW, `evaluate` runs on the render walk with no `try` above it, and
   * this project has no node-error surfacing at all. Refining here means an unparseable query
   * never enters params. Blank is the same authoring state as absent.
   */
  [SCOPE_PARAM]: scopeParam(),
});
export type MirrorModifierParams = z.infer<typeof MirrorModifierParams>;

/**
 * The atom class this operator's scope names — declared here, read twice (#714).
 *
 * WHY it is a per-operator `const` rather than a shared one, and why it is not read off the
 * resolved selection, is one fact about the TYPE and lives with the type: see
 * {@link ScopeDomain} in `attributes.ts`. This line is the decision; that is the reasoning.
 */
const SCOPE_DOMAIN: ScopeDomain = 'face';

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
    scope: { kind: 'source', domain: SCOPE_DOMAIN },
    bypass: { kind: 'passthrough', param: 'muted' },
    section: 'modifier',
  },
  inspectorSections: ['modifier'],
  home: {
    offset: 'modifier',
    muted: 'modifier',
    [SCOPE_PARAM]: 'modifier',
  },
  // ns-2 step 9b — see `ArrayModifier.evaluate`: required fourth argument, runtime refusal.
  //
  // 🔴 STEP 13b — THE SECOND `'source'` CONSUMER, and the point of validating a second one.
  //
  // What travels is the selection's IDENTITY (`canonicalQuery`), never the selection: the
  // descriptor is a rebuild recipe the registry re-reads later, off this road, with no
  // selection in reach. That reasoning is the sibling's and is not re-derived here — what IS
  // new is that the shared helper now has two callers, so a bug in it can no longer hide
  // behind a parity assertion that reaches both sides through it.
  //
  // ⚠️ `null` covers two situations and both want an unscoped key: the resolver's declared
  // "this value has no component domain", and an unscoped total selection. An AUTHORED scope
  // over a value that cannot carry one never arrives — the resolver throws one frame earlier.
  evaluate(params, inputs, _ctx, scope) {
    const selection = requireResolvedScope(scope, 'MirrorModifier');
    const src = inputs.target as ObjectData | undefined;
    // Unwired (transient authoring state) — nothing to modify; stay transparent.
    if (!src) return src as unknown as ObjectData;
    const source = modifierDataSource(src);
    // Non-mesh data (curve / light / camera) — pass through unchanged.
    if (!source) return src;
    const geometry = mirrorGeometryRef(
      source.geometry,
      params.axis,
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
