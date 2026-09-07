// GltfData evaluator + schema (#389). The DATA half of the last fused kind.
//
// These assert the VALUE CONTRACT, which is the half a later commit cannot silently
// change: the geometry key must be byte-identical to the one `resolveEvaluatedMesh`
// already mints (two spellings of one cache key is how false sharing gets in), the
// material must reach `MeshDataValue.material` under an unchanged path, and the
// multi-slot table must be ABSENT rather than synthesised when the child has one
// primitive — `dataSlotsOnly` reads `materialSlots ?? [material]`, so a one-entry array
// and an absent one are the same answer written two ways, and only one of them is the
// shape every other producer writes.

import { describe, expect, it } from 'vitest';
import { GltfDataNode, GltfDataParams } from './GltfData';
import { openpbrMaterialSchema } from './materialSchema';
import type { MeshDataValue } from './types';

const material = (color: string) => openpbrMaterialSchema().parse({ base: { color } });

const baseParams = {
  assetRef: 'asset-1',
  childName: 'Cube',
  material: material('#c81e5a'),
};

describe('GltfData node', () => {
  it('mints the SAME geometry key resolveEvaluatedMesh already mints for a glTF child', () => {
    const params = GltfDataParams.parse(baseParams);
    const value = GltfDataNode.evaluate(params, {}) as MeshDataValue;

    // The spelling at resolveEvaluatedMesh.ts:176. Asserted literally rather than by
    // importing that module's template, because the point is that the two agree
    // CHARACTER FOR CHARACTER — a shared helper would make this test pass by
    // construction and stop noticing the thing it exists to notice.
    expect(value.geometry.key).toBe('gltf|asset-1|Cube');
    expect(value.geometry.descriptor).toEqual({
      kind: 'gltf',
      assetRef: 'asset-1',
      childName: 'Cube',
    });
  });

  it('produces MeshData carrying the captured material and its key', () => {
    const params = GltfDataParams.parse(baseParams);
    const value = GltfDataNode.evaluate(params, {}) as MeshDataValue;

    expect(value.kind).toBe('MeshData');
    expect(value.material?.base.color).toBe('#c81e5a');
    expect(value.materialKey).toEqual(expect.any(String));
  });

  it('derives NO attribute identity — a glTF child’s buffers live in a clone this value never sees', () => {
    const params = GltfDataParams.parse(baseParams);
    const value = GltfDataNode.evaluate(params, {}) as MeshDataValue;

    // null, and specifically not "not yet": the same answer BakedData gives, for the
    // same reason. A `undefined` here would read as an unset field rather than a fact.
    expect(value.attributeKey).toBeNull();
  });

  it('omits materialSlots entirely for a single-primitive child', () => {
    const params = GltfDataParams.parse(baseParams);
    const value = GltfDataNode.evaluate(params, {}) as MeshDataValue;

    expect('materialSlots' in value).toBe(false);
  });

  it('carries the full slot table verbatim for a multi-primitive child, nulls included', () => {
    const params = GltfDataParams.parse({
      ...baseParams,
      materialSlots: [material('#c81e5a'), null, material('#1e9ac8')],
    });
    const value = GltfDataNode.evaluate(params, {}) as MeshDataValue;

    expect(value.materialSlots).toHaveLength(3);
    // A primitive with no material at all is a real glTF state; it must survive as a
    // hole rather than be dropped, or a three-slot mesh reports as a two-slot one.
    expect(value.materialSlots?.[1]).toBeNull();
    expect(value.materialSlots?.[2]?.base.color).toBe('#1e9ac8');
  });

  it('carries NO override flags — they belong to the Object that owns the pose', () => {
    // Reversed from an earlier draft, on grounding. An override record belongs to the ID
    // that owns the overridden property (Blender's `IDOverrideLibraryProperty.rna_path`
    // is "from owning ID"), and after this split the pose is the Object's. The mechanical
    // half is sharper than the principle: the panel's decorator reads the descriptor from
    // a node's TYPE and the authored bit from that SAME node's params, so the bit and the
    // TRS rows it decorates cannot live on different nodes.
    const params = GltfDataParams.parse(baseParams);

    expect('overridden' in params).toBe(false);
  });

  it('owns no pose and no scene output', () => {
    // The whole point of the split: the data half has no transform to constrain, and
    // reaches the scene only through an Object.
    expect(GltfDataNode.inspectorSections).not.toContain('transform');
    expect(GltfDataNode.inputs).toEqual({});
    expect(GltfDataNode.outputs).toEqual({ out: { type: 'ObjectData', cardinality: 'single' } });
  });

  it('rejects an empty assetRef — a child with no asset is not a child', () => {
    expect(() => GltfDataParams.parse({ ...baseParams, assetRef: '' })).toThrow();
  });
});
