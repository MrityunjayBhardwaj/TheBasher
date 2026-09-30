// #634 (ns-1) — reading an assignment: uniform today, two-valued the moment one exists.
//
// REF: src/app/materialAssignment.ts; issues #634, #633, #638.

import { describe, expect, it } from 'vitest';
import { MATERIAL_INDEX, type AttributeData } from '../nodes/attributes';
import { mintAttributes } from '../nodes/attributeKey';
import { insert } from './attributeStore';
import {
  assignedMaterials,
  assignedSlots,
  materialAssignmentOf,
  primaryMaterial,
  primarySlotMaterial,
  slotMaterialAt,
} from './materialAssignment';

/** Put a face-domain `material_index` in the store and hand back its key. */
function storeIndices(values: number[]): string {
  const attribute: AttributeData = {
    domain: 'face',
    type: 'int',
    count: values.length,
    data: new Int32Array(values),
  };
  const minted = mintAttributes({ [MATERIAL_INDEX]: attribute })!;
  insert(minted.key, minted.set, 'evaluate');
  return minted.key;
}

/** Any registry-built handle: these rows are about the index/table pair, not about
 *  where the materials live, so the mesh is procedural and an absent slot means 'none'. */

const RED = 'red';
const BLUE = 'blue';

describe('#634 the uniform case — the whole population today', () => {
  it('reports the one slot every face points at', () => {
    const assignment = materialAssignmentOf(storeIndices([0, 0, 0, 0]), [RED]);
    expect(assignedSlots(assignment)).toEqual([0]);
    expect(assignedMaterials(assignment)).toEqual([RED]);
    expect(primaryMaterial(assignment)).toBe(RED);
  });

  it('answers from the slot table when the geometry has no attribute at all', () => {
    // glTF / baked — no data half yet. "Cannot say" resolves to the table's first slot,
    // which is what every consumer read before the attribute system existed.
    const assignment = materialAssignmentOf(null, [RED]);
    expect(assignment.indices).toBeNull();
    expect(assignedMaterials(assignment)).toEqual([RED]);
  });

  it('reports nothing when there is no table to point into', () => {
    expect(assignedSlots(materialAssignmentOf(null, []))).toEqual([]);
    expect(primaryMaterial(materialAssignmentOf(null, []))).toBeNull();
  });

  it('treats an unknown key and a wrong-domain attribute as "cannot say", not as a crash', () => {
    expect(materialAssignmentOf('nothing ever minted this', [RED]).indices).toBeNull();

    const pointDomain = mintAttributes({
      [MATERIAL_INDEX]: { domain: 'point', type: 'int', count: 2, data: new Int32Array([0, 1]) },
    })!;
    insert(pointDomain.key, pointDomain.set, 'evaluate');
    expect(materialAssignmentOf(pointDomain.key, [RED, BLUE]).indices).toBeNull();
  });
});

describe('#634 the two-valued case — what the sibling field could never express', () => {
  it('reports TWO, in ascending slot order', () => {
    const assignment = materialAssignmentOf(storeIndices([0, 0, 1, 1]), [RED, BLUE]);
    expect(assignedSlots(assignment)).toEqual([0, 1]);
    expect(assignedMaterials(assignment)).toEqual([RED, BLUE]);
  });

  it('orders by SLOT, not by first appearance', () => {
    const assignment = materialAssignmentOf(storeIndices([1, 1, 0]), [RED, BLUE]);
    expect(assignedSlots(assignment)).toEqual([0, 1]);
  });

  it('reports a face pointing at a missing slot rather than shortening the answer', () => {
    // Dropping it would report a two-material mesh as a one-material one — the exact
    // collapse this read path exists to stop.
    const assignment = materialAssignmentOf(storeIndices([0, 0, 3]), [RED]);
    expect(assignedSlots(assignment)).toEqual([0, 3]);
    expect(assignedMaterials(assignment)).toEqual([RED, null]);
  });

  it('collapses to the lowest slot ONLY through the single-material read face', () => {
    const assignment = materialAssignmentOf(storeIndices([1, 1, 0]), [RED, BLUE]);
    expect(primaryMaterial(assignment)).toBe(RED);
    // …and the full answer stays available beside it, which is what makes the collapse a
    // transitional narrowing rather than data loss.
    expect(assignedMaterials(assignment)).toEqual([RED, BLUE]);
  });
});

// #605 item 2 — AN ABSENCE IS NOT A MISSING SLOT. A second absence, `elsewhere` (a clone-drawn
// slot whose material we never captured), went with the clone road in #1053.
describe('#605 item 2 — an absent slot says which nothing it is', () => {
  it('slotMaterialAt separates the answers a bare index cannot', () => {
    const a = materialAssignmentOf(null, [RED, null]);
    expect(slotMaterialAt(a, 0)).toEqual({ status: 'ok', material: RED });
    expect(slotMaterialAt(a, 1)).toEqual({ status: 'none' });
    // Off the end is a different answer again: "this mesh has no such slot" is a question
    // about the table, not about a material.
    expect(slotMaterialAt(a, 9)).toEqual({ status: 'no-such-slot' });
  });
});

describe('#1015 — the primary slot keeps the distinction `primaryMaterial` has no room for', () => {
  it('answers `none` where the narrowing answers `null`', () => {
    const a = materialAssignmentOf(null, [null]);
    expect(primaryMaterial(a)).toBeNull();
    expect(primarySlotMaterial(a)).toEqual({ status: 'none' });
  });

  it('reads the LOWEST ASSIGNED slot, not slot 0 — the same rule `primaryMaterial` uses', () => {
    // Every face points at slot 1. `slotMaterialAt(a, 0)` would answer about a slot nothing
    // uses, which is a different question and the easy way to write this wrong: the two roads
    // must name the same slot or the widening has changed the answer as well as its type.
    const key = storeIndices([1, 1, 1, 1, 1, 1]);
    const a = materialAssignmentOf(key, [null, BLUE]);

    expect(assignedSlots(a)).toEqual([1]);
    expect(primaryMaterial(a)).toBe(BLUE);
    expect(primarySlotMaterial(a)).toEqual({ status: 'ok', material: BLUE });
  });

  it('an EMPTY slot table is `no-such-slot`, never an empty slot 0', () => {
    // The table says this mesh has no slots at all. Answering `none` would claim a slot 0
    // exists and is empty — a statement about a material where the truth is about the table.
    const empty = materialAssignmentOf(null, []);
    expect(assignedSlots(empty)).toEqual([]);
    expect(primarySlotMaterial(empty)).toEqual({ status: 'no-such-slot' });
  });
});
