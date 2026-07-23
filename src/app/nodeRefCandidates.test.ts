// nodeRefCandidates — the general node-ref picker's candidate resolver. Proves the kind
// filter uses ground-truth signals (mesh-ness via resolveEvaluatedMesh; transformable via
// a position param), so the inspector picker offers only sensible targets. The live UI
// (the <select>s populate + filter) is observed in a throwaway e2e; this guards the logic.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { makeSplitCube } from '../test-utils/splitCube';
import { makeSplitCurve } from '../test-utils/splitCurve';
import { nodeRefCandidates } from './nodeRefCandidates';

const ctx = { time: { frame: 0, seconds: 0, normalized: 0 } };

/** Default scene (n_box mesh, n_camera, n_light) + a terrain mesh + a Null. */
function buildScene(): DagState {
  let state = buildDefaultDagState();
  state = makeSplitCube(state, {
    objectId: 'geo_terrain',
    size: [10, 1, 10],
    position: [0, 0, 0],
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
      params: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    {
      type: 'connect',
      from: { node: 'geo_null', socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    },
    { type: 'addNode', nodeId: 'geo_sample', nodeType: 'SampleGeometry', params: {} },
  ];
  for (const op of ops) state = applyOp(state, op).next;
  // #385 — a curve is an Object → CurveData (default 4-point path → curveSamplerFor resolves the
  // Object). The CurveData leaf evaluates to kind 'CurveData', not 'Object', so it is NOT a curve
  // candidate — only 'geo_curve' (the Object) qualifies.
  state = makeSplitCurve(state, { objectId: 'geo_curve' }).state;
  return state;
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('nodeRefCandidates', () => {
  it("'mesh' offers geometry producers (the boxes), never the Null / camera / light", () => {
    const ids = nodeRefCandidates(buildScene(), 'mesh', 'geo_sample', ctx).map((c) => c.id);
    expect(ids).toContain('geo_terrain');
    expect(ids).toContain('n_box'); // the default scene's mesh
    expect(ids).not.toContain('geo_null');
    expect(ids).not.toContain('n_camera');
    expect(ids).not.toContain('n_light');
  });

  it("'transformable' offers nodes with a position (Null, meshes, light, camera), not infra", () => {
    const ids = nodeRefCandidates(buildScene(), 'transformable', 'geo_sample', ctx).map(
      (c) => c.id,
    );
    expect(ids).toContain('geo_null');
    expect(ids).toContain('geo_terrain');
    expect(ids).not.toContain('n_scene'); // aggregator — no position
    expect(ids).not.toContain('n_time'); // TimeSource — no position
  });

  it("'curve' offers only Curves the sampler can consume, never a mesh / Null / camera", () => {
    // The ground-truth mirror of 'mesh': curveSamplerFor resolves, not merely type==='Curve'.
    const ids = nodeRefCandidates(buildScene(), 'curve', 'geo_sample', ctx).map((c) => c.id);
    expect(ids).toContain('geo_curve');
    expect(ids).not.toContain('geo_terrain');
    expect(ids).not.toContain('n_box');
    expect(ids).not.toContain('geo_null');
    expect(ids).not.toContain('n_camera');
  });

  it('excludes the querying node itself and sorts by label', () => {
    const cands = nodeRefCandidates(buildScene(), 'any', 'geo_sample', ctx);
    expect(cands.map((c) => c.id)).not.toContain('geo_sample');
    const labels = cands.map((c) => c.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });
});
