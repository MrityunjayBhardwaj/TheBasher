// SetMaterialOp — the WHOLESALE material writer of the data lane (#394 S3c).
//
// This is Houdini's Material SOP and Blender Geometry Nodes' `Set Material`, in the
// position both references put it: an operator standing between the data and the
// object that wears it, replacing the material flowing through while the PROPERTY
// underneath remains the storage. It is a procedural WRITER of the material, never a
// substitute for owning one — which is why the `material` param/socket on `BoxData`
// (S2) is untouched by this node existing.
//
// SHAPE: `ObjectData → ObjectData`, exactly `ArrayModifier` (`ArrayModifier.ts:61-62`).
// That is not a symmetry argument — it is what makes this a member of the lane the
// modifier stack already lives on, so `isDataLaneOperator` walks past it for free and
// no reach, no ownership walk and no offer predicate needs a new type list.
//
// ── WHY THE MATERIAL ARRIVES BY EDGE, NOT BY A `refParams` POINTER ──────────────────
//
// PLAN-2 §3 proposed a `refParams` pointer, on the grounds that it inherits the generic
// picker and the dangling-ref guard. Measured at head, neither holds:
//   • `applyRemoveNode` (core/dag/ops.ts:169-184) REFUSES to delete a node that is still
//     consumed as an input, so an edge cannot dangle by construction. The dangling-ref
//     sweep exists for id-STRING refs, which is the shape a `refParams` pointer has.
//   • The data node's own material is already an EDGE (S2, materialSocket.ts), so the
//     section picker must drive `connect`/`disconnect` regardless. A pointer here would
//     mint a SECOND way to say "point at a Material" — the drift the one-composer gate
//     exists to stop, in the assignment vocabulary instead of the composition one.
// And the thesis reason: `Material.ts:4-6` mints this node so assignment becomes a drawn
// edge and sharing becomes a fact the graph states. A param string is invisible there.
//
// So the socket is the SAME `'Material'` socket `BoxData` declares, read through the
// SAME `materialSocket` rule — one spelling of "a material can arrive over an edge".
//
// UNWIRED IS TRANSPARENT, not empty: with nothing connected this operator passes its
// source through unchanged, so an op added before its material is picked never blanks a
// mesh. That mirrors the unwired-target guard `ArrayModifier` already has. It used to
// mirror a mute-bypass sitting immediately above it too; that guard is gone, because the
// bypass is now DECLARED in `chain.bypass` and honoured once, by the evaluator (V58).
//
// ── WHICH FACES RECEIVE THE WRITE, AND WHY THAT DID NOT CHANGE WHAT THIS NODE MEANT ──
//
// Blender's `Set Material` takes a SELECTION and writes `material_index` on the selected
// faces; ours took the whole mesh. #638 closed half of that with a literal `faceFrom`/
// `faceTo` range, and ns-2 step 12 closed the other half: this is the first operator in the
// app that reads a resolved COMPONENT SELECTION, handed to it by the evaluator as
// `evaluate`'s fourth argument. Step 14 then deleted the range, which had been kept only
// until the selection road had demonstrably run — so the selection is now the sole input.
// Two arms, split on whether the assignment reaches every face:
//
//   covers every face  → REPLACE. Byte-identical to what this node emitted before either
//       the range or the scope existed: one material, no slot table, no index.
//   covers some faces  → APPEND. The source's material keeps slot 0 outside the assignment,
//       the wired one takes slot 1 inside it, and the geometry is re-minted with the index
//       folded into its key.
//
// 🔴 THE ARM IS CHOSEN FROM THE COVERAGE, NOT FROM THE INPUT'S SHAPE, and that is what let
// both steps land without a branch each. A three-clause test over `faceTo`/`faceFrom` cannot
// see a scope, so honouring one beside it would have been the property spelled per member —
// the defect this phase exists to delete. "Does this assignment reach every face?" is a
// question every input answers, which is why deleting one of two inputs at step 14 changed
// the argument list here and nothing else.
//
// The append semantics reach ONLY a state this node could not previously express, so no graph
// anyone has already built changes meaning. Step 12 was therefore migration-free by
// construction: with no scope authored the resolved selection was TOTAL, so `total ∩ range`
// was the range. ⚠️ STEP 14 IS NOT — deleting the range means an already-saved one has to be
// carried over rather than assumed away, which is what the v1 → v2 migration below is for.
// Loading is not the same as keeping its meaning, and a zod object drops unknown keys in
// silence.
//
// THREE DECLARED LIMITS, each pinned by tests rather than left to be discovered:
//
//   1. ONLY THE LOWEST `SetMaterialOp` IN A STACK CONTRIBUTES A SLOT TABLE; a second one
//      replaces it. `ModifierDataSource` carries `{geometry, material}` and nothing else, so
//      the second op reads the first's single material field and never sees its table.
//      Widening the data lane's source contract touches every operator on it and belongs
//      with the selection system that would make three slots authorable in the first place.
//   2. ~~THE RANGE AND THE SCOPE BOTH SURVIVE~~ — **DONE (ns-2 step 14).** `faceFrom`/`faceTo`
//      were the crude precursor the selection supersedes, kept until the selection road had
//      demonstrably executed on both a writer and two generators. It has, so they are gone,
//      and an already-saved range is rewritten into the query that means the same thing by
//      the v1 → v2 migration below rather than being dropped. The selection is now the ONLY
//      input naming which faces receive the write.
//   3. A source whose face count is not derivable from params (glTF, baked) cannot carry an
//      assignment at all, and REPLACES instead. Those roads have no data half yet — and an
//      AUTHORED scope over one of them is a named throw from the resolver rather than a
//      silent whole-mesh write, because the author asked for something unhonourable.
//
// REF: src/nodes/materialSocket.ts (the socket rule); src/app/modifierGeometry.ts
//      (`modifierDataSource` — the shared classifier); src/nodes/MaterialOverrideOp.ts
//      (the sparse sibling); docs/OPERATORS-AND-LIGHTING-DESIGN.md §5/§2.2; issue #394.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { ObjectData } from './types';
import { refWithAttributeKey } from '../app/modifierGeometry';
import { modifierDataSource } from '../app/modifierDataSource';
import { mintTargetedAttributes } from './meshAttributes';
import { isMaterialLinked, resolveNodeMaterial } from './materialSocket';
import { requireResolvedScope, SCOPE_PARAM } from './componentSelection';
// ns-2 step 12.5 — the language moved to a leaf below `componentSelection`, so that a
// generator's descriptor and its face count can both reach it without a cycle. This is
// still the one-bit door: a BOOLEAN, never terms.
import { isParsableScopeQuery } from './scopeQuery';

