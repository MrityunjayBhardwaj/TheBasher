// modifierDataSource — THE ONE kind-dispatch for "does this `ObjectData` carry a mesh a
// geometry operator can reshape, and with what material?", in a LEAF.
//
// ── WHY THIS IS ITS OWN MODULE, AND NOT A FUNCTION IN `modifierGeometry.ts` ────────────
//
// It answers a question the DAG evaluator is about to need. ns-2 step 9b resolves a
// component selection at the single `evaluate` call site (`src/core/dag/evaluator.ts`),
// which means the evaluator reaches the resolver, and the resolver has to ask this
// classifier which `ObjectData` members carry components at all.
//
// While this function lived in `modifierGeometry.ts` that road was a CYCLE, not a long
// import: `modifierGeometry.ts` imports `evaluate` from the evaluator (for
// `canModifyGeometry`, which evaluates a source node to answer the offer predicate), so
// `evaluator → componentSelection → modifierGeometry → evaluator` closes on itself.
// Measured before the move: `src/core/dag/**` had **14 production files and ZERO imports
// of `src/app` or `src/nodes`**, and `operatorLane.gate.test.ts` already pins one of those
// import lists — so the edge back into `core/dag` is the part that had to not exist.
//
// The alternative was a second spelling of the same partition inside the resolver, held by
// a cross-check gate. This boundary has paid three times for a second spelling that agrees
// today ([[V155]]), and this function's own doc below records that its SceneObject-side
// twin was DELETED once it had no callers, with the reason stated verbatim: *"There is no
// second answer to keep in step."* Re-minting one to dodge an import would have regressed
// that consolidation in the phase whose whole subject is consolidating this category.
//
// This module imports ONE type module and nothing else. That is the invariant it exists to
// hold, and `faceCountLeaf.gate.test.ts` holds it — the same gate, for the same reason, as
// the sibling leaf `faceCount.ts`.
//
// REF: src/app/modifierGeometry.ts (the module it left — `canModifyGeometry`, the offer
//      half, and the geometry-handle builders); src/core/dag/evaluator.ts (the caller ns-2
//      step 9b adds); src/app/dataSectionCapability.ts (the can-it-EVER half, asserted to
//      agree with this in both directions); issues #415, #660.

import type {
  BakedMaterialSpec,
  GeometryRef,
  InlineMaterialSpec,
  ObjectData,
} from '../nodes/types';

/**
 * Everything a geometry modifier needs from its source DATA: the handle to reshape
 * and the material to inherit. `null` from {@link modifierDataSource} means "this
 * value is not a modifiable source" — the modifier passes it through unchanged.
 *
 * There is NO pose here, and that absence is the point. On the data lane (#415) there
 * is none to take: the Object above the stack owns it, and a data node has none of its
 * own. Both references state it (Houdini S8: authored in object space, the transform
 * applied once above the stack; Blender 5.1.1 measured: the evaluated mesh datablock
 * has no `matrix_world`) — see `ModifiedDataValue` in src/nodes/types.ts. The
 * predecessor of this interface carried a `transform` field for the SceneObject-side
 * road, which is what #415 removed.
 */
export interface ModifierDataSource {
  readonly geometry: GeometryRef;
  readonly material: InlineMaterialSpec | BakedMaterialSpec | null;
  /**
   * The source's slot TABLE, when it has one (#691).
   *
   * ⚠️ THIS IS A PASS-THROUGH, NOT TABLE COMPOSITION. Exactly one table is in play: the
   * modifier reshapes its source's faces and every one of them still indexes into the same
   * entries, so the table travels unchanged and there is nothing to merge. The question
   * #647 is waiting on — how two tables combine when two ASSIGNING ops stack, concatenate
   * with re-indexing or replace — is not answered here and is not raised by this: a second
   * op that WRITES a table is what needs a rule, and a modifier writes none.
   *
   * Absent means "one material", preserved deliberately rather than normalised to a
   * one-entry table: `materialSlotsOf` already derives that from `material`, and emitting a
   * table for every single-material mesh would change the shape of a value the whole
   * existing population carries.
   */
  readonly materialSlots?: readonly (InlineMaterialSpec | BakedMaterialSpec | null)[];
  /**
   * The content key of the SOURCE's attribute set — the index half of the pair, present
   * exactly when the table is, per `ModifiedDataValue`'s stated invariant.
   *
   * ⚠️ A CONSUMER MUST NOT FORWARD THIS ONTO ITS OUTPUT. It describes the source's faces;
   * a generator's output has more of them. The tiled key for the merged result is minted by
   * the geometry builder and lives on the handle it returns — that is the one to emit.
   */
  readonly attributeKey?: string;
}

