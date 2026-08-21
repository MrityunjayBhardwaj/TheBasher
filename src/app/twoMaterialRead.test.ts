// #634 (ns-1) — THE DISCRIMINATING TEST. The read side reports TWO.
//
// This is the assertion the whole slice exists for. Every other test in this phase passes on
// a population where the old road and the new road agree; this one does not exist unless the
// attribute system is real, and it is the one a later slice can silently break.
//
// Falsify by GUTTING THE SPECIFIC STEP — make the read collapse to the first slot — and
// require exactly these assertions to red while every uniform case stays green. Deleting the
// attribute type instead reds everything and proves nothing.
//
// REF: src/test-utils/twoMaterialMesh.ts (the minted member);
//      src/app/resolveEvaluatedMesh.ts (`evaluatedMeshFromMeshData`);
//      src/app/materialAssignment.ts; issues #634, #633, #638.

import { describe, expect, it } from 'vitest';
import {
  SLOT_0_MATERIAL,
  SLOT_1_MATERIAL,
  TWO_MATERIAL_TRANSFORM,
  twoMaterialMeshData,
} from '../test-utils/twoMaterialMesh';
import { evaluatedMeshFromMeshData } from './resolveEvaluatedMesh';
import {
  assignedMaterials,
  assignedSlots,
  materialAssignmentReport,
  primaryMaterial,
} from './materialAssignment';
import { multiMaterialBakeRefusal } from './animate/dispatchApplyTransform';
import { BoxDataNode, BoxDataParams } from '../nodes/BoxData';
import type { MeshDataValue } from '../nodes/types';

const twoValued = () =>
  evaluatedMeshFromMeshData(null, twoMaterialMeshData(), TWO_MATERIAL_TRANSFORM);

const uniform = () => {
  const params = BoxDataParams.parse({ size: [1, 1, 1], material: {} });
  const data = BoxDataNode.evaluate(params, {} as never, {} as never) as MeshDataValue;
  return evaluatedMeshFromMeshData(null, data, TWO_MATERIAL_TRANSFORM);
};

describe('#634 a mesh assigning two materials across its faces reads as TWO', () => {
  it('reports both slots, in ascending order', () => {
    const mesh = twoValued();
    expect(assignedSlots(mesh.materials)).toEqual([0, 1]);
    expect(assignedMaterials(mesh.materials)).toEqual([SLOT_0_MATERIAL, SLOT_1_MATERIAL]);
  });

  it('carries the per-face index the geometry declares, not a synthesised one', () => {
    const mesh = twoValued();
    expect(mesh.materials.indices).not.toBeNull();
    expect([...mesh.materials.indices!]).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
  });

  it('reports it through the diagnostic seam a browser observation reads', () => {
    expect(materialAssignmentReport(twoValued().materials)).toEqual({
      slotCount: 2,
      assignedSlots: [0, 1],
      faces: 12,
    });
  });

  it('narrows to ONE only where a caller asks for one', () => {
    // The single-material field is GONE (#636). What remains is an explicit narrowing a
    // caller opts into by name, beside the full answer — not a shape that silently reports
    // one material because it cannot hold two.
    expect(primaryMaterial(twoValued().materials)).toBe(SLOT_0_MATERIAL);
  });
});

describe('#634 the uniform case is unchanged by all of this', () => {
  it('reports exactly one slot', () => {
    const mesh = uniform();
    expect(assignedSlots(mesh.materials)).toEqual([0]);
    expect(assignedMaterials(mesh.materials)).toHaveLength(1);
  });

  it('answers the same material the single field always answered', () => {
    const params = BoxDataParams.parse({ size: [1, 1, 1], material: {} });
    const data = BoxDataNode.evaluate(params, {} as never, {} as never) as MeshDataValue;
    expect(
      primaryMaterial(evaluatedMeshFromMeshData(null, data, TWO_MATERIAL_TRANSFORM).materials),
    ).toBe(data.material);
  });

  it('covers all 12 of the box’s faces, so "uniform" is a measured answer', () => {
    expect(materialAssignmentReport(uniform().materials)).toEqual({
      slotCount: 1,
      assignedSlots: [0],
      faces: 12,
    });
  });
});

describe('#634 the three consumers, each given an explicit answer', () => {
  it('APPLY refuses to bake a mesh that assigns two materials, naming the attribute', () => {
    const reason = multiMaterialBakeRefusal('box-1', twoValued().materials);
    expect(reason).toContain('2 materials');
    expect(reason).toContain('material_index');
    expect(reason).toContain('box-1');
  });

  it('APPLY still bakes the uniform case without complaint', () => {
    expect(multiMaterialBakeRefusal('box-1', uniform().materials)).toBeNull();
  });

  // The DIAGNOSTIC seam is covered by the report assertion above — it is what
  // `__basher_material_assignment` returns, and it is the only seam through which a driven
  // browser observation can see two.
  //
  // The third consumer, `nodeRefCandidates`, reads the resolver's result for `!== null`
  // only: it asks whether the node is a mesh, never what the mesh is made of. It is
  // UNAFFECTED, and that is stated here so the census of consumers is complete rather than
  // partial — an unlisted consumer and an unexamined one look identical afterwards.
});
