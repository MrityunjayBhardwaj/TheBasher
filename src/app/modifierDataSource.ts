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
    case 'BakedData':
    case 'ModifiedData':
      // All three carry a rebuildable/authoritative handle + an inherited material.
      // `MeshData.material` is the narrower Inline|null (#388), which fits the wide
      // union verbatim; a baked or modified source's BakedMaterialSpec rides through
      // instead of dropping to null (#358).
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
