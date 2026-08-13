// #634 (ns-1) — reading a mesh's material assignment THROUGH the attribute system.
//
// ── THE INDEX IS GEOMETRY, THE TABLE IS OBJECT-LEVEL ──────────────────────────────────
//
// Both reference systems draw the same line, and it is what this module implements. A
// per-face `material_index` belongs to the geometry: editing it in Blender is a mesh-data
// edit and propagates to every object sharing that mesh. The SLOT TABLE the index points
// into is object-level, which is what lets two objects share one mesh and still look
// different. So an assignment is a pair — indices from the geometry's attributes, slots from
// the object's data — and neither half means anything alone.
//
// 🔴 WHAT USED TO STAND HERE IS NOW FALSE, AND IT IS RESTATED RATHER THAN DELETED, because
// the shape of the change is the thing worth knowing (#638, ns-1b).
//
// ns-1 said: *every producer writes a uniform assignment (all faces on slot 0) with exactly
// one slot, so every answer here equals the value the old sibling field carried … the real
// population cannot produce a two-valued case yet.* True of ns-1, which shipped the read
// half deliberately ahead of the render half. It stopped being true the moment
// `SetMaterialOp` gained a face range: a partial range writes TWO slots and a non-uniform
// index, and the discriminating case is now something a director can author.
//
// ── WHAT THIS DOES NOT DO ─────────────────────────────────────────────────────────────
//
// ns-1 also said: *it does not make a per-face assignment RENDER — the renderer passes a
// single material to a single mesh and never a material array, censused at 0 occurrences.*
// That census now answers THREE production modules, and the one that mints an array reads
// this module's own `assignedSlots` to decide. Making the assignment reach pixels was the
// next phase's whole subject, and that phase has landed.
//
// What is still true, and is the reason this module exists as its own seam: it does not
// DECIDE what a mesh draws with. It answers what a mesh is made of — one pair, one
// derivation — for the renderer and for every consumer that is not the renderer alike
// (inspector, agent surface, apply-transform, UV editor). The array-or-single decision has
// exactly one owner and it is not here, because that decision needs the built instance's
// group layout, which this module has no business holding.
//
// ⚠️ The two roads must agree about the single-material case as well as the multi one: the
// lowest USED slot is the answer on both sides, never slot 0 by assumption. See #651.
//
// REF: src/nodes/attributes.ts (`MATERIAL_INDEX`); src/app/attributeStore.ts (the holder);
//      src/app/resolveEvaluatedMesh.ts (the read consumer); src/app/resolveMeshMaterial.ts
//      (the render consumer, and the owner of the decision); issues #634, #633, #638, #651.

import { MATERIAL_INDEX } from '../nodes/attributes';
import type { MaterialAssignment } from '../nodes/types';
import { read } from './attributeStore';

/**
 * Pair the geometry's face attribute with the object's slot table.
 *
 * Synchronous and total: an unknown key, a missing attribute or an attribute at the wrong
 * domain all resolve to `indices: null` rather than throwing, because a read-side consumer
 * asking "what is this made of" is not the place to fail a malformed value.
 */
export function materialAssignmentOf<M>(
  attributeKey: string | null,
  slots: readonly M[],
): MaterialAssignment<M> {
  if (attributeKey === null) return { slots, indices: null };
  const set = read(attributeKey);
  const attribute = set?.[MATERIAL_INDEX];
  if (!attribute || attribute.domain !== 'face') return { slots, indices: null };
  return { slots, indices: attribute.data };
}

/**
 * The slot numbers this mesh actually uses, ascending and without repeats.
 *
 * This is the discriminating answer — the one a uniform assignment and a two-material mesh
 * give differently, and the reason the read path was moved here at all. With no per-face
 * attribute the answer is slot 0 alone when there is a table to point into, and nothing when
 * there is not.
 */
export function assignedSlots<M>(assignment: MaterialAssignment<M>): readonly number[] {
  const { indices, slots } = assignment;
  if (indices === null) return slots.length > 0 ? [0] : [];

  const seen = new Set<number>();
  for (let i = 0; i < indices.length; i++) seen.add(indices[i]);
  return [...seen].sort((a, b) => a - b);
}

/**
 * The materials this mesh actually uses, in ascending slot order.
 *
 * An index with no slot behind it resolves to `null` rather than being dropped: a face
 * pointing at a slot that does not exist is a real state a malformed value can reach, and
 * silently shortening the answer would report a two-material mesh as a one-material one.
 */
export function assignedMaterials<M>(assignment: MaterialAssignment<M>): readonly (M | null)[] {
  return assignedSlots(assignment).map((slot) => assignment.slots[slot] ?? null);
}

/**
 * The lowest-slot material, or `null` — an OPT-IN NARROWING, never the shape.
 *
 * ⚠️ COLLAPSES a multi-material assignment to one material. That is lossy by construction,
 * so it belongs at a call site that genuinely cannot carry more than one and has said so:
 * a bake writes a single material spec, and `dispatchApplyTransform` refuses a
 * multi-material mesh by name BEFORE narrowing rather than quietly dropping a slot here.
 *
 * The narrowing is deliberately not the default anywhere. `EvaluatedMesh` carries the whole
 * {@link MaterialAssignment}; every consumer that can hold the full answer calls
 * {@link assignedMaterials}. Reaching for this one is a decision a reader can see.
 */
export function primaryMaterial<M>(assignment: MaterialAssignment<M>): M | null {
  return assignedMaterials(assignment)[0] ?? null;
}

/**
 * The object's slot TABLE for a data value — the ONE derivation, so the optional multi-slot
 * field and the single `material` field can never be read as two answers.
 *
 * Generic over the material type rather than widened to a union, and that is the difference
 * between one derivation and two: `MeshDataValue` carries inline specs only while
 * `ModifiedDataValue` carries the wider Inline|Baked union (a modifier over a baked source
 * inherits one). A widened signature would hand every caller the wide union and push a
 * narrowing back out to each of them; the generic gives each road its own type through the
 * same single line of logic.
 */
export function materialSlotsOf<M>(data: {
  readonly material: M;
  readonly materialSlots?: readonly M[];
}): readonly M[] {
  return data.materialSlots ?? [data.material];
}

/**
 * A flat, JSON-safe description of an assignment, for the diagnostic seam a driven browser
 * observation reads. Numbers rather than specs: the question at that seam is "how many
 * materials does this mesh use, and which slots", not "what are they made of".
 */
export function materialAssignmentReport<M>(assignment: MaterialAssignment<M>): {
  readonly slotCount: number;
  readonly assignedSlots: readonly number[];
  readonly faces: number;
} {
  return {
    slotCount: assignment.slots.length,
    assignedSlots: assignedSlots(assignment),
    faces: assignment.indices ? assignment.indices.length : 0,
  };
}
