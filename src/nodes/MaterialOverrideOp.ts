// MaterialOverrideOp — the SPARSE material diff of the data lane (#394 S3c).
//
// Its wholesale sibling `SetMaterialOp` answers "wear THIS material instead"; this one
// answers "wear the material below, but with these channels different". It is Houdini's
// `material_override`, which Basher already spells as the scene-band `MaterialOverride`
// wrapper — so this node MINTS NO NEW RULE. It reuses that node's `MaterialOverriddenSet`
// verbatim and composes through `composeMaterial`, the one composition function (S3b).
//
// ── WHY IT COMPOSES AND `SetMaterialOp` DOES NOT ────────────────────────────────────
//
// `composeMaterial` is closed over `InlineMaterialSpec` on both sides precisely so a
// chain folds: `base → op₁ → … → opₙ`, each step this function, in stack order. A
// wholesale set is the degenerate case of that fold (it ignores its accumulator), which
// is why the two operators are siblings rather than one node with a mode flag: the
// per-field OWNERSHIP question has different answers for them, and a flag would hide
// that behind a param read (see `resolveMaterialFieldOwner`).
//
// ── THE THREE SOURCE REPRESENTATIONS, AND WHY NONE OF THEM IS A NEW DECISION ────────
//
// A source material arrives as an IR, as a captured baked spec, or as nothing:
//   • `InlineMaterialSpec` → `composeMaterial`      (the IR-lane form)
//   • `BakedMaterialSpec`  → `composeBakedMaterial` (the snapshot form; the composed
//     scalars are merged back over the spec so its MAPS and `materialClass` survive —
//     dropping them is the #99 fidelity loss this whole family exists to prevent)
//   • `null` → compose onto the HYDRATED STANDARD IR, not passthrough. A materialless
//     source with an override on it must show the override; passing through would be
//     the silent-nothing this slice is guarded against, wearing a different hat.
// All three delegate the SAME decision (`resolveMaterialOverrideFields`). This module
// translates vocabulary; it never re-answers "may this scalar be written".
//
// ── THE DECLARED LIMIT THIS SHARES WITH `SetMaterialOp`, PINNED RATHER THAN DISCOVERED ─
//
// ONLY THE LOWEST ASSIGNING OP IN A STACK CONTRIBUTES A SLOT TABLE. Stack two overrides
// and the result has TWO slots, not three: the append arm below builds its table out of
// `source.material` alone, so the table the op underneath emitted is discarded and the
// original base material is gone from it. An override over a `SetMaterialOp` collapses the
// same way, in both stacking orders.
//
// ⚠️ THE SOURCE CAN CARRY THE TABLE — THIS IS A CHOICE, NOT AN EXPRESSIVE LIMIT. #691
// widened `ModifierDataSource` with `materialSlots`, and `modifierDataSource` forwards the
// pair whole, so `source.materialSlots` is right there and simply not read. What is missing
// is the rule for MERGING two tables — concatenate with re-indexing, or replace — which is
// #647, and which waits on the selection system that would make three slots authorable at
// all. Until that rule exists this operator REPLACES, deliberately.
//
// The twin states the same limit (`SetMaterialOp` limit 1) and has carried a pinning row
// since #638; this side was collapsing identically with neither, which is #699. The rows
// live in this module's test file so a merge rule cannot land on one operator alone.
//
// REF: src/app/material/composeMaterial.ts (the one composition rule + the split);
//      src/nodes/MaterialOverride.ts (the scene-band wrapper it shares the schema with);
//      src/nodes/SetMaterialOp.ts (the twin's declared limit 1 — the same collapse);
//      src/app/resolveMaterialFieldOwner.ts (what this node MASKS); issues #394 S3c, #647.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { ScopeDomain } from './attributes';
import type { MaterialValue, ObjectData } from './types';
import { MaterialOverriddenSet } from './MaterialOverride';
import { modifierDataSource } from '../app/modifierDataSource';
import { composeBakedMaterial, composeMaterial } from '../app/material/composeMaterial';
import { hydrateInlineMaterial } from './materialSchema';
import { requireResolvedScope, SCOPE_PARAM } from './componentSelection';
import { isParsableScopeQuery } from './scopeQuery';
import { mintTargetedAttributes } from './meshAttributes';
import { refWithAttributeKey } from '../app/modifierGeometry';

