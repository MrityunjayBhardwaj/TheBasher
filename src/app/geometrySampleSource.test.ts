// geometrySampleSource — the driver-resolution seam for the SampleGeometry road.
// The pure ray-vs-mesh math is proven in rayMesh.test.ts; this proves the SEAM
// wiring: it materializes the terrain's world geometry (registry + world matrix) and
// samples the ground under a query Null. Mirrors resolveWorldTransform.test.ts's
// buildDefaultDagState + applyOp scaffold. The live boundary-pair (render == read) is
// observed in a throwaway e2e; this suite guards the resolution in CI.

import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyOp } from '../core/dag';
import * as geometryRegistry from './geometryRegistry';
import { resolveEvaluatedMesh } from './resolveEvaluatedMesh';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { __resetRegistryForTests } from '../core/dag';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitCube } from '../test-utils/splitCube';
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
  state = makeSplitCube(state, {
    objectId: 'geo_terrain',
    size: [20, 1, 20],
    position: [0, 2, 0],
    rotation: [0, 0, terrainRotZ],
  }).state;
  const ops: Op[] = [
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

/** The query Null + SampleGeometry of {@link buildTerrainState}, over an already-built terrain. */
function buildTerrainStateOver(
  base: DagState,
  terrainId: string,
  nullPos: [number, number, number],
): DagState {
  let state = base;
  const ops: Op[] = [
    {
      type: 'connect',
      from: { node: terrainId, socket: 'out' },
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
      params: { sourceGeometry: { node: terrainId }, at: { node: 'geo_null' } },
    },
  ];
  for (const op of ops) state = applyOp(state, op).next;
  return state;
}

// The full 6-field ref a default SampleGeometry node parses to (Ray-op defaults:
// project a straight-down ray, forward orientation, nearest surface). Kept in sync
// with geometrySampleRefOf's defaults — the assertion below pins them.
const REF = {
  geometry: 'geo_terrain',
  at: 'geo_null',
  method: 'project' as const,
  direction: [0, -1, 0] as [number, number, number],
  orientation: 'forward' as const,
  farthest: false,
};

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
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
  it('detects a SampleGeometry wired to a driver `in`, and parses its refs', () => {
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
      to: { node: 'geo_drv', socket: 'in' },
    }).next;

    const src = geometrySampleSourceOf(state.nodes['geo_drv'], state);
    expect(src?.node.id).toBe('geo_sample');
    expect(src?.socket).toBe('out'); // wired to the point output
    expect(geometrySampleRefOf(src!.node)).toEqual({
      geometry: 'geo_terrain',
      at: 'geo_null',
      method: 'project',
      direction: [0, -1, 0],
      orientation: 'forward',
      farthest: false,
    });
    // A driver with nothing on `in` is not a geometry-sample source.
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
      to: { node: 'geo_drv', socket: 'in' },
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

describe('#725 — the BVH cache invalidates on an index change, not only on positions', () => {
  // #1053 — this used a mounted glTF clone as the terrain, only because a clone handed the test a
  // geometry it could mutate. The clone is gone; the registry's box geometry is the same kind of
  // shared, mutable instance (every reader gets the one object), so the terrain is a box now.

  /** The registry's shared geometry for a box terrain — the instance the sampler reads. */
  function registryGeometryOf(state: DagState, objectId: string): THREE.BufferGeometry {
    const mesh = resolveEvaluatedMesh(state, objectId, ctxAt(0));
    return geometryRegistry.getForRead(mesh!.geometry)!;
  }

  /** The indices of the first three bottom-face vertices (local y = -0.5 → world y = 1.5). */
  function bottomTriangle(geo: THREE.BufferGeometry): number[] {
    const pos = geo.getAttribute('position');
    const bottom: number[] = [];
    for (let i = 0; i < pos.count && bottom.length < 3; i++) {
      if (Math.abs(pos.getY(i) - -0.5) < 1e-6) bottom.push(i);
    }
    return bottom;
  }

  it('an index replaced in place is a new topology, and the read follows it', () => {
    const st = buildTerrainState([4, 10, -3]);
    const geo = registryGeometryOf(st, 'geo_terrain');
    const indexBefore = geo.getIndex();
    try {
      // Prime the cache against the full box — the top face at world y = 2.5.
      expect(readTerrainSampleAt(st, REF, ctxAt(0)).point[1]).toBeCloseTo(2.5, 3);
      const positionsBefore = geo.getAttribute('position').array;

      // A discriminating replacement: one triangle of BOTTOM vertices only. If the stale
      // structure were reused the answer would still be 2.5.
      const bottom = bottomTriangle(geo);
      expect(bottom).toHaveLength(3);

      // THE ORACLE — the same index on ANOTHER box (a hair wider in X, so the registry keys it
      // apart; same height, same vertex order), so the expectation is measured rather than
      // asserted from the shape of the box.
      let oracleSt = buildDefaultDagState();
      oracleSt = makeSplitCube(oracleSt, {
        objectId: 'oracle',
        size: [20.001, 1, 20],
        position: [0, 2, 0],
      }).state;
      const oracleGeo = registryGeometryOf(oracleSt, 'oracle');
      expect(oracleGeo).not.toBe(geo);
      const oracleIndexBefore = oracleGeo.getIndex();
      oracleGeo.setIndex(bottomTriangle(oracleGeo));
      const oracleY = readTerrainSampleAt(
        buildTerrainStateOver(oracleSt, 'oracle', [4, 10, -3]),
        { ...REF, geometry: 'oracle' },
        ctxAt(0),
      ).point[1];
      oracleGeo.setIndex(oracleIndexBefore);
      expect(oracleY).toBeCloseTo(1.5, 3);

      // The in-place change, with the position array's identity deliberately preserved.
      geo.setIndex([...bottom]);
      expect(geo.getAttribute('position').array).toBe(positionsBefore);
      expect(readTerrainSampleAt(st, REF, ctxAt(0)).point[1]).toBeCloseTo(oracleY, 3);
    } finally {
      geo.setIndex(indexBefore);
    }
  });
});
