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
  slotMaterialAt,
} from './materialAssignment';
import type { GeometryRef } from '../nodes/types';
import { boxGeometryRef } from './modifierGeometry';

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
const BOX = boxGeometryRef([1, 1, 1], null);

const RED = 'red';
const BLUE = 'blue';

describe('#634 the uniform case — the whole population today', () => {
  it('reports the one slot every face points at', () => {
    const assignment = materialAssignmentOf(storeIndices([0, 0, 0, 0]), [RED], BOX);
    expect(assignedSlots(assignment)).toEqual([0]);
    expect(assignedMaterials(assignment)).toEqual([RED]);
    expect(primaryMaterial(assignment)).toBe(RED);
  });

  it('answers from the slot table when the geometry has no attribute at all', () => {
    // glTF / baked — no data half yet. "Cannot say" resolves to the table's first slot,
    // which is what every consumer read before the attribute system existed.
    const assignment = materialAssignmentOf(null, [RED], BOX);
    expect(assignment.indices).toBeNull();
    expect(assignedMaterials(assignment)).toEqual([RED]);
  });

  it('reports nothing when there is no table to point into', () => {
    expect(assignedSlots(materialAssignmentOf(null, [], BOX))).toEqual([]);
    expect(primaryMaterial(materialAssignmentOf(null, [], BOX))).toBeNull();
  });

  it('treats an unknown key and a wrong-domain attribute as "cannot say", not as a crash', () => {
    expect(materialAssignmentOf('nothing ever minted this', [RED], BOX).indices).toBeNull();

    const pointDomain = mintAttributes({
      [MATERIAL_INDEX]: { domain: 'point', type: 'int', count: 2, data: new Int32Array([0, 1]) },
    })!;
    insert(pointDomain.key, pointDomain.set, 'evaluate');
    expect(materialAssignmentOf(pointDomain.key, [RED, BLUE], BOX).indices).toBeNull();
  });
});

describe('#634 the two-valued case — what the sibling field could never express', () => {
  it('reports TWO, in ascending slot order', () => {
    const assignment = materialAssignmentOf(storeIndices([0, 0, 1, 1]), [RED, BLUE], BOX);
    expect(assignedSlots(assignment)).toEqual([0, 1]);
    expect(assignedMaterials(assignment)).toEqual([RED, BLUE]);
  });

  it('orders by SLOT, not by first appearance', () => {
    const assignment = materialAssignmentOf(storeIndices([1, 1, 0]), [RED, BLUE], BOX);
    expect(assignedSlots(assignment)).toEqual([0, 1]);
  });

  it('reports a face pointing at a missing slot rather than shortening the answer', () => {
    // Dropping it would report a two-material mesh as a one-material one — the exact
    // collapse this read path exists to stop.
    const assignment = materialAssignmentOf(storeIndices([0, 0, 3]), [RED], BOX);
    expect(assignedSlots(assignment)).toEqual([0, 3]);
    expect(assignedMaterials(assignment)).toEqual([RED, null]);
  });

  it('collapses to the lowest slot ONLY through the single-material read face', () => {
    const assignment = materialAssignmentOf(storeIndices([1, 1, 0]), [RED, BLUE], BOX);
    expect(primaryMaterial(assignment)).toBe(RED);
    // …and the full answer stays available beside it, which is what makes the collapse a
    // transitional narrowing rather than data loss.
    expect(assignedMaterials(assignment)).toEqual([RED, BLUE]);
  });
});

// #605 item 2 — THE TWO ABSENCES, TOLD APART.
//
// A `null` slot used to mean both "there is no material" and "a mounted asset clone owns
// what draws and we never captured it", and every reader collapsed them. These rows assert
// the discrimination on the ONLY axis that distinguishes the two — where the buffers live —
// which is why each one is stated against BOTH a clone-backed and a registry-built handle.
// A row over one handle alone would pass with the derivation deleted.
//
// ⚠️ MEASURED, AND IT NARROWS WHAT THESE ROWS CLAIM: a materialless slot on a REGISTRY-BUILT
// mesh has no constructor today — `BoxData.material` is a required object, and `setParam`
// refuses `null` at the schema. So the `none`-over-a-box pairing below is a synthetic input,
// and it earns its place for the reason this module's own doc gives for exporting the minter
// at all: a projection nothing can call with a synthetic input is a projection whose
// interesting cases are unreachable. The arm is the TOTAL answer for meshes the registry
// builds, asserted before a producer for it exists rather than after.
const CLONE_BACKED: GeometryRef = {
  key: 'gltf|asset-a|Cube',
  descriptor: { kind: 'gltf', assetRef: 'asset-a', childName: 'Cube' },
};

describe('#605 item 2 — an absent slot says WHICH nothing it is', () => {
  it('a registry-built mesh answers `none`, a clone-backed one answers `elsewhere`', () => {
    expect(materialAssignmentOf(null, [null], BOX).absentSlot).toBe('none');
    expect(materialAssignmentOf(null, [null], CLONE_BACKED).absentSlot).toBe('elsewhere');
  });

  it('a RECIPE over a clone-backed source is ours, so its absences are `none`', () => {
    // The boundary that makes this one rule rather than two. An array over an imported mesh
    // is built by the registry and its materials are the chain's, so a `kind === 'gltf'`
    // test — which the descriptor still satisfies one level down — would answer `elsewhere`
    // and be wrong. Keyed on availability, this falls the right way for free.
    const recipe: GeometryRef = {
      key: 'gltf|asset-a|Cube|array|3',
      descriptor: { kind: 'array', source: CLONE_BACKED, count: 3, offset: [1, 0, 0] },
    };
    expect(materialAssignmentOf(null, [null], recipe).absentSlot).toBe('none');
  });

  it('slotMaterialAt separates the three answers a bare index cannot', () => {
    const ours = materialAssignmentOf(null, [RED, null], BOX);
    const theirs = materialAssignmentOf(null, [RED, null], CLONE_BACKED);

    // A slot WITH a material reads the same either way — the distinction is about absence.
    expect(slotMaterialAt(ours, 0)).toEqual({ status: 'ok', material: RED });
    expect(slotMaterialAt(theirs, 0)).toEqual({ status: 'ok', material: RED });

    // And the absent one is where they part. Same index, same `null`, two answers.
    expect(slotMaterialAt(ours, 1)).toEqual({ status: 'none' });
    expect(slotMaterialAt(theirs, 1)).toEqual({ status: 'elsewhere' });

    // Off the end is a THIRD answer, not a fourth spelling of absence: "this mesh has no
    // such slot" is a question about the table, not about a material.
    expect(slotMaterialAt(ours, 9)).toEqual({ status: 'no-such-slot' });
    expect(slotMaterialAt(theirs, 9)).toEqual({ status: 'no-such-slot' });
  });
});