export const MaterialOverrideOpParams = z.object({
  name: z.string().default('override'),
  color: z.string().default('#ffffff'),
  roughness: z.number().min(0).max(1).default(0.5),
  metalness: z.number().min(0).max(1).default(0),
  opacity: z.number().min(0).max(1).default(1),
  emissive: z.string().default('#000000'),
  emissiveIntensity: z.number().min(0).default(0),
  // THE SAME sparse authored set the wrapper carries (#124, V28) — imported, not
  // re-declared, so the two hosts of this rule cannot drift in their vocabulary any
  // more than they can in their composition.
  overridden: MaterialOverriddenSet,
  /**
   * Stack mute-bypass (V58). The param CARRIES the state; `chain.bypass` below names it
   * and the evaluator honours it, handing the spine value back without running
   * `evaluate`. Nothing in this file reads it.
   */
  muted: z.boolean().default(false),
  /**
   * THE COMPONENT SCOPE — which faces the override composes onto (#682).
   *
   * Declared with the same shape as `SetMaterialOp`'s, down to the `.refine()`, and for the
   * same load-bearing reason: every refusal in the resolver is a THROW that would land on the
   * renderer's own walk, so the refusal is moved to where the value is AUTHORED. `setParam`
   * silently rejects a value its schema does not accept, so an unparseable query never enters
   * params and has no path to the render walk.
   *
   * Blank is the same authoring state as absent — the author cleared the field — and both
   * mean "every face", which is the REPLACE arm and is byte-identical to what this operator
   * emitted before it honoured anything.
   *
   * No migration: old saves simply lack the field and zod defaults it to blank, which is the
   * total selection they already had. This is a widening of what is expressible, not a change
   * to what any existing project means.
   */
  [SCOPE_PARAM]: z
    .string()
    .refine(isParsableScopeQuery, {
      message: 'not a component range — write indices and ranges like `0-5`, `0-10:2`, `!3`, `^7`',
    })
    .default(''),
});
export type MaterialOverrideOpParams = z.infer<typeof MaterialOverrideOpParams>;

/** The op's params as the `MaterialValue` the shared decision layer speaks. Exported
 *  because the per-field ownership walk must ask the SAME question with the SAME input
 *  the fold asks — a second projection here is a second answer. */
export function overrideValueOf(params: MaterialOverrideOpParams): MaterialValue {
  return {
    kind: 'Material',
    name: params.name,
    color: params.color,
    roughness: params.roughness,
    metalness: params.metalness,
    opacity: params.opacity,
    emissive: params.emissive,
    emissiveIntensity: params.emissiveIntensity,
    overridden: params.overridden,
    // `ignoreSourceMaterial` is deliberately absent: it is the explicit REFUSAL to
    // compose (composeMaterial.ts's header states it stays the caller's branch), and
    // the lane has no flatten road yet. Adding the param without the branch would be a
    // control that silently does nothing.
  };
}

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