export const SetMaterialOpParams = z.object({
  /**
   * Stack mute-bypass (V58). The param CARRIES the state; `chain.bypass` below names it
   * and the evaluator honours it, handing the spine value back without running
   * `evaluate`. Nothing in this file reads it.
   */
  muted: z.boolean().default(false),
  /**
   * THE COMPONENT SCOPE — which faces receive the write (ns-2 step 12, #607/#660).
   *
   * This is the FIRST `scope` param any node declares, and the name is
   * {@link SCOPE_PARAM} rather than a literal so the evaluator's resolver and this schema
   * cannot drift apart. Blank is the same authoring state as absent — the author cleared
   * the field — and both mean "every face", resolved once, in one place.
   *
   * 🔴 `.refine()` IS LOAD-BEARING AND IS NOT VALIDATION HYGIENE. Every refusal in the
   * resolver is a THROW, and declaring this param is what makes an authored query reach it.
   * The throw would land on the renderer's own walk — `resolveEvaluatedMesh` calls
   * `evaluate` with no `try` above it and `SceneFromDAG` calls that during render, measured
   * rather than assumed — so a director who mistyped a range would take the viewport down,
   * and this project has no node-error surfacing at all to tell them why. Refining here
   * moves the refusal to where the value is AUTHORED: `setParam` silently rejects a value
   * its schema does not accept, so an unparseable query never enters params, never reaches
   * the resolver, and has no path to the render walk. The bad state is not guarded against;
   * it has no constructor.
   *
   * ⚠️ WHAT IT CANNOT CATCH, said here so the gap is not mistaken for coverage: a query that
   * PARSES can still be unhonourable against a particular source — an authored scope over a
   * curve, or over a `gltf`/`baked` handle whose face count is not derivable. Those depend
   * on the spine value, which a param schema cannot see, and they remain named throws.
   */
  [SCOPE_PARAM]: z
    .string()
    .refine(isParsableScopeQuery, {
      message: 'not a component range — write indices and ranges like `0-5`, `0-10:2`, `!3`, `^7`',
    })
    .default(''),
});
export type SetMaterialOpParams = z.infer<typeof SetMaterialOpParams>;

