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
// ── THE SCOPE IT NOW DECLARES, AND WHY THE REFUSAL THAT STOOD HERE IS GONE ─────────────
//
// #818 shipped this node with `{ kind: 'unscoped', why: 'declined' }`, and the deferral was
// real rather than nominal: *"`bevelLayoutOf` refuses any edge without exactly two incident
// faces, and a scoped bevel produces precisely those boundary edges. So scoping this operator
// is blocked on a miter rule, not on wiring."* #827 built the miter rule, so the reason is
// spent and the declaration is a `'source'` scope at domain `'edge'`.
//
// 🔴 `'edge'` AND NOT `'face'`, WHICH IS WHY THIS OPERATOR IS THE ONE THAT WIDENED
// `ScopeDomain`. The other four scoped operators all name faces, and five operators choosing
// `face` was five decisions that happened to agree — this is the first that does not. A bevel
// chamfers EDGES: there is no face selection that means "chamfer these four edges", because a
// face names four of them at once and its neighbours name them again.
//
// 🔴 AND IT IS `'source'` RATHER THAN `'target'`. A target scope names components that RECEIVE
// a write, which is what `SetMaterialOp` does. This one names the edges the operator READS and
// generates chamfers FROM, and the elements it writes did not exist beforehand — the same
// relation Array and Mirror have to their own selections.
//
// ⚠️ THE MITER RULE IS PARTIAL, BY DECISION AND WITH THE HOLE NAMED. `bevelLayoutOf` refuses a
// point with exactly ONE chamfered edge — the terminal case, whose boundary count is `n - 1`
// rather than `k` and which is the only case that changes a face's arity. So a closed loop of
// edges works and a lone edge is refused BY NAME. Refusal is reachable from an author here,
// unlike the manifoldness gate, which is why the message says what to do instead.
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
//      #818, #814, #817 (no upper bound on `amount`), #825 (what a minted element's attributes
//      are worth — its FACE half is built, its corner half is not), #783.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { ObjectData } from './types';
import { bevelGeometryRef } from '../app/modifierGeometry';
import { modifierDataSource, slotTableThrough } from '../app/modifierDataSource';
import {
  ANGLE_LIMIT_PARAM,
  LIMIT_METHOD_PARAM,
  requireResolvedScope,
  SCOPE_PARAM,
  scopeParam,
} from './componentSelection';
import type { ScopeDomain } from './attributes';

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
  /**
   * THE COMPONENT SCOPE — which EDGES this operator chamfers (#827).
   *
   * The first scope in the repo that is not a face selection, and blank means every edge, which
   * is what a bevel meant when it had no choice. Nothing in this file reads it: the param
   * CARRIES the authored text, the evaluator resolves it through the one resolver, and
   * `evaluate` is handed the answer — a node that read the field itself would be a second
   * producer of the descriptor's scope beside the resolver.
   *
   * 🔴 `.refine()` IS LOAD-BEARING for the reason its four siblings state: every refusal in the
   * query language is a THROW, `evaluate` runs on the render walk with no `try` above it, and
   * an unparseable query must have no constructor rather than a handler.
   */
  [SCOPE_PARAM]: scopeParam(),
  /**
   * WHICH PRODUCER NAMES THE CHAMFERED EDGES (#847).
   *
   * `'scope'` is the default because it is what a bevel has always done: the authored query
   * decides, and a blank one means every edge. So every graph saved before this param existed
   * parses to exactly the behaviour it had.
   *
   * `'angle'` hands the job to the dihedral deviation instead. The two are EXCLUSIVE rather
   * than combined, which is the reference's shape (`limit_method` is an enum there) and the
   * only one that never silently ignores an author — the resolver refuses if both are set.
   */
  [LIMIT_METHOD_PARAM]: z.enum(['scope', 'angle']).default('scope'),
  /**
   * The deviation in DEGREES above which an edge is chamfered — this codebase's convention at
   * an authoring boundary, where `edgeAnglesOf` answers in radians and the resolver converts.
   *
   * `30` is the reference's own default. The range is `[0, 180]` because that is the range of
   * the quantity: `edgeAnglesOf` is `acos` of two unit normals, so it cannot exceed π, and a
   * limit beyond it would be a slider that stops selecting anything before reaching its end.
   *
   * ⚠️ NOTHING IN THIS FILE READS EITHER PARAM, exactly as with the scope: they CARRY the
   * authored state, the evaluator resolves it through the one resolver, and `evaluate` is
   * handed the answer. A node that read them itself would be a second producer of the
   * descriptor's selection beside the resolver.
   */
  [ANGLE_LIMIT_PARAM]: z.number().min(0).max(180).default(30),
});
export type BevelModifierParams = z.infer<typeof BevelModifierParams>;

