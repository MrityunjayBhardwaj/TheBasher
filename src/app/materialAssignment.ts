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
// Today every producer writes a uniform assignment (all faces on slot 0) with exactly one
// slot, so every answer here equals the value the old sibling field carried. That is the
// point of this slice: the read path moves onto the attribute system while the answers are
// still identical, and the discriminating two-valued case arrives next, minted, because the
// real population cannot produce it yet.
//
// ── WHAT THIS DOES NOT DO ─────────────────────────────────────────────────────────────
//
// It does not make a per-face assignment RENDER. The renderer passes a single material to a
// single mesh and never a material array — censused at 0 occurrences of every mechanism
// three.js would need. Making the assignment reach pixels is the next phase's whole subject
// (#638). This module makes it EXPRESSIBLE and READABLE, which is what the consumers that
// are not the renderer — inspector, agent surface, apply-transform, UV editor — need first.
//
// REF: src/nodes/attributes.ts (`MATERIAL_INDEX`); src/app/attributeStore.ts (the holder);
//      src/app/resolveEvaluatedMesh.ts (the consumer); issues #634, #633, #638.

import { MATERIAL_INDEX } from '../nodes/attributes';
import { read } from './attributeStore';

/**
 * A mesh's material assignment: which slots exist, and which slot each face uses.
 *
 * `indices` is `null` when the geometry carries no `material_index` attribute at all — a
 * road with no data half yet (glTF / baked). That is NOT the same as "every face uses slot
 * 0"; it is "this geometry cannot say", and the difference is why it is a null rather than a
 * synthesised array of zeros.
 */
export interface MaterialAssignment<M> {
  readonly slots: readonly M[];
  readonly indices: ArrayLike<number> | null;
}

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
 * The ONE material a single-material read face can carry, or `null`.
 *
 * ⚠️ COLLAPSES a multi-material assignment to its lowest slot, and that is a transitional
 * answer, not a correct one — it exists because `EvaluatedMesh.material` is still a single
 * field. Every consumer that can carry the full answer should call {@link assignedMaterials}
 * instead; this one is for the field that is on its way out.
 */
export function primaryMaterial<M>(assignment: MaterialAssignment<M>): M | null {
  return assignedMaterials(assignment)[0] ?? null;
}