/**
 * The face range this node used to carry, rewritten as the scope query that supersedes it
 * (ns-2 step 14). Exported for the migration test — the arithmetic is small and total, and a
 * test that re-derived it would be a second implementation agreeing with the first by
 * construction.
 *
 * ── WHY THIS IS A MIGRATION AND NOT A DELETION ────────────────────────────────────────
 *
 * `faceFrom`/`faceTo` shipped to `main` with #638 and are authorable through the agent's
 * `setParam` road (this node has no inspector section — every cell in its golden row is
 * `(unrouted)`, so the range was never reachable from the panel). Deleting the params without
 * a migration would still LOAD, because a zod object strips unknown keys silently — measured,
 * not assumed — and that is precisely the problem: a director's two-material mesh would come
 * back as a one-material mesh with nothing said. Loading is not the same as keeping its
 * meaning.
 *
 * ── THE FOUR CASES, AND WHY EACH IS EXACT ─────────────────────────────────────────────
 *
 *   from 0, to -1     the default, "every face"          → blank, which means the same thing
 *   from a>0, to -1   open-ended, "face a to the end"    → `!0-{a-1}`, the COMPLEMENT of what
 *                                                          comes before it. Length-independent,
 *                                                          which matters because a migration
 *                                                          sees params and never a face count.
 *   0 <= a <= b       a closed range                      → `a-b` (`a-a` canonicalises to `a`)
 *   a > b, or to < -1 names NO faces (the old code            → `^0`: remove face 0 from the
 *                     clamped an inverted range to nothing)    empty set. Also length-independent.
 *
 * 🔴 EVERY ONE OF THOSE FOUR SPELLINGS WAS MEASURED AGAINST THE PARSER BEFORE BEING WRITTEN
 * HERE, and one candidate was killed by the measurement: an inverted range cannot simply be
 * passed through as `7-3`, because that is NOT a parsable query and the schema would refuse
 * the value the migration produced. `^0` is the expressible spelling of "nothing".
 *
 * ⚠️ AN ALREADY-AUTHORED SCOPE WINS AND THE RANGE IS DROPPED. That case cannot arise in any
 * project that exists — `scope` has never been in a build on `main` (measured: zero
 * occurrences in `origin/main`'s copy of this file, against four for `faceFrom`) — but a
 * migration ladder outlives the knowledge that made it, so the rule is stated rather than
 * left to whichever branch of an `if` happened to run. The two cannot be composed in general:
 * the shipped semantics was range ∩ scope computed on the resolved MASK, and the query
 * language has union and difference but no intersection operator.
 */
export function scopeFromRetiredFaceRange(from: number, to: number): string {
  const lo = Math.max(0, Math.trunc(from));
  if (to === -1) return lo === 0 ? '' : `!0-${lo - 1}`;
  const hi = Math.trunc(to);
  if (hi < lo) return '^0';
  return `${lo}-${hi}`;
}

