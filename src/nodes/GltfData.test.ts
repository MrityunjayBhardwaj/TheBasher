// GltfData evaluator + schema (#389, #1053). The data half of a saved clone-road import.
//
// Since #1053 every new import is native or refused, so a `GltfData` exists only in a save the
// load converter kept unconverted. Such an import draws nothing and the load says why (decided
// on #1053, 2026-09-30). These rows pin that answer where it is produced: the node evaluates to
// NO data, so its Object is an Empty — not to a geometry ref that answers questions about a mesh
// nothing draws.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetRegistryForTests,
  applyOp,
  emptyDagState,
  evaluate,
  type EvalCtx,
  type Op,
} from '../core/dag';
import { importedChildOps } from '../test-utils/importedChildFixture';
import { GltfDataNode, GltfDataParams } from './GltfData';
import { registerAllNodes } from './registerAll';
import { openpbrMaterialSchema } from './materialSchema';
import type { ObjectValue } from './types';

const CTX: EvalCtx = { time: { frame: 0, seconds: 0, normalized: 0 } };

const material = (color: string) => openpbrMaterialSchema().parse({ base: { color } });

const baseParams = {
  assetRef: 'asset-1',
  childName: 'Cube',
  material: material('#c81e5a'),
};

describe('GltfData node', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  it('evaluates to no data, whatever it captured', () => {
    const params = GltfDataParams.parse({
      ...baseParams,
      materialSlots: [material('#c81e5a'), null],
      faceCount: 12,
      pointCount: 8,
    });
    expect(GltfDataNode.evaluate(params, {}, CTX)).toBeNull();
  });

  it('makes its Object an Empty that keeps its own transform', () => {
    let state = emptyDagState();
    for (const op of importedChildOps('child', {
      material: baseParams.material,
      position: [1, 2, 3],
    })) {
      state = applyOp(state, op as unknown as Op).next;
    }
    const value = evaluate(state, 'child').value as ObjectValue;
    expect(value.kind).toBe('Object');
    expect(value.data).toBeNull();
    expect(value.position).toEqual([1, 2, 3]);
  });

  it('carries NO override flags — they belong to the Object that owns the pose', () => {
    // An override record belongs to the ID that owns the overridden property (Blender's
    // `IDOverrideLibraryProperty.rna_path` is "from owning ID"), and the pose is the Object's.
    const params = GltfDataParams.parse(baseParams);

    expect('overridden' in params).toBe(false);
  });

  it('owns no pose and no scene output', () => {
    expect(GltfDataNode.inputs).toEqual({});
    expect(GltfDataNode.outputs).toEqual({ out: { type: 'ObjectData', cardinality: 'single' } });
  });

  it('rejects an empty assetRef — the converter needs the file it came from', () => {
    expect(() => GltfDataParams.parse({ ...baseParams, assetRef: '' })).toThrow();
  });
});