/**
 * How a GENERATOR forwards its source's slot table onto its own output (#691) — one
 * statement, shared by every modifier that merges copies of its source.
 *
 * ── THE ASYMMETRY, WHICH IS THE WHOLE REASON THIS IS A FUNCTION ───────────────────────
 *
 * The two halves of the pair come from DIFFERENT places, and swapping them is silent:
 *
 *   table  ← the SOURCE. Tiling reshapes which faces exist, never which slots exist, so
 *            the entries are unchanged and travel verbatim.
 *   index  ← the BUILT HANDLE, never the source. The source's key describes its own faces
 *            (12 on a box); the merged result has more (36 for an array x3). Forwarding
 *            the source's key would hand a 12-entry index to a 36-face mesh, which
 *            `faceCountMismatch` refuses — `build()` then writes NO groups and the mesh
 *            draws slot 0 everywhere, looking exactly like the collapse this removes.
 *
 * ── WHY BOTH-OR-NEITHER, NEVER ONE ────────────────────────────────────────────────────
 *
 * `ModifiedDataValue` states it: `attributeKey` is "present exactly when the table is,
 * because neither half means anything alone". So a source WITH a table whose built handle
 * carries no tiled key (the builder declined — a descriptor whose face count is not
 * derivable, or a source that carried no assignment) emits NOTHING and collapses to one
 * material. That is the honest pre-#644 behaviour, not a half-pair pointing nowhere.
 */
export function slotTableThrough(
  source: ModifierDataSource,
  built: GeometryRef,
): {
  materialSlots?: readonly (InlineMaterialSpec | BakedMaterialSpec | null)[];
  attributeKey?: string;
} {
  if (source.materialSlots === undefined || built.attributeKey === undefined) return {};
  return { materialSlots: source.materialSlots, attributeKey: built.attributeKey };
}

/**
 * Project a resolved `ObjectData` value into the source a geometry modifier consumes
 * — THE ONE kind-dispatch for "is this data reshapeable, and with what?". `null` means
 * "not a mesh face" and the modifier passes the value through unchanged.
 *
 * #415 moved the modifier onto the data lane, so THIS is the classifier the modifier's
 * own `evaluate` asks, and the one `canModifyGeometry` and the read road ask too. It is
 * now the ONLY one: the SceneObject-side twin `modifierSource` — which answered the same
 * question of a posed scene value and delegated its `Object` arm here — was deleted once
 * the flip left it with no production callers. There is no second answer to keep in step.
 *
 * The switch is CLOSED BY A `never` ([[V109]]) — this is the same exhaustive guard
 * #388 installed in the twin, MOVED here rather than deleted, and it must stay
 * exhaustive for the same reason: an inequality guard (`data.kind !== 'MeshData'`) is
 * ALREADY TOTAL, so widening `ObjectData` cannot redden it and a genuinely mesh-like
 * new member gets absorbed in silence with the wrong answer. A new data kind is a
 * COMPILE ERROR here, which is the point.
 */
export function modifierDataSource(data: ObjectData): ModifierDataSource | null {
  switch (data.kind) {
    // `ModifiedData` is here for the CHAIN case — a modifier over a modifier's output,
    // which is the reason the stack composes at all: each operator reshapes the
    // cumulative result below it.
    case 'MeshData':
    case 'ModifiedData':
      // Both carry a rebuildable/authoritative handle + an inherited material.
      // `MeshData.material` is the narrower Inline|null (#388), which fits the wide
      // union verbatim; a modified source's BakedMaterialSpec rides through instead of
      // dropping to null (#358).
      //
      // #691 — the TABLE rides through too, and only when it exists. Spread conditionally
      // rather than assigned `undefined`: an explicitly-`undefined` entry is a present key
      // to `Object.keys`, and this value reaches content hashing, so a normalised shape
      // would move every single-material key in the tree for no behaviour change. The pair
      // is emitted whole or not at all, which is `ModifiedDataValue`'s stated invariant
      // (`attributeKey` "present exactly when the table is") applied one lane earlier.
      //
      // ⚠️ `?? undefined` is not noise: the two sources spell the same absence differently.
      // `MeshData.attributeKey` is REQUIRED and nullable (`string | null`);
      // `ModifiedData.attributeKey` is OPTIONAL (`string | undefined`). Carrying a literal
      // `null` through would satisfy neither the field's type nor the both-or-neither rule.
      return {
        geometry: data.geometry,
        material: data.material,
        ...(data.materialSlots === undefined
          ? {}
          : {
              materialSlots: data.materialSlots,
              attributeKey: data.attributeKey ?? undefined,
            }),
      };
    case 'BakedData':
      // A baked source carries NEITHER half — measured, not assumed: `BakedDataValue`
      // declares no `materialSlots` and no `attributeKey`, because a bake writes one
      // material spec (`primaryMaterial` is the declared narrowing at that seam). So there
      // is no table to forward and this arm cannot be folded in with the two above; the
      // compiler is what separated them, on the first typecheck after they were grouped.
      return { geometry: data.geometry, material: data.material };
    case 'CurveData':
    case 'LightData':
    case 'CameraData':
      // Not a mesh face — nothing for a geometry modifier to reshape. Measured, not
      // assumed: Blender 5.1.1 accepts 55 modifier types on a mesh and ZERO on a
      // camera or a light (`ref/GROUND_TRUTH_BLENDER_MODIFIER_DATA.md` §9).
      return null;
    default: {
      const exhaustiveData: never = data;
      void exhaustiveData;
      return null;
    }
  }
}