export const MaterialOverrideOpNode: NodeDefinition<MaterialOverrideOpParams, ObjectData> = {
  type: 'MaterialOverrideOp',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: MaterialOverrideOpParams,
  inputs: { target: { type: 'ObjectData', cardinality: 'single' } },
  outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
  // #396 — the spine the material stack walks down (see SetMaterialOp).
  chain: {
    input: 'target',
    // ── THE SCOPE, DECLARED AND HONOURED (#682) ──────────────────────────────────────
    //
    // 🔴 THIS READ `{ kind: 'target' }` ONCE BEFORE AND IT WAS A LYING LABEL. `evaluate`
    // called the resolver and threw the answer away; its own comment said so ("not read
    // until the behaviour steps") and no behaviour step came. Every behavioural test passed,
    // because they were all written against what the operator actually did. ns-2 step 17
    // measured it — total selection vs one naming half the faces, BYTE-IDENTICAL output —
    // and re-declared it `unscoped, why: 'declined'` rather than leaving the label on.
    //
    // It is `target` again now because the behaviour exists: `evaluate` below composes the
    // override onto the selected faces and leaves the rest carrying the source's material.
    // What makes this declaration different from the first one is not a better comment — it
    // is that `operatorScopeHonouring.gate.test.ts` reds if the two outputs ever coincide
    // again, and that gate was written before this behaviour, against the lie.
    scope: { kind: 'target', domain: SCOPE_DOMAIN },
    bypass: { kind: 'passthrough', param: 'muted' },
    section: 'material',
  },
  inspectorSections: ['material'],
  home: {
    color: 'material',
    roughness: 'material',
    metalness: 'material',
    opacity: 'material',
    emissive: 'material',
    emissiveIntensity: 'material',
  },
  // The fourth argument is back, and so is the runtime refusal — the declaration above claims
  // a selection, so `scopeFor` resolves one and this throws if it ever arrives absent. The
  // refusal and the declaration are ONE claim and they move together; step 17 removed both,
  // and #682 restores both.
  evaluate(params, inputs, _ctx, scope) {
    const selection = requireResolvedScope(scope, 'MaterialOverrideOp');
    const src = inputs.target as ObjectData | undefined;
    // Unwired target (transient authoring state) — nothing to compose onto.
    if (!src) return src as unknown as ObjectData;
    const source = modifierDataSource(src);
    // Non-mesh data (curve / light / camera) — nothing wears a material.
    if (!source) return src;
    const override = overrideValueOf(params);
    const base = source.material;
    // The composition itself is UNCHANGED and is lifted out rather than re-spelled per arm:
    // both arms emit exactly this material, and the only question either answers is how many
    // faces wear it. Two copies of the three-way base test would be two places free to drift
    // about what "compose" means, which is the defect the arms exist to avoid, not to add.
    const composed =
      base === null
        ? composeMaterial(hydrateInlineMaterial(undefined), override, 'authored-only')
        : 'materialClass' in base
          ? { ...base, ...composeBakedMaterial(base, override, 'authored-only') }
          : composeMaterial(base, override, 'authored-only');

    // WHICH FACES RECEIVE THE OVERRIDE — one walk, in `meshAttributes`, which hands back the
    // key AND how many faces it covered. The arm is chosen from the COVERAGE and not from the
    // selection, exactly as `SetMaterialOp` chooses its own: "does this reach every face?" is
    // the question every input answers, and asking the selection's shape instead is how the
    // test drifts the first time the input changes.
    const targeted = mintTargetedAttributes(source.geometry.descriptor, selection, 'evaluate');

    if (targeted !== null && targeted.covered < targeted.faces) {
      // THE APPEND ARM. The source's material stays on slot 0 for the faces OUTSIDE the
      // selection and the composed one takes slot 1 inside it — so an override scoped to half
      // a mesh leaves the other half exactly as it arrived, which is the whole behaviour #682
      // asks for. The geometry is re-minted with the index folded into its key, because the
      // group layout lives on the shared instance and two objects scoped differently must not
      // collide onto one cached build.
      //
      // ⚠️ SLOT 0 IS `source.material`, WHICH MAY BE `null`, AND THAT IS NOT THE SAME AS THE
      // COMPOSED-FROM-NOTHING MATERIAL ABOVE. `null` means "wear whatever you already wore";
      // hydrating it here would silently give the unselected faces an authored default the
      // director never asked for.
      return {
        kind: 'ModifiedData',
        geometry: refWithAttributeKey(source.geometry, targeted.key),
        material: composed,
        materialSlots: [base, composed],
        attributeKey: targeted.key,
      };
    }

    // THE REPLACE ARM — byte-identical to what this operator has always emitted, so nothing a
    // director has already built changes meaning. It covers two different facts with the same
    // answer, and they are not split for the same reason `SetMaterialOp` does not split them:
    //
    //   covered === faces   every face is selected, so a table would hold one used slot.
    //   targeted === null   the face count is not derivable (a glTF or baked source), so
    //                       there is no domain to scope over. Emitting a table with no index
    //                       behind it would report one used slot anyway and the override
    //                       would silently vanish from a mesh the director just styled.
    //                       Same declared limit SetMaterialOp carries, and it lifts when
    //                       those roads get a data half of their own.
    return {
      kind: 'ModifiedData',
      geometry: source.geometry,
      material: composed,
    };
  },
};
