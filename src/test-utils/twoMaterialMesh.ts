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
  const geometry = boxGeometryRef([1, 1, 1]);
  const indices = new Int32Array(12);
  indices.fill(1, 6);

  const materialIndex: AttributeData = {
    domain: 'face',
    type: 'int',
    count: 12,
    data: indices,
  };
  const minted = mintAttributes({ [MATERIAL_INDEX]: materialIndex });
  if (minted === null) throw new Error('twoMaterialMeshData: the fixture minted nothing');
  insert(minted.key, minted.set, 'evaluate');

  return {
    kind: 'MeshData',
    geometry,
    // The single field can only carry one, which is the limitation the fixture exists to
    // expose: it reports slot 0 and says nothing about slot 1.
    material: SLOT_0_MATERIAL,
    materialKey: null,
    attributeKey: minted.key,
    materialSlots: [SLOT_0_MATERIAL, SLOT_1_MATERIAL],
  };
}
