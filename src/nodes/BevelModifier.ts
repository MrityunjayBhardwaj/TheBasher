// BevelModifier — the FOURTH geometry MODIFIER (SOP), #818 over #814's descriptor kind.
//
// It chamfers every edge of its source. Like Array, Mirror and Mask it is a `data → data`
// sub-chain node (the §2.2 model): it consumes source mesh DATA, rewrites its GEOMETRY, and
// inherits the source's MATERIAL.
//
// ── WHY THIS NODE IS A CORRECTNESS FIX AND NOT A FEATURE ──────────────────────────────
//
// #814 built the `bevel` descriptor — the first kind in this project that MINTS elements —
// and nothing in production could construct one. #783 states the rule this repo already
// holds every descriptor kind to: *"a domain that can store what nothing writes and nothing
// reads is a table awaiting its first consumer. The same rule descriptor kinds are already
// held to — a new kind cannot ship without its producing node."* #814 broke it, and the cost
// was concrete rather than tidy: with no way to build a bevel in the running app the *observe
// in the real app* step was impossible, so a minting kind had no e2e at all and every check
// on it was a unit test calling the builder directly.
//
// ── WHY IT DECLARES NO SCOPE ───────────────────────────────────────────────────────────
//
// The other three modifiers each carry a `scope` param and declare a lane for it. This one
// does not, and the absence is a decision with a name: `{ kind: 'unscoped', why: 'declined' }`.
//
// 🔴 `'declined'` AND NOT `'no-component-domain'`, AND THE DIFFERENCE IS THE WHOLE POINT OF
// THAT FIELD. The spine here carries a mesh; it HAS faces, edges and points to resolve a
// selection against. So "no selection reaches this operator" is not a fact about the value —
// it is a deferral about this operator, of exactly the kind the reference does support
// (Blender's Bevel takes a vertex group and an edge selection). Spelling it
// `'no-component-domain'` would claim there was nothing to select, which is false, and would
// make the deferral invisible to the reader who comes to add it.
//
// The deferral is real rather than nominal: `bevelLayoutOf` refuses any edge without exactly
// two incident faces, and a scoped bevel produces precisely those boundary edges. So scoping
// this operator is blocked on a miter rule, not on wiring.
//
// ── THE TWO DECISIONS, TAKEN FROM THE REFERENCE ────────────────────────────────────────
//
// 🔴 A ZERO AMOUNT IS TRANSPARENT, AND THAT IS THE REFERENCE'S OWN ANSWER, NOT A FALLBACK.
// `bevelGeometryRef` refuses a non-positive amount by construction — measured, at `0` the
// build declares 24 topological points and welds to 8, and at `-0.1` it draws an inside-out
// shell with nothing said. Every refusal in this language is a THROW and `evaluate` runs on
// the render walk with no `try` above it, so a node handing `0` straight to the builder would
// kill the render the moment an author dragged a slider to the bottom.
//
// Blender answers this in `MOD_bevel.cc:303-307`: `is_disabled()` returns `bmd->value == 0.0f`,
// and a disabled modifier is SKIPPED by the stack. So a zero-amount bevel passes its source
// through, for the same reason an unconfigured Mask is transparent — the state is an authoring
// step on the way to something, not an operator that should not be in the chain.
//
// 🔑 THE PASSTHROUGH ARM BELOW AND THE BUILDER'S REFUSAL MUST PARTITION THE SAME PREDICATE.
// Both are spelled `!(amount > 0)`, so the builder's throw is UNREACHABLE from this node and
// stays reachable only from direct API misuse. They live in different files and nothing about
// the types relates them, so `bevelNodeReach.gate.test.ts` holds the correspondence: it walks
// this node's schema, finds every amount the schema admits that the builder refuses, and reds
// if any of them reaches the builder.
//
// The param is named `amount` and not `width`, which is what the DNA field is called:
// `MOD_bevel.cc:328` draws it as `IFACE_("Amount")`, and #607's split says the substrate is
// Houdini's while the interaction model is Blender's. The name is load-bearing rather than
// cosmetic — `geometryHandleReach.gate.test.ts` checks that a descriptor field an animated
// channel can write is spelled exactly like the param feeding it, and the descriptor's field
// is `amount`.
//
// REF: src/app/modifierGeometry.ts (`bevelGeometryRef` — the one place a bevel becomes a
//      handle, and the refusal this node's arm mirrors); src/app/bevelLayout.ts (the closed-
//      form layout and what it refuses); src/nodes/types.ts (the `bevel` descriptor); issues
//      #818, #814, #817 (no upper bound on `amount`), #786 (what a minted face's attributes
//      should take), #783.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { ObjectData } from './types';
import { bevelGeometryRef } from '../app/modifierGeometry';
import { modifierDataSource, slotTableThrough } from '../app/modifierDataSource';

