// #634 (ns-1) — THE TWO-VALUED MEMBER: a mesh that assigns two materials across its faces.
//
// ── WHY THIS HAS TO BE MINTED ─────────────────────────────────────────────────────────
//
// Every producer in the real population writes a UNIFORM assignment — one material slot,
// every face pointing at it — because nothing in the app can yet author anything else. So
// the old single-field road and the new attribute road agree on every input that exists,
// and the whole suite passes with the attribute system bypassed. That was measured, not
// assumed: reverting the read path to read the sibling field directly left all 330 files and
// 3974 tests green, byte for byte.
//
// A discriminating case therefore cannot be FOUND. It has to be constructed, and it has to
// be a STANDING fixture rather than a scratch probe, because the property it discriminates —
// "the read side reports two" — is exactly what every later slice can silently break.
//
// ── WHY IT IS BUILT AT THE VALUE, NOT THROUGH A NODE ──────────────────────────────────
//
// There is no node type that emits two material slots, and adding one to make a test
// possible would ship an authoring surface the design has not decided on yet (the slot
// table's editor is a later phase's subject). The fixture builds the DATA VALUE, which is
// the real shape the resolver consumes, and hands it to the real projection — so everything
// downstream of `evaluatedMeshFromMeshData` is exercised for real. What it does not cover is
// the evaluator hop above it, which is uniform by construction anyway.
//
// REF: src/app/materialAssignment.ts; src/app/resolveEvaluatedMesh.ts
//      (`evaluatedMeshFromMeshData`); src/nodes/attributes.ts; issues #634, #633, #638.

import { boxGeometryRef } from '../app/modifierGeometry';
import { insert } from '../app/attributeStore';
import { MATERIAL_INDEX, type AttributeData } from '../nodes/attributes';
import { mintAttributes } from '../nodes/attributeKey';
import { openpbrMaterialSchema } from '../nodes/materialSchema';
import type { InlineMaterialSpec, MeshDataValue, MeshTransform } from '../nodes/types';

const material = (color: string): InlineMaterialSpec =>
  openpbrMaterialSchema().parse({ name: color, base: { color } }) as InlineMaterialSpec;

/** Slot 0 — the material the lower half of the box's faces use. */
export const SLOT_0_MATERIAL = material('#ff0000');

/** Slot 1 — the material the upper half use. Distinct in every rendering lobe that matters. */
export const SLOT_1_MATERIAL = material('#0000ff');

export const TWO_MATERIAL_TRANSFORM: MeshTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

/**
 * A box whose 12 faces split evenly between two material slots: the first six on slot 0, the
 * last six on slot 1.
 *
 * The attribute is put in the store as a side effect, exactly as a producer's `evaluate`
 * would do it, so a consumer resolving through `attributeKey` finds it the same way.
 */
export function twoMaterialMeshData(): MeshDataValue {
  const indices = new Int32Array(12);
  indices.fill(1, 6);
  return boxFromFaceIndices(indices);
}

/**
 * A box with **face 0 alone** on slot 1 and the other eleven on slot 0 — the NON-ALIGNED
 * fixture (#638).
 *
 * ⚠️ THIS EXISTS BECAUSE THE 6/6 SPLIT ABOVE CANNOT DETECT A WHOLE ERROR CLASS. Two things
 * are both honestly called "a box's faces" and they differ by 2×: the attribute domain
 * `face` means TRIANGLES (12), while `BoxGeometry.groups` means CUBE SIDES (6, two triangles
 * each). The 6/6 split lands exactly on a cube-side boundary — sides 0,1,2 against sides
 * 3,4,5 — so an implementation resolving at cube-side granularity renders three sides of
 * each material and looks correct on that fixture, in pixels AND in draw-call count.
 *
 * Face 0 alone does not align to a cube side. The correct layout is `[{0,3,1},{3,33,0}]`; a
 * cube-side implementation yields `[{0,6,1},{6,30,0}]`, which still covers 36 of 36. **So the
 * assertion that discriminates is on the group BOUNDARY (`start: 3`), never on coverage.**
 */
export function nonAlignedMaterialMeshData(): MeshDataValue {
  const indices = new Int32Array(12);
  indices[0] = 1;
  return boxFromFaceIndices(indices);
}

/**
 * A box with faces on slots 0 and 3 over a table of FOUR — the SPARSE fixture (#638).
 *
 * ⚠️ THIS EXISTS TO CATCH THE MOST ATTRACTIVE WRONG LINE IN THE RESOLUTION STEP.
 * `assignedMaterials()` maps the slots a mesh USES, so here it returns a length-TWO array:
 * the material for slot 0 and the material for slot 3, compacted. Handed to a mesh whose
 * groups say `materialIndex: 3`, `material[3]` is `undefined` and the renderer skips those
 * groups with no error at all — a third of the box disappears. The helper is right there and
 * its name reads correct, which is exactly why the discriminating case is a table with a
 * HOLE in the middle rather than another dense one.
 *
 * The empty slots are real: an object may declare four slots and leave two unassigned.
 */
export function sparseSlotMaterialMeshData(): MeshDataValue {
  const indices = new Int32Array(12);
  indices.fill(3, 8);
  return boxFromFaceIndices(indices, [SLOT_0_MATERIAL, null, null, SLOT_1_MATERIAL]);
}

/**
 * The one builder every fixture here goes through, so they cannot drift in how they mint,
 * store or describe an assignment — only in the indices and the table they hand it.
 *
 * The attribute is put in the store as a side effect, exactly as a producer's `evaluate`
 * would do it, so a consumer resolving through `attributeKey` finds it the same way.
 */
export function boxFromFaceIndices(
  indices: Int32Array,
  slots: readonly (InlineMaterialSpec | null)[] = [SLOT_0_MATERIAL, SLOT_1_MATERIAL],
): MeshDataValue {
  const materialIndex: AttributeData = {
    domain: 'face',
    type: 'int',
    count: indices.length,
    data: indices,
  };
  const minted = mintAttributes({ [MATERIAL_INDEX]: materialIndex });
  if (minted === null) throw new Error('boxFromFaceIndices: the fixture minted nothing');
  insert(minted.key, minted.set, 'evaluate');

  // #638 — the mint comes FIRST and the key is folded in, exactly as a producer's
  // `evaluate` now does it. This is not a detail of the fixture: an unfolded handle here
  // would give the phase's own two-valued discriminator a bare `box|1,1,1` key, so the
  // registry would write no groups, the stock six-side layout would survive, and a
  // two-length material array would draw twelve of thirty-six triangles. The fixture
  // would be the constructor for the exact failure it exists to detect. It cannot be
  // built that way now — the builder does not compile without an answer.
  const geometry = boxGeometryRef([1, 1, 1], minted.key);

  return {
    kind: 'MeshData',
    geometry,
    // The single field can only carry one, which is the limitation the fixture exists to
    // expose: it reports slot 0 and says nothing about slot 1.
    material: slots[0] ?? SLOT_0_MATERIAL,
    materialKey: null,
    attributeKey: minted.key,
    materialSlots: slots,
  };
}