export const SetMaterialOpNode: NodeDefinition<SetMaterialOpParams, ObjectData> = {
  type: 'SetMaterialOp',
  // ns-2 step 14 — BUMPED 1 → 2 by the deletion of `faceFrom`/`faceTo`. The bump is what
  // gives the migration below something to hang on; without it an old project's range would
  // be stripped by the schema on the way in, silently.
  version: 2,
  migrations: {
    // v1 → v2: the retired face range becomes the scope query that supersedes it. Every other
    // param rides through untouched — `muted` and the material edge are not this step's
    // subject — and the two retired keys are dropped by name rather than by a spread that
    // happens to omit them, so a reader can see exactly what left.
    1: (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const { faceFrom, faceTo, ...rest } = p;
      const authored = typeof rest[SCOPE_PARAM] === 'string' ? (rest[SCOPE_PARAM] as string) : '';
      if (authored.trim() !== '') return rest;
      const from = typeof faceFrom === 'number' ? faceFrom : 0;
      const to = typeof faceTo === 'number' ? faceTo : -1;
      return { ...rest, [SCOPE_PARAM]: scopeFromRetiredFaceRange(from, to) };
    },
  },
  pure: true,
  cost: 'cheap',
  paramSchema: SetMaterialOpParams,
  inputs: {
    target: { type: 'ObjectData', cardinality: 'single' },
    // `list`, byte-identically to `BoxData.inputs.material` — the binding shape is
    // PERSISTED, so the cardinality is a format decision and it is made once, here and
    // there, the same way. Exactly one entry is read (materialSocket.ts).
    material: { type: 'Material', cardinality: 'list' },
  },
  outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
  // #396 — THE FIRST NODE WHERE THIS DECLARATION IS LOAD-BEARING RATHER THAN CEREMONIAL.
  // This operator is already binary: `target` is the spine the stack walks, `material`
  // is an ARGUMENT the graph wires and the stack steps past. Until now the walkers got
  // that right by accident — `Material` is not `ObjectData`, so the argument was never
  // a candidate for a walk that matched on the socket NAME. Declaring the spine is what
  // makes it right on purpose, and what keeps it right for an argument that DOES share
  // the spine's type (a boolean cutter, a capture-pose skeleton).
  chain: {
    input: 'target',
    // A writer: the selection names which faces RECEIVE the assignment.
    scope: { kind: 'target' },
    bypass: { kind: 'passthrough', param: 'muted' },
    section: 'material',
  },
  // NO inspector section, and that is the reference's own answer rather than a gap.
  // Blender's Material Properties panel is Slot List → Data-Block row → Link selector
  // (`render/materials/assignment.rst:19-101`); its `Set Material` is a GEOMETRY NODES
  // node, authored in the node editor, and never appears in that panel. This node has
  // nothing a panel could author either: its material arrives over an edge (drawn in the
  // graph) and `muted` is a stack control. Declaring 'material' here would ship a titled,
  // permanently empty card — the exact shape the #458 reachability gate exists to catch.
  // ns-2 step 12 — THE FIRST OPERATOR THAT READS ITS SELECTION. The fourth argument is the
  // resolved {@link ComponentSelection} the evaluator hands every node whose chain declares
  // a scope; required, and refused at runtime because a required parameter closes the
  // omission only in production ([[H327]]).
  // ns-2 step 14 — `params` is now UNREAD, and that is the shape the phase was after rather
  // than an oversight: `muted` is honoured by the evaluator and `scope` is resolved by the
  // resolver, so everything this operator is told arrives as arguments and nothing is
  // re-interpreted out of its own param record. It is the same claim `ArrayModifier` and
  // `MirrorModifier` make, reached here by deleting the last field that broke it.
  evaluate(_params, inputs, _ctx, scope) {
    const selection = requireResolvedScope(scope, 'SetMaterialOp');
    const src = inputs.target as ObjectData | undefined;
    // Unwired target (transient authoring state) — nothing to write onto.
    if (!src) return src as unknown as ObjectData;
    // No material picked yet — transparent, never a blanked mesh.
    if (!isMaterialLinked(inputs.material)) return src;
    const source = modifierDataSource(src);
    // Non-mesh data (curve / light / camera) — nothing wears a material. Measured on
    // the same reference ground as the modifier's passthrough (GT_BLENDER_MODIFIER_DATA §9).
    if (!source) return src;
    // Hydrated by the socket rule, so what leaves here is always a complete IR.
    const wired = resolveNodeMaterial(inputs.material, undefined);

    // THE FACES THAT RECEIVE THE WRITE — the resolved selection, and now nothing else
    // (ns-2 step 14: the literal range that used to narrow it is gone, migrated into the
    // query). One walk, in `meshAttributes`, which hands back the key AND how many faces it
    // covered; deriving the count a second time here would be two spellings of the same
    // arithmetic, agreeing today and diverging the first time either is touched.
    //
    // ⚠️ THE ARM IS STILL CHOSEN FROM THE COVERAGE, NOT FROM THE SELECTION. It was a
    // three-clause test over `faceTo`/`faceFrom` before step 12, and the temptation each time
    // the input changes is to test the new input's shape instead. "Does this assignment reach
    // every face?" is the question every input answers, asked once — which is why deleting one
    // of two inputs changed nothing here but the argument list.
    const targeted = mintTargetedAttributes(source.geometry.descriptor, selection, 'evaluate');

    if (targeted !== null && targeted.covered < targeted.faces) {
      // THE APPEND ARM. The source's own material stays on slot 0 for the faces outside
      // the assignment, and the wired one takes slot 1 inside it. The geometry is re-minted
      // with the new index folded into its key: two objects whose faces are assigned
      // differently MUST NOT collide onto one cached instance, because the group layout
      // lives on that instance and whichever built first would decide for both.
      return {
        kind: 'ModifiedData',
        geometry: refWithAttributeKey(source.geometry, targeted.key),
        material: wired,
        materialSlots: [source.material, wired],
        attributeKey: targeted.key,
      };
    }
    // Falling through to REPLACE covers two states that are different facts about the world
    // and the same answer, which is why they are not split:
    //
    //   covered === faces      every face receives the write, so a table would hold one
    //                          used slot — byte-identical to what this node emitted before
    //                          any range or scope existed.
    //   targeted === null      the face count is not derivable (a glTF or baked source: its
    //                          buffers live in an asset clone or in OPFS), so there is no
    //                          domain to write onto. Emitting a table with no index behind
    //                          it would report one used slot anyway and the wired material
    //                          would silently vanish from a mesh the director just assigned
    //                          it to. Declared limit 3, pinned by a test, and it lifts when
    //                          those roads get a data half of their own.
    return {
      kind: 'ModifiedData',
      // THE REPLACE ARM — byte-identical to what this node has always emitted, so nothing
      // a director has already built changes meaning. The geometry rides through UNTOUCHED:
      // over a full range this operator still has an opinion about the material only. It is
      // `ModifiedData` rather than the source's own kind because that is the one member of
      // the union produced BY an operator, and the one whose `material` carries the wide
      // Inline|Baked union a chained source needs.
      geometry: source.geometry,
      material: wired,
    };
  },
};
