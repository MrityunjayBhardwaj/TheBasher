// #1430 — a point's influences are read and written in one place, at whatever width the mesh has.
import { describe, expect, it } from 'vitest';
import { SKIN_JOINTS, SKIN_WEIGHTS } from './attributes';
import {
  skinJointsLayerName,
  skinLanes,
  skinPointLayers,
  skinSetCount,
  skinWeightsLayerName,
} from './skinInfluences';
import type { MeshPointLayer } from './types';

describe('#1430 — influence sets', () => {
  it('set 0 keeps the names every stored mesh already has; further sets are numbered', () => {
    expect([skinJointsLayerName(0), skinWeightsLayerName(0)]).toEqual([SKIN_JOINTS, SKIN_WEIGHTS]);
    expect([skinJointsLayerName(2), skinWeightsLayerName(2)]).toEqual([
      `${SKIN_JOINTS}_2`,
      `${SKIN_WEIGHTS}_2`,
    ]);
  });

  it('a mesh with no skin has no lanes', () => {
    expect(skinLanes({ pointLayers: [] })).toBeNull();
    expect(skinSetCount({ pointLayers: [] })).toBe(0);
  });

  it('one set comes back as it is stored: the same arrays, nothing copied', () => {
    const joints = new Int32Array([0, 1, 0, 0, 1, 0, 0, 0]);
    const weights = new Float32Array([0.5, 0.5, 0, 0, 1, 0, 0, 0]);
    const lanes = skinLanes({ pointLayers: skinPointLayers({ width: 4, joints, weights }) })!;
    expect(lanes.width).toBe(4);
    expect(lanes.joints).toBe(joints);
    expect(lanes.weights).toBe(weights);
  });

  it('two sets lie side by side per point, and split back into the same layers', () => {
    // Two points, eight lanes each.
    const joints = new Int32Array([1, 2, 3, 4, 5, 0, 0, 0, 0, 1, 2, 3, 4, 5, 0, 0]);
    const weights = new Float32Array([
      0.3, 0.25, 0.2, 0.15, 0.1, 0, 0, 0, 0.1, 0.2, 0.2, 0.2, 0.2, 0.1, 0, 0,
    ]);
    const layers = skinPointLayers({ width: 8, joints, weights });
    expect(layers.map((l) => [l.name, l.type])).toEqual([
      [SKIN_JOINTS, 'int4'],
      [SKIN_WEIGHTS, 'float4'],
      [`${SKIN_JOINTS}_1`, 'int4'],
      [`${SKIN_WEIGHTS}_1`, 'float4'],
    ]);
    // Set 1 of point 0 is its fifth influence, alone.
    expect(Array.from(layers[2].data.subarray(0, 4))).toEqual([5, 0, 0, 0]);
    expect(skinSetCount({ pointLayers: layers })).toBe(2);
    const lanes = skinLanes({ pointLayers: layers })!;
    expect(lanes.width).toBe(8);
    expect(Array.from(lanes.joints)).toEqual(Array.from(joints));
    expect(Array.from(lanes.weights)).toEqual(Array.from(weights));
  });

  it('sets are counted from 0 without a gap: a set 2 with no set 1 is not read', () => {
    const four = (): MeshPointLayer[] => [
      { name: skinJointsLayerName(0), type: 'int4', data: new Int32Array(4) },
      { name: skinWeightsLayerName(0), type: 'float4', data: new Float32Array(4) },
      { name: skinJointsLayerName(2), type: 'int4', data: new Int32Array(4) },
      { name: skinWeightsLayerName(2), type: 'float4', data: new Float32Array(4) },
    ];
    expect(skinSetCount({ pointLayers: four() })).toBe(1);
  });

  it('half a set of lanes cannot be stored', () => {
    expect(() =>
      skinPointLayers({ width: 6, joints: new Int32Array(6), weights: new Float32Array(6) }),
    ).toThrow(/whole number of sets/);
  });
});