export const BevelModifierParams = z.object({
  /**
   * How far the chamfer cuts back from each original edge, in the source's local units.
   *
   * `.min(0)` and not `.positive()`: zero is a REACHABLE authoring state that means "not
   * beveled yet" (see the header on `is_disabled`), and a schema that refused it would make a
   * slider unable to reach its own bottom. Negative is refused here rather than passed
   * through, because unlike zero it is not a step on the way to anything — the reference's
   * own RNA floors `width` at zero for the same reason.
   *
   * The default is `0.1`. Against this project's unit box that is visible on drop, which is
   * the reference's behaviour too, and it sits safely under the `0.5` collapse point #817
   * measured for a unit cube — past which chamfered corners overshoot each other, the count
   * comes back RIGHT, and nothing warns.
   */
  amount: z.number().min(0).default(0.1),
  /**
   * Stack mute-bypass (V58). The param CARRIES the state; `chain.bypass` below names it and
   * the evaluator honours it, handing the spine value back without running `evaluate`.
   * Nothing in this file reads it.
   */
  muted: z.boolean().default(false),
});
export type BevelModifierParams = z.infer<typeof BevelModifierParams>;

export const BevelModifierNode: NodeDefinition<BevelModifierParams, ObjectData> = {
  type: 'BevelModifier',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: BevelModifierParams,
  inputs: { target: { type: 'ObjectData', cardinality: 'single' } },
  outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
  chain: {
    input: 'target',
    // No selection reaches this operator, and it COULD take one — see the header on why that
    // is `'declined'` and not `'no-component-domain'`.
    scope: { kind: 'unscoped', why: 'declined' },
    bypass: { kind: 'passthrough', param: 'muted' },
    section: 'modifier',
  },
  inspectorSections: ['modifier'],
  home: {
    amount: 'modifier',
    muted: 'modifier',
  },
  // Three arguments, not four: the chain above declares no scope, so the evaluator resolves
  // none and hands none. The siblings take a fourth and refuse an absent one; taking one here
  // would be a parameter that is always `undefined` — the shape a lying label has.
  evaluate(params, inputs) {
    const src = inputs.target as ObjectData | undefined;
    // Unwired (transient authoring state) — nothing to modify; stay transparent.
    if (!src) return src as unknown as ObjectData;
    const source = modifierDataSource(src);
    // Non-mesh data (curve / light / camera) — pass through unchanged.
    if (!source) return src;
    // Not beveled yet. The reference's `is_disabled` answer, and the exact complement of
    // `bevelGeometryRef`'s refusal — see the header on why these two predicates must match.
    if (!(params.amount > 0)) return src;
    const geometry = bevelGeometryRef(source.geometry, params.amount);
    return {
      kind: 'ModifiedData',
      geometry,
      material: source.material,
      // Self-cancelling here, and deliberately called anyway rather than dropped: a bevel's
      // ref carries no attribute component (`mintTiledModifierAttributes` refuses the kind),
      // so this returns `{}` BY CONSTRUCTION. Writing the drop into this node instead would
      // be a second place that decides what a bevel carries, and the builder is the first.
      ...slotTableThrough(source, geometry),
    };
  },
};
