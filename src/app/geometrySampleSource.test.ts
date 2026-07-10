// geometrySampleSource — the driver-resolution seam for the SampleGeometry road.
// The pure ray-vs-mesh math is proven in sampleTerrain.test.ts; this proves the SEAM
// wiring: it materializes the terrain's world geometry (registry + world matrix) and
// samples the ground under a query Null. Mirrors resolveWorldTransform.test.ts's
// buildDefaultDagState + applyOp scaffold. The live boundary-pair (render == read) is
// observed in a throwaway e2e; this suite guards the resolution in CI.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import {
  geometrySampleRefOf,
  geometrySampleSourceOf,
  readTerrainSampleAt,
} from './geometrySampleSource';

const ctxAt = (seconds: number) => ({ time: { frame: 0, seconds, normalized: 0 } });

/** A scene with a flat terrain box (top face at y = 2 + 0.5 = 2.5) + a query Null, both
 *  wired into the default scene's children. `nullPos` places the query point. */
function buildTerrainState(nullPos: [number, number, number], terrainRotZ = 0): DagState {
  let state = buildDefaultDagState();
  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: 'geo_terrain',
      nodeType: 'BoxMesh',
      params: {
        size: [20, 1, 20],
        position: [0, 2, 0],
        rotation: [0, 0, terrainRotZ],
        scale: [1, 1, 1],
      },
    },
    {
      type: 'connect',
      from: { node: 'geo_terrain', socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    },
    {
      type: 'addNode',
      nodeId: 'geo_null',
      nodeType: 'Null',
      params: { position: nullPos, rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    {
      type: 'connect',
      from: { node: 'geo_null', socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    },
    {
      type: 'addNode',
      nodeId: 'geo_sample',
      nodeType: 'SampleGeometry',
      params: { sourceGeometry: { node: 'geo_terrain' }, at: { node: 'geo_null' } },
    },
  ];
  for (const op of ops) state = applyOp(state, op).next;
  return state;
}

const REF = { geometry: 'geo_terrain', at: 'geo_null' };

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('readTerrainSampleAt', () => {
  it('snaps to a flat terrain top under the query XZ', () => {
    const state = buildTerrainState([4, 10, -3]);
    const { point, sample } = readTerrainSampleAt(state, REF, ctxAt(0));
    expect(sample).not.toBeNull();
    expect(point[0]).toBeCloseTo(4, 3);
    expect(point[1]).toBeCloseTo(2.5, 3); // terrain top: 2 (position) + 0.5 (half height)
    expect(point[2]).toBeCloseTo(-3, 3);
    expect(sample!.normal[1]).toBeCloseTo(1, 3); // flat → up normal
  });

  it('reads the real slope of a tilted terrain (height varies with X)', () => {
    const plus = readTerrainSampleAt(buildTerrainState([6, 10, 0], 20), REF, ctxAt(0));
    const minus = readTerrainSampleAt(buildTerrainState([-6, 10, 0], 20), REF, ctxAt(0));
    expect(plus.sample).not.toBeNull();
    expect(minus.sample).not.toBeNull();
    // Measured gradient across the 12-unit span ≈ tan(20°) = 0.364.
    expect((plus.point[1] - minus.point[1]) / 12).toBeCloseTo(Math.tan((20 * Math.PI) / 180), 2);
    expect(plus.sample!.normal[1]).toBeGreaterThan(0);
  });

  it('falls back to the query position off the terrain footprint (no origin jump)', () => {
    const state = buildTerrainState([100, 7, 100]);
    const { point, sample } = readTerrainSampleAt(state, REF, ctxAt(0));
    expect(sample).toBeNull(); // ray missed the footprint
    expect(point).toEqual([100, 7, 100]); // the Null's own world position, not [0,0,0]
  });
});

describe('geometrySampleSourceOf / geometrySampleRefOf', () => {
  it('detects a SampleGeometry wired to a driver inVec, and parses its refs', () => {
    let state = buildTerrainState([0, 5, 0]);
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'geo_drv',
      nodeType: 'ParamDriver',
      params: { target: 'n_box', paramPath: 'position', blendMode: 'replace', order: 0 },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'geo_sample', socket: 'out' },
      to: { node: 'geo_drv', socket: 'inVec' },
    }).next;

    const src = geometrySampleSourceOf(state.nodes['geo_drv'], state);
    expect(src?.node.id).toBe('geo_sample');
    expect(src?.socket).toBe('out'); // wired to the point output
    expect(geometrySampleRefOf(src!.node)).toEqual({ geometry: 'geo_terrain', at: 'geo_null' });
    // A driver with nothing on inVec is not a geometry-sample source.
    expect(geometrySampleSourceOf(state.nodes['n_box'], state)).toBeNull();
  });

  it('carries the wired output socket (out=point vs normal)', () => {
    let state = buildTerrainState([0, 5, 0]);
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'geo_drv',
      nodeType: 'ParamDriver',
      params: { target: 'n_box', paramPath: 'rotation', blendMode: 'replace', order: 0 },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'geo_sample', socket: 'normal' },
      to: { node: 'geo_drv', socket: 'inVec' },
    }).next;
    expect(geometrySampleSourceOf(state.nodes['geo_drv'], state)?.socket).toBe('normal');
  });

  it('exposes the flat-terrain normal as up (the socket a tilt driver reads)', () => {
    const { sample } = readTerrainSampleAt(buildTerrainState([2, 10, 2]), REF, ctxAt(0));
    expect(sample).not.toBeNull();
    expect(sample!.normal[0]).toBeCloseTo(0, 3);
    expect(sample!.normal[1]).toBeCloseTo(1, 3);
    expect(sample!.normal[2]).toBeCloseTo(0, 3);
  });
});