/**
 * The atom class this operator's scope names — declared here, read twice (#714).
 *
 * 🔑 THE FIRST `const` IN THIS REPO THAT IS NOT `'face'`, which is the thing #714 built the
 * per-operator declaration FOR: a shared constant would have handed this operator faces and
 * nothing would have failed, because a face index and an edge index are both integers.
 */
const SCOPE_DOMAIN: ScopeDomain = 'edge';

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
    // The selection names which EDGES are chamfered — read, not written to. See the header on
    // why the `'declined'` that stood here is spent rather than moved.
    scope: { kind: 'source', domain: SCOPE_DOMAIN },
    bypass: { kind: 'passthrough', param: 'muted' },
    section: 'modifier',
  },
  inspectorSections: ['modifier'],
  home: {
    amount: 'modifier',
    muted: 'modifier',
    [SCOPE_PARAM]: 'modifier',
    [LIMIT_METHOD_PARAM]: 'modifier',
    [ANGLE_LIMIT_PARAM]: 'modifier',
  },
  // Four arguments now, like its scoped siblings: the chain declares a scope, so the evaluator
  // resolves one and hands it here. Refused at runtime as well as required in the signature,
  // because the test tier is type-blind and an omission there fails silently.
  evaluate(params, inputs, _ctx, scope) {
    const selection = requireResolvedScope(scope, 'BevelModifier');
    const src = inputs.target as ObjectData | undefined;
    // Unwired (transient authoring state) — nothing to modify; stay transparent.
    if (!src) return src as unknown as ObjectData;
    const source = modifierDataSource(src);
    // Non-mesh data (curve / light / camera) — pass through unchanged.
    if (!source) return src;
    // Not beveled yet. The reference's `is_disabled` answer, and the exact complement of
    // `bevelGeometryRef`'s refusal — see the header on why these two predicates must match.
    if (!(params.amount > 0)) return src;
    // NOTHING SELECTED — the SAME answer as a zero amount, and for the same reason (#862).
    //
    // A bevel over an empty selection chamfers nothing, which is the state a zero amount also
    // describes, so the node gives one answer to one question rather than two. Before this arm
    // it gave THREE: a zero amount passed through, an empty SCOPE mounted an object carrying no
    // mesh, and an empty ANGLE result threw on the render walk and took the app down.
    //
    // The throw is what forced the arm — `angleLimit` at 90 on a default cube selects nothing,
    // and half the slider's own range reaches it by a scrub drag. But the arm is keyed on the
    // resolved COUNT and not on which producer named it, because the author's question ("what
    // does a bevel do when it chamfers nothing?") does not change with the road the answer
    // arrived on, and an arm that only covered the angle would leave the same three-answer
    // split one road narrower.
    //
    // Complements `bevelLayoutOf`'s own refusal exactly, which is the property
    // `bevelNodeReach.gate.test.ts` pins for both axes: the node passes through precisely where
    // the builder would refuse, so the builder's throw stays unreachable from the node.
    if (selection !== null && selection.count === 0) return src;
    const geometry = bevelGeometryRef(
      source.geometry,
      params.amount,
      selection?.canonicalQuery,
      SCOPE_DOMAIN,
    );
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
