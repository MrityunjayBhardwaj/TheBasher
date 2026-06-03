// BakedMesh evaluator + schema + registration tests — Phase 151 Wave 2 Task 3
// (issue #151).
//
// Pins the 4th-producer node contract:
//   - evaluate returns the BakedMeshValue shape (kind, handle, identity TRS, spec);
//   - the type registers (getNodeType resolves after a re-seed) — the V1 guard so
//     addNode does not silently fail at Apply time;
//   - a hydrate-seam value missing `scale` evaluates to identity [1,1,1] (C-1 /
//     V10/H14 guard) — the post-release-field-without-default trap.
//
// REF: PLAN.md Wave 2 Task 3; RESEARCH §"BakedMesh node shape"; vyapti V1/V10/V29.

import { describe, expect, it } from 'vitest';
import { __resetRegistryForTests, getNodeType } from '../core/dag';
import { __reseedAllNodesForTests } from './registerAll';
import { BakedMeshNode, BakedMeshParams } from './BakedMesh';
import type { BakedMaterialSpec, BakedMeshValue, GeometryRef } from './types';

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
  it('evaluate returns the BakedMeshValue shape with the verbatim handle + identity TRS', () => {
    const params = BakedMeshParams.parse({ geometry: BAKED_GEOM, material: SPEC });
    const value = BakedMeshNode.evaluate(params, {}) as BakedMeshValue;
    expect(value).toEqual({
      kind: 'BakedMesh',
      geometry: BAKED_GEOM,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      material: SPEC,
    });
  });

  it('registers — getNodeType resolves after a re-seed (V1, addNode validates at Apply)', () => {
    __resetRegistryForTests();
    __reseedAllNodesForTests();
    expect(getNodeType('BakedMesh')).toBeDefined();
    expect(getNodeType('BakedMesh')?.type).toBe('BakedMesh');
  });

  it('a hydrate-seam value missing scale evaluates to identity [1,1,1] (C-1 / V10/H14)', () => {
    // Bypass the schema default (in-memory state surgery / agent op) — scale absent.
    const value = BakedMeshNode.evaluate(
      {
        geometry: BAKED_GEOM,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: undefined as unknown as [number, number, number],
        material: SPEC,
      },
      {},
    ) as BakedMeshValue;
    expect(value.scale).toEqual([1, 1, 1]);
  });

  it('schema defaults position/rotation/scale to identity when omitted', () => {
    const params = BakedMeshParams.parse({ geometry: BAKED_GEOM, material: SPEC });
    expect(params.position).toEqual([0, 0, 0]);
    expect(params.rotation).toEqual([0, 0, 0]);
    expect(params.scale).toEqual([1, 1, 1]);
  });
});
