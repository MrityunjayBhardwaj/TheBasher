// BakedMesh evaluator + schema + registration tests — Phase 151 Wave 2 Task 3
// (issue #151).
//
// #388 Stage C · C5 — THE NODE IS RETIRED, and this file is what is left worth pinning.
// A baked mesh is an `Object` → `BakedData` split; saved projects migrate on load and
// Apply mints the pair, so no live node reaches evaluate.
//
//   - evaluate THROWS the retirement sentinel (a migration bug must fail loudly rather
//     than render an identity-posed mesh nobody asked for);
//   - the type still REGISTERS and its SCHEMA still parses — both load-bearing, not
//     leftovers: the load ladder normalizes a saved fused node through this definition
//     BEFORE the format migration splits it, so dropping either would break exactly the
//     projects the migration exists to rescue.
//
// WHAT MOVED, so the coverage is not merely lost: the value SHAPE this file used to pin
// is now produced by `recomposeBakedObject` (the pair → `BakedMeshValue` the renderer
// still consumes) and pinned in bakedRecompose.test.ts, along with the C-1/V10/H14
// identity-scale hydrate guard that used to live in this evaluator.
//
// REF: src/nodes/bakedRecompose.ts + .test.ts; src/core/project/migrations.ts (v7 → v8);
//      vyapti V1/V10/V29; issue #388.

import { describe, expect, it } from 'vitest';
import { __resetRegistryForTests, getNodeType } from '../core/dag';
import { __reseedAllNodesForTests } from './registerAll';
import { BakedMeshNode, BakedMeshParams } from './BakedMesh';
import type { BakedMaterialSpec, GeometryRef } from './types';

const BAKED_GEOM: GeometryRef = {
  key: 'baked|abc123-8',
  kind: 'baked',
  descriptor: { kind: 'baked', hash: 'abc123', vertexCount: 8 },
};

const SPEC: BakedMaterialSpec = {
  materialClass: 'standard',
  color: '#5af07a',
  roughness: 1,
  metalness: 0,
  opacity: 1,
  transparent: false,
  emissive: '#000000',
  emissiveIntensity: 1,
  map: null,
  normalMap: null,
  roughnessMap: null,
  metalnessMap: null,
  aoMap: null,
  emissiveMap: null,
};

describe('BakedMesh node', () => {
  it('evaluate THROWS — the node is retired, so reaching it is a migration bug (#388)', () => {
    const params = BakedMeshParams.parse({ geometry: BAKED_GEOM, material: SPEC });
    expect(() => BakedMeshNode.evaluate(params, {})).toThrow(/BakedMesh is retired/);
  });

  it('registers — getNodeType resolves after a re-seed (V1, addNode validates at Apply)', () => {
    __resetRegistryForTests();
    __reseedAllNodesForTests();
    expect(getNodeType('BakedMesh')).toBeDefined();
    expect(getNodeType('BakedMesh')?.type).toBe('BakedMesh');
  });

  // The schema outlives the evaluator: `migrateNodes` parses a saved fused node through it
  // on the way to being split, so a saved mesh that omitted `scale` must still land at
  // identity rather than failing to parse.
  it('schema defaults position/rotation/scale to identity when omitted', () => {
    const params = BakedMeshParams.parse({ geometry: BAKED_GEOM, material: SPEC });
    expect(params.position).toEqual([0, 0, 0]);
    expect(params.rotation).toEqual([0, 0, 0]);
    expect(params.scale).toEqual([1, 1, 1]);
  });
});
